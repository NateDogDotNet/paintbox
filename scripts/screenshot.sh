#!/usr/bin/env bash
# scripts/screenshot.sh
# Re-runnable: produces a fresh images/screenshot.png from miniPaint UI.
# Usage: bash scripts/screenshot.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node scripts/screenshot.mjs
