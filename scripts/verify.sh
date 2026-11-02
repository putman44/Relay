#!/usr/bin/env bash

set -Eeuo pipefail

readonly PGVECTOR_IMAGE="pgvector/pgvector:0.8.1-pg14"

for tool in docker node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Relay verification requires $tool." >&2
    exit 1
  fi
done

if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
  docker_context="$DOCKER_CONTEXT"
  docker_endpoint="$(env -u DOCKER_CONTEXT -u DOCKER_HOST \
    docker context inspect "$docker_context" --format '{{.Endpoints.docker.Host}}')" || {
    echo "Relay verification could not inspect the selected Docker context." >&2
    exit 1
  }
elif [[ -n "${DOCKER_HOST:-}" ]]; then
  docker_endpoint="$DOCKER_HOST"
else
  docker_context="$(env -u DOCKER_CONTEXT -u DOCKER_HOST docker context show)" || {
    echo "Relay verification could not determine the active Docker context." >&2
    exit 1
  }
  docker_endpoint="$(env -u DOCKER_CONTEXT -u DOCKER_HOST \
    docker context inspect "$docker_context" --format '{{.Endpoints.docker.Host}}')" || {
    echo "Relay verification could not inspect the active Docker context." >&2
    exit 1
  }
fi
if [[ ! "$docker_endpoint" == unix:///* ]]; then
  echo "Relay verification requires Docker through a local Unix socket; refused $docker_endpoint." >&2
  exit 1
fi
readonly docker_endpoint

docker_pinned() {
  env -u DOCKER_CONTEXT -u DOCKER_HOST docker --host "$docker_endpoint" "$@"
}

resource_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
database_password="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
ownership_nonce="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
readonly resource_id database_password ownership_nonce
readonly database_user="relay_verify_${resource_id//-/_}"
readonly container_name="relay-verify-${resource_id}"
readonly volume_name="relay-verify-${resource_id}"

docker_not_found() {
  local kind="$1"
  local name="$2"
  local output="$3"
  while [[ "$output" == $'\n'* ]]; do
    output="${output#$'\n'}"
  done
  if [[ "$kind" == container ]]; then
    [[ "$output" == "Error response from daemon: No such container: $name" \
      || "$output" == "Error: No such container: $name" ]]
  else
    [[ "$output" == "Error response from daemon: get $name: no such volume" \
      || "$output" == "Error response from daemon: No such volume: $name" \
      || "$output" == "Error: No such volume: $name" ]]
  fi
}

remove_resource() {
  local kind="$1"
  local name="$2"
  local output
  if [[ "$kind" == container ]]; then
    if output="$(docker_pinned container rm --force "$name" 2>&1)"; then
      return 0
    fi
  elif output="$(docker_pinned volume rm "$name" 2>&1)"; then
    return 0
  fi
  if docker_not_found "$kind" "$name" "$output"; then
    return 0
  fi
  echo "Relay verification could not remove $kind $name: $output" >&2
  return 1
}

verify_resource_absent() {
  local kind="$1"
  local name="$2"
  local format output
  if [[ "$kind" == container ]]; then
    format='{{.Id}}'
  else
    format='{{.Name}}'
  fi
  if output="$(docker_pinned "$kind" inspect --format "$format" "$name" 2>&1)"; then
    echo "Relay verification could not verify $kind absence; $name still exists." >&2
    return 1
  fi
  if docker_not_found "$kind" "$name" "$output"; then
    return 0
  fi
  echo "Relay verification could not verify $kind absence for $name: $output" >&2
  return 1
}

cleanup() {
  local verification_status=$?
  local cleanup_status=0

  trap - EXIT INT TERM
  set +e

  if ! docker_pinned info >/dev/null 2>&1; then
    echo "Relay verification could not reach the pinned Docker endpoint to perform cleanup." >&2
    cleanup_status=1
  fi
  remove_resource container "$container_name" || cleanup_status=1
  verify_resource_absent container "$container_name" || cleanup_status=1
  remove_resource volume "$volume_name" || cleanup_status=1
  verify_resource_absent volume "$volume_name" || cleanup_status=1

  if (( cleanup_status != 0 )); then
    echo "Relay verification cleanup failed." >&2
    if (( verification_status == 0 )); then
      exit 1
    fi
  fi
  exit "$verification_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! docker_pinned info >/dev/null 2>&1; then
  echo "Relay verification requires a running daemon at the pinned local Docker endpoint." >&2
  exit 1
fi

docker_pinned run --detach \
  --name "$container_name" \
  --mount "type=volume,source=${volume_name},target=/var/lib/postgresql/data" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_DB=relay_test \
  --env POSTGRES_USER="$database_user" \
  --env POSTGRES_PASSWORD="$database_password" \
  "$PGVECTOR_IMAGE" postgres -c "relay.verification_nonce=$ownership_nonce" >/dev/null

port_binding="$(docker_pinned port "$container_name" 5432/tcp)"
if [[ ! "$port_binding" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then
  echo "Relay verification refused unexpected PostgreSQL binding: $port_binding" >&2
  exit 1
fi
readonly postgres_port="${BASH_REMATCH[1]}"
readonly database_url="postgresql://${database_user}:${database_password}@127.0.0.1:${postgres_port}/relay_test"

database_ready=false
for _ in {1..60}; do
  if docker_pinned exec "$container_name" pg_isready --username "$database_user" --dbname relay_test >/dev/null 2>&1; then
    database_ready=true
    break
  fi
  sleep 1
done
if [[ "$database_ready" != true ]]; then
  echo "Disposable relay_test database did not become ready." >&2
  docker_pinned logs "$container_name" >&2 || true
  exit 1
fi

run_guarded() {
  env \
    DOTENV_PATH=/dev/null \
    DOTENV_ENCODING=utf8 \
    DOTENV_QUIET=true \
    DOTENV_DEBUG=false \
    DOTENV_OVERRIDE=false \
    DOTENV_FAST=false \
    DOTENV_CONFIG_PATH=/dev/null \
    DOTENV_CONFIG_ENCODING=utf8 \
    DOTENV_CONFIG_QUIET=true \
    DOTENV_CONFIG_DEBUG=false \
    DOTENV_CONFIG_OVERRIDE=false \
    DOTENV_CONFIG_FAST=false \
    RELAY_TEST_DATABASE_DISPOSABLE=true \
    RELAY_VERIFY_DATABASE_USER="$database_user" \
    RELAY_VERIFY_OWNERSHIP_NONCE="$ownership_nonce" \
    DATABASE_URL="$database_url" \
    RELAY_DRAFT_TEST_DATABASE_URL="$database_url" \
    "$@"
}

run_guarded node --import tsx scripts/check-test-database.ts
run_guarded node --import tsx scripts/check-verification-database.ts

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
