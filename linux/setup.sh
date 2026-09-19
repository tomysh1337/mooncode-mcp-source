#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_ROOT"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<12))throw Error("Node.js 22.12+ required")'
npm install --omit=dev --no-audit --no-fund
export PLAYWRIGHT_BROWSERS_PATH="$APP_ROOT/browsers"
node node_modules/playwright/cli.js install chromium
printf '%s\n' 'Ready. Run: bash start.sh serve --workspace /path/to/project'
