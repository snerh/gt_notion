#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Локальная проверка приложения (до коммита/деплоя).

Использование:
  ./run_local.sh dev       # Vite dev-сервер (быстро, для разработки)
  ./run_local.sh preview   # Cloudflare Workers runtime через wrangler dev (как в Cloudflare)
  ./run_local.sh build     # Только сборка
  ./run_local.sh lint      # ESLint

Подсказка:
  Если зависимости ещё не установлены, скрипт сам выполнит npm ci (или npm install).
EOF
}

cmd="${1:-}"
if [[ -z "${cmd}" || "${cmd}" == "-h" || "${cmd}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -d node_modules ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

case "${cmd}" in
  dev)
    npm run dev
    ;;
  preview)
    npm run preview
    ;;
  build)
    npm run build
    ;;
  lint)
    npm run lint
    ;;
  *)
    echo "Неизвестная команда: ${cmd}" >&2
    echo >&2
    usage >&2
    exit 2
    ;;
esac

