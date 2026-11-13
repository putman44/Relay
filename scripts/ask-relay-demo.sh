#!/usr/bin/env bash
# Ask Relay demo: a persistent, loopback-only pgvector database seeded from the
# saved Firecrawl captures in evals/fixtures/. See docs/Ask_Relay_Demo.md.
#
#   up                                   start, migrate (first run), and seed
#   status                               documents, chunks, and stored vectors
#   preview [SITE]                       chunk counts; no OpenAI calls
#   index --confirm-embeddings           embed every demo site (paid OpenAI)
#   ask SITE --confirm-openai "QUESTION" answer from SITE's research (paid OpenAI)
#   ui                                   browser UI at http://127.0.0.1:4311/
#   dashboard                            unified intake and Ask Relay demo at http://127.0.0.1:4310/
#                                        (each question asked there is paid OpenAI)
#   down                                 remove the demo container and volume
#   reset                                down, then up
#
# Every command pins DATABASE_URL to the demo container, so .env can never
# redirect it to another database.

set -Eeuo pipefail

readonly IMAGE="pgvector/pgvector:0.8.1-pg14"
readonly CONTAINER="relay-ask-demo"
readonly VOLUME="relay-ask-demo-data"
readonly PURPOSE="ask-relay-demo"
readonly DB="relay_demo"
readonly SITES=(hvac counseling relay)

cd "$(dirname "$0")/.."
# .env still supplies OPENAI_API_KEY and RELAY_RESEARCH_MODEL; this only
# silences dotenv's startup banner.
export DOTENV_CONFIG_QUIET=true

fail() {
  echo "$*" >&2
  exit 1
}

require_local_docker() {
  local endpoint="${DOCKER_HOST:-}"
  if [[ -z "$endpoint" ]]; then
    endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')" ||
      fail "Could not inspect the active Docker context."
  fi
  # The published 127.0.0.1 port is only this machine's when the daemon is.
  [[ "$endpoint" == unix:///* ]] ||
    fail "The demo requires a local Docker daemon; refused $endpoint."
  docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker Desktop first."
}

container_exists() {
  docker container inspect "$CONTAINER" >/dev/null 2>&1
}

require_owned_container() {
  local purpose
  purpose="$(docker container inspect --format '{{index .Config.Labels "relay.purpose"}}' "$CONTAINER")"
  [[ "$purpose" == "$PURPOSE" ]] ||
    fail "Container $CONTAINER is not the Ask Relay demo; refusing to touch it."
}

require_running() {
  container_exists || fail "The demo database does not exist. Run: $0 up"
  require_owned_container
  [[ "$(docker container inspect --format '{{.State.Running}}' "$CONTAINER")" == true ]] ||
    fail "The demo database is stopped. Run: $0 up"
}

database_url() {
  local binding
  binding="$(docker port "$CONTAINER" 5432/tcp | head -n 1)"
  [[ "$binding" =~ ^127\.0\.0\.1:([0-9]+)$ ]] ||
    fail "Refused unexpected demo database binding: $binding"
  echo "postgresql://relay_demo:relay_demo@127.0.0.1:${BASH_REMATCH[1]}/$DB"
}

pinned() {
  local url
  url="$(database_url)"
  DATABASE_URL="$url" "$@"
}

sql() {
  docker exec "$CONTAINER" psql -U relay_demo -d "$DB" -v ON_ERROR_STOP=1 "$@"
}

site_prospect() {
  case " ${SITES[*]} " in
    *" $1 "*) ;;
    *) fail "Unknown site: $1 (use one of: ${SITES[*]})" ;;
  esac
  node --import tsx scripts/seed-ask-relay-demo.ts id "$1"
}

up() {
  if container_exists; then
    require_owned_container
    docker start "$CONTAINER" >/dev/null
  else
    docker run --detach \
      --name "$CONTAINER" \
      --label "relay.purpose=$PURPOSE" \
      --mount "type=volume,source=$VOLUME,target=/var/lib/postgresql/data" \
      --publish 127.0.0.1::5432 \
      --env POSTGRES_DB="$DB" \
      --env POSTGRES_USER=relay_demo \
      --env POSTGRES_PASSWORD=relay_demo \
      "$IMAGE" >/dev/null
  fi

  # TCP readiness: the image's temporary initialization server is socket-only.
  local ready=false
  for _ in {1..60}; do
    if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U relay_demo -d "$DB" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  [[ "$ready" == true ]] || fail "The demo database did not become ready."

  if [[ "$(sql -tAc "SELECT to_regclass('public.prospects') IS NULL")" == t ]]; then
    for migration in migrations/*.sql; do
      pinned node --import tsx scripts/run-migration.ts "$migration"
    done
  fi
  [[ "$(sql -tAc "SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'research_chunks' AND column_name = 'embedding_model'")" == 1 ]] ||
    fail "The demo database predates migration 015. Run: $0 reset"

  pinned node --import tsx scripts/seed-ask-relay-demo.ts seed
}

status() {
  sql -c "SELECT p.company_name, p.id AS prospect_id,
      count(DISTINCT d.id) AS documents, count(c.id) AS chunks,
      count(c.embedding) AS embedded,
      max(vector_dims(c.embedding)) AS dimensions,
      max(c.embedding_model) AS model
    FROM prospects p
    LEFT JOIN research_documents d ON d.prospect_id = p.id
    LEFT JOIN research_chunks c ON c.research_document_id = d.id
    GROUP BY p.id, p.company_name ORDER BY p.id"
}

down() {
  if container_exists; then
    require_owned_container
    docker container rm --force "$CONTAINER" >/dev/null
  fi
  if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    docker volume rm "$VOLUME" >/dev/null
  fi
  echo "Removed the Ask Relay demo database."
}

command="${1:-}"
[[ -n "$command" ]] || fail "Usage: $0 up|status|preview|index|ask|ui|dashboard|down|reset (see header)."
shift
require_local_docker

case "$command" in
  up) up ;;
  status)
    require_running
    status
    ;;
  preview)
    require_running
    for site in "${@:-${SITES[@]}}"; do
      echo "== $site"
      prospect="$(site_prospect "$site")"
      pinned node --import tsx scripts/ask-relay.ts preview --prospect "$prospect"
    done
    ;;
  index)
    [[ $# -eq 1 && "$1" == --confirm-embeddings ]] ||
      fail "Indexing calls OpenAI embeddings. Run: $0 index --confirm-embeddings"
    require_running
    for site in "${SITES[@]}"; do
      echo "== $site"
      prospect="$(site_prospect "$site")"
      pinned node --import tsx scripts/ask-relay.ts index \
        --prospect "$prospect" --confirm-embeddings
    done
    ;;
  ask)
    [[ $# -eq 3 && "$2" == --confirm-openai ]] ||
      fail "Run: $0 ask SITE --confirm-openai \"QUESTION\" (SITE: ${SITES[*]})"
    require_running
    prospect="$(site_prospect "$1")"
    pinned node --import tsx scripts/ask-relay.ts ask \
      --prospect "$prospect" --confirm-openai "$3"
    ;;
  ui)
    [[ $# -eq 0 ]] || fail "Run: $0 ui (set RELAY_ASK_UI_PORT to change the port)"
    require_running
    pinned node --import tsx scripts/run-ask-relay-ui.ts
    ;;
  dashboard)
    [[ $# -eq 0 ]] || fail "Run: $0 dashboard"
    require_running
    pinned node --import tsx scripts/run-prospect-dashboard.ts
    ;;
  down) down ;;
  reset)
    down
    up
    ;;
  *) fail "Unknown command: $command" ;;
esac
