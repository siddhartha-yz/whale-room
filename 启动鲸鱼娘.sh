#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo '需要 Node.js 22.12 或更新版本和 npm。'
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<12)){console.error("需要 Node.js 22.12 或更新版本。");process.exit(1);}'
if [[ "${COMPANION_OFFLINE:-0}" != 1 ]] && ! command -v codex >/dev/null; then
  echo '未安装 Codex CLI，仍可使用本地场景；聊天需另行安装并登录。'
fi
if [[ ! -d node_modules ]]; then npm ci; fi
npm run build
printf '\n打开 http://127.0.0.1:%s 。按 Ctrl+C 停止服务。\n\n' "${PORT:-4317}"
exec npm start
