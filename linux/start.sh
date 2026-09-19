#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$APP_ROOT/bin/node" ]]; then
  MOONCODE_NODE="$APP_ROOT/bin/node"
else
  MOONCODE_NODE="$(command -v node)"
fi
if [[ -d "$APP_ROOT/browsers" ]]; then export PLAYWRIGHT_BROWSERS_PATH="$APP_ROOT/browsers"; fi
exec "$MOONCODE_NODE" "$APP_ROOT/hub/cli.mjs" "$@"
