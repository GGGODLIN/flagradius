#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

case "${1:-}" in
  --seeded)
    exec node --import tsx src/demo.ts
    ;;
  --demo|'') ;;
  *) printf '%s\n' 'Usage: bash scripts/run-live-e2e.sh [--demo]' >&2; exit 2 ;;
esac

report_root="$PWD/e2e-report"
if [[ "${1:-}" == --demo ]]; then
  if [[ "${FLAGRADIUS_DEMO_APPROVAL:-human}" != scripted ]] && ! ( : > /dev/tty ) 2>/dev/null; then
    printf '%s\n' 'An interactive terminal is required. Use make test-live-e2e for scripted verification.' >&2
    exit 1
  fi
  report_root="$report_root/demo"
fi
mkdir -p "$report_root"
exec > >(tee "$report_root/gate.log") 2>&1
export COMPOSE_FILE="$PWD/docker/docker-compose.yml"
export COMPOSE_PROJECT_NAME="flagradius-demo-$$"
export COMPOSE_DISABLE_ENV_FILE=1
export SANDBOX_DB_PASSWORD SANDBOX_DJANGO_SECRET SANDBOX_HOME
SANDBOX_DB_PASSWORD="$(openssl rand -hex 24)"
SANDBOX_DJANGO_SECRET="$(openssl rand -hex 32)"
SANDBOX_HOME="$(mktemp -d)"
unset FLAGSMITH_API_TOKEN COMPOSE_ENV_FILES
child=''

compose() {
  docker compose --env-file /dev/null "$@"
}

cleanup() {
  local status=$? remaining=''
  trap - EXIT
  trap '' INT TERM
  if [[ -n "$child" ]]; then
    kill -TERM -- "-$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  if ! compose down -v --remove-orphans; then
    printf '%s\n' 'Compose teardown failed.' >&2
    status=1
  fi
  if remaining="$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" && [[ -z "$remaining" ]]; then
    printf '%s\n' '{"mode":"LIVE_FLAGSMITH","stage":"compose_teardown","orphanContainers":0}'
  else
    printf '%s\n' 'Unable to verify zero remaining Compose containers.' >&2
    status=1
  fi
  rm -rf -- "$SANDBOX_HOME"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]]; then
  printf '%s\n' 'FlagRadius requires Node.js 24 or later.' >&2
  exit 1
fi
if [[ ! -x node_modules/.bin/flagsmith || ! -x node_modules/.bin/vitest || ! -x node_modules/.bin/tsx ]]; then
  npm ci --include=dev --ignore-scripts --no-audit --no-fund
fi
./node_modules/.bin/flagsmith --version | tee "$report_root/flagsmith-version.txt"
command grep -Eq '(^|[[:space:]])v?2\.0\.0([[:space:]]|$)' "$report_root/flagsmith-version.txt"
if ! compose up -d --wait --wait-timeout 240; then
  printf '%s\n' 'Flagsmith Compose startup failed.' >&2
  exit 1
fi
published="$(compose port flagsmith 8000)"
export SANDBOX_ORIGIN="http://$published"

seed() {
  local phase="$1"
  export SANDBOX_TOKEN_FILE="$SANDBOX_HOME/$phase.token"
  export FLAGRADIUS_DEMO_SEED_FILE="$SANDBOX_HOME/$phase.seed.json"
  export FLAGRADIUS_DEMO_STATE_DIR="$SANDBOX_HOME/$phase.state"
  ./node_modules/.bin/tsx scripts/seed-sandbox.ts
}

run_child() {
  local status=0
  # npm and Vitest spawn children, so interrupt the process group during teardown.
  set -m
  "$@" &
  child=$!
  wait "$child" || status=$?
  if kill -0 -- "-$child" 2>/dev/null; then
    printf '%s\n' 'The demo process group still has running children.' >&2
    return 1
  fi
  child=''
  set +m
  return "$status"
}

if [[ "${1:-}" == --demo ]]; then
  seed demo
  export FLAGRADIUS_DEMO_REPORT_DIR="$report_root"
  run_child node --import tsx src/demo.ts
else
  export FLAGRADIUS_DEMO_APPROVAL=scripted
  seed vitest
  export FLAGRADIUS_DEMO_REPORT_DIR="$report_root/vitest"
  FLAGRADIUS_LIVE_E2E=1 run_child npx --no-install vitest run tests/live-e2e.test.ts --reporter=verbose
  seed cli
  export FLAGRADIUS_DEMO_REPORT_DIR="$report_root/cli"
  run_child npm run demo -- --seeded
fi
