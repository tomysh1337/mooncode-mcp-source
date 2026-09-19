#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MOONCODE_NODE="$(command -v node || true)"
if [[ -x "$APP_ROOT/bin/node" ]]; then MOONCODE_NODE="$APP_ROOT/bin/node"; fi
if [[ -z "$MOONCODE_NODE" ]]; then echo 'Node.js 22.12+ is required; run setup.sh first.' >&2; exit 1; fi
if [[ -d "$APP_ROOT/browsers" ]]; then export PLAYWRIGHT_BROWSERS_PATH="$APP_ROOT/browsers"; fi
exec "$MOONCODE_NODE" "$APP_ROOT/hub/web.mjs" "$@"
