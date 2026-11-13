#!/usr/bin/env bash
# Persistent local dashboard database. Initialization copies saved demo data once.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

readonly CONTAINER=relay-local-dev
readonly VOLUME=relay-local-dev-data
readonly DB=relay_dev
readonly USER=relay_dev
readonly IMAGE=pgvector/pgvector:0.8.1-pg14
readonly PURPOSE=relay-local-development
readonly DEMO=relay-ask-demo
fail() { echo "Relay dev: $*" >&2; exit 1; }

endpoint="${DOCKER_HOST:-}"
if [[ -z "$endpoint" ]]; then
  endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')" || fail "Cannot inspect Docker context."
fi
[[ "$endpoint" == unix:///* ]] || fail "A local Unix Docker daemon is required."
export DOCKER_HOST="$endpoint"
docker info >/dev/null 2>&1 || fail "Docker is unavailable. Start Docker Desktop."

exists() { docker container inspect "$CONTAINER" >/dev/null 2>&1; }
owned() {
  [[ "$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "relay.purpose"}}')" == "$PURPOSE" ]] || fail "Container identity mismatch: $CONTAINER"
  [[ "$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')" == "$VOLUME" ]] || fail "Development volume identity mismatch."
}
running() {
  exists || fail "Development database is absent. Run npm run dev:init first."
  owned
  [[ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}')" == true ]] || fail "Development database is stopped. Run npm run dev:init to start it."
}
dburl() {
  local binding
  binding="$(docker port "$CONTAINER" 5432/tcp)"
  [[ "$binding" =~ ^127\.0\.0\.1:([0-9]+)$ ]] || fail "Unsafe database port binding: $binding"
  echo "postgresql://relay_dev:relay_dev@127.0.0.1:${BASH_REMATCH[1]}/$DB"
}
sql() { docker exec "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$USER" -d "$DB" -A -t -c "$1"; }
ready() {
  local ok=false
  for _ in {1..60}; do
    if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U "$USER" -d "$DB" >/dev/null 2>&1; then ok=true; break; fi
    sleep 1
  done
  [[ "$ok" == true ]] || fail "Development PostgreSQL did not become ready."
}
schema_ready() {
  [[ "$(sql "SELECT to_regclass('public.lead_intake_assessments') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prospect_research_requests' AND column_name='website_index_status')")" == t ]] || fail "Development schema is incomplete. Inspect it before retrying initialization."
}

case "${1:-}" in
  init)
    if exists; then
      owned
      docker start "$CONTAINER" >/dev/null
      ready
      schema_ready
      echo "Relay dev database already initialized; existing data preserved."
      exit 0
    fi
    docker volume inspect "$VOLUME" >/dev/null 2>&1 && fail "Unattached development volume exists; refusing to overwrite or adopt it."
    [[ "$(docker inspect "$DEMO" --format '{{index .Config.Labels "relay.purpose"}}' 2>/dev/null)" == ask-relay-demo ]] || fail "Verified Ask Relay demo source is unavailable."
    [[ "$(docker inspect "$DEMO" --format '{{.State.Running}}')" == true ]] || fail "Start the demo database first with scripts/ask-relay-demo.sh up."
    docker run --detach --name "$CONTAINER" --label "relay.purpose=$PURPOSE" \
      --mount "type=volume,source=$VOLUME,target=/var/lib/postgresql/data" \
      --publish 127.0.0.1::5432 --env POSTGRES_DB="$DB" --env POSTGRES_USER="$USER" \
      --env POSTGRES_PASSWORD=relay_dev "$IMAGE" >/dev/null
    running
    ready
    [[ "$(sql "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")" == 0 ]] || fail "Development database is not empty; refusing import."
    echo "Copying the saved demo schema, Sadowski research, and vectors into relay_dev..."
    docker exec "$DEMO" pg_dump -U relay_demo -d relay_demo --format=custom --no-owner --no-acl |
      docker exec -i "$CONTAINER" pg_restore -U "$USER" -d "$DB" --no-owner --no-acl --exit-on-error
    [[ "$(sql "SELECT current_database()")" == "$DB" ]] || fail "Development database identity changed."
    if [[ "$(sql "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prospect_research_requests' AND column_name='website_index_status')")" == f ]]; then
      docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$USER" -d "$DB" < migrations/016_add_website_index_status.sql
    fi
    if [[ "$(sql "SELECT to_regclass('public.lead_intake_assessments') IS NULL")" == t ]]; then
      docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$USER" -d "$DB" < migrations/017_create_lead_intake_assessments.sql
    fi
    schema_ready
    echo "Relay dev database ready. Data persists across restarts."
    ;;
  status)
    running
    ready
    schema_ready
    echo "Development database: $(dburl)"
    sql "SELECT count(*) AS embedded_chunks FROM research_chunks WHERE embedding IS NOT NULL"
    ;;
  serve)
    running
    ready
    schema_ready
    echo "Relay dashboard: http://127.0.0.1:${RELAY_INTAKE_UI_PORT:-4310}/"
    echo "Watching development sources. Press Ctrl+C to stop; database data persists."
    export DATABASE_URL="$(dburl)" RELAY_DASHBOARD_DATABASE="$DB" DOTENV_CONFIG_QUIET=true
    exec node --watch --watch-preserve-output --import tsx scripts/run-prospect-dashboard.ts
    ;;
  *) fail "Use npm run dev:init, npm run dev:status, or npm run dev." ;;
esac
