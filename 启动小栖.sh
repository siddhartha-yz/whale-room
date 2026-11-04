#!/usr/bin/env bash
set -euo pipefail
# Compatibility entry point for existing shortcuts.
exec "$(dirname -- "${BASH_SOURCE[0]}")/启动鲸鱼娘.sh" "$@"
