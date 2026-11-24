#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p parity-report
exec > >(tee parity-report/gate.log) 2>&1
export COMPOSE_FILE="$PWD/docker/docker-compose.yml"
export COMPOSE_PROJECT_NAME="flagradius-parity-$$"
export SANDBOX_DB_PASSWORD="$(openssl rand -hex 24)"
export SANDBOX_DJANGO_SECRET="$(openssl rand -hex 32)"
export SANDBOX_HOME
SANDBOX_HOME="$(mktemp -d)"
export SANDBOX_TOKEN_FILE="$SANDBOX_HOME/admin-token"
cleanup() {
  local code=$?
  trap - EXIT
  unset FLAGSMITH_API_TOKEN
  rm -f parity-report/sandbox.json
  rm -rf "$SANDBOX_HOME"
  if ! docker compose down -v --remove-orphans; then
    printf '%s\n' 'Compose teardown failed.' >&2
    if [ "$code" -eq 0 ]; then code=1; fi
  fi
  exit "$code"
}
trap cleanup EXIT
node --version
if [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]; then
  printf '%s\n' 'Ticket 01 requires Node.js 24 or later.' >&2
  exit 1
fi
if [ -f package-lock.json ]; then
  npm ci --ignore-scripts --no-audit --no-fund
else
  npm install --ignore-scripts --no-audit --no-fund
  cp package-lock.json parity-report/npm-lock.json
fi
./node_modules/.bin/flagsmith --version | tee parity-report/flagsmith-version.txt
command grep -Eq '(^|[[:space:]])v?2\.0\.0([[:space:]]|$)' parity-report/flagsmith-version.txt
npm run typecheck | tee parity-report/typecheck.txt
RUN_LIVE_FLAGSMITH=0 npm test -- --reporter=verbose | tee parity-report/offline-vitest.txt
if ! docker compose up -d --wait --wait-timeout 240; then
  docker compose logs --no-color migrate-db flagsmith > parity-report/compose-boot.log 2>&1
  exit 1
fi
published="$(docker compose port flagsmith 8000)"
export SANDBOX_ORIGIN="http://$published"
./node_modules/.bin/tsx scripts/seed-sandbox.ts | tee parity-report/seed.txt
export FLAGSMITH_API_TOKEN
FLAGSMITH_API_TOKEN="$(< "$SANDBOX_TOKEN_FILE")"
RUN_LIVE_FLAGSMITH=1 npm test -- tests/live-parity.test.ts --reporter=verbose | tee parity-report/live-vitest.txt
