#!/bin/bash
# Restore the portable pi-agent configuration from this checkout.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
exec node "$SCRIPT_DIR/scripts/setup.mjs" --source "$SCRIPT_DIR" "$@"
