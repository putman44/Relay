#!/usr/bin/env bash

set -Eeuo pipefail

readonly PGVECTOR_IMAGE="pgvector/pgvector:0.8.1-pg14"
readonly POSTGRES_PASSWORD="relay_verify_only"

for tool in docker node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Relay verification requires $tool." >&2
    exit 1
  fi
done

if ! docker info >/dev/null 2>&1; then
  echo "Relay verification requires a running Docker daemon." >&2
  exit 1
fi

resource_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
readonly container_name="relay-verify-${resource_id}"
readonly volume_name="relay-verify-${resource_id}"

cleanup() {
  local verification_status=$?
  local cleanup_status=0

  trap - EXIT INT TERM
  set +e

  if ! docker info >/dev/null 2>&1; then
    echo "Relay verification could not reach Docker to verify cleanup." >&2
    cleanup_status=1
  fi

  if docker container inspect "$container_name" >/dev/null 2>&1; then
    docker container rm --force "$container_name" >/dev/null || cleanup_status=1
  fi
  if docker container inspect "$container_name" >/dev/null 2>&1; then
    echo "Relay verification could not remove container $container_name." >&2
    cleanup_status=1
  fi

  if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    docker volume rm "$volume_name" >/dev/null || cleanup_status=1
  fi
  if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    echo "Relay verification could not remove volume $volume_name." >&2
    cleanup_status=1
  fi

  if (( cleanup_status != 0 )); then
    exit 1
  fi
  exit "$verification_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker run --detach \
  --name "$container_name" \
  --mount "type=volume,source=${volume_name},target=/var/lib/postgresql/data" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_DB=relay_test \
  --env POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  "$PGVECTOR_IMAGE" >/dev/null

port_binding="$(docker port "$container_name" 5432/tcp)"
if [[ ! "$port_binding" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then
  echo "Relay verification refused unexpected PostgreSQL binding: $port_binding" >&2
  exit 1
fi
readonly postgres_port="${BASH_REMATCH[1]}"
readonly database_url="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${postgres_port}/relay_test"

database_ready=false
for _ in {1..60}; do
  if docker exec "$container_name" pg_isready --username postgres --dbname relay_test >/dev/null 2>&1; then
    database_ready=true
    break
  fi
  sleep 1
done
if [[ "$database_ready" != true ]]; then
  echo "Disposable relay_test database did not become ready." >&2
  docker logs "$container_name" >&2 || true
  exit 1
fi

run_guarded() {
  env \
    DOTENV_CONFIG_PATH=/dev/null \
    RELAY_TEST_DATABASE_DISPOSABLE=true \
    DATABASE_URL="$database_url" \
    RELAY_DRAFT_TEST_DATABASE_URL="$database_url" \
    "$@"
}

run_guarded node --import tsx scripts/check-test-database.ts

migration_files=(migrations/*.sql)
if (( ${#migration_files[@]} == 0 )); then
  echo "Relay verification found no migrations." >&2
  exit 1
fi
for migration_file in "${migration_files[@]}"; do
  run_guarded node --import tsx scripts/run-migration.ts "$migration_file"
done

run_guarded npm run typecheck
run_guarded npm test
