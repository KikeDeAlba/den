#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BITA_MEASURE_PORT:-8731}"

if [ ! -f "$ROOT/dist/index.html" ]; then
  echo "no hay dist/; corre pnpm build primero" >&2
  exit 1
fi

python3 -m http.server "$PORT" --directory "$ROOT/dist" >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/index.html" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

BITA_MEASURE_PORT="$PORT" swift "$ROOT/scripts/measure-shell.swift"
