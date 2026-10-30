#!/usr/bin/env bash
# Jarvis — Kuantum Cam geliştirme (dev) sunucusu.
#
# Kullanım:
#   ./jarvis-dev.sh          -> http://localhost:5174/
#   ./jarvis-dev.sh 5180     -> http://localhost:5180/
#
# Port 8080 bu makinede llm-agent systemd servisi tarafından kullanıldığı için
# varsayılan port 5174'tür. --strictPort: port doluysa sessizce başka porta
# kaymaz, açıkça hata verir.
set -euo pipefail

cd "$(dirname "$0")"

# VSCode terminalinde tanımlı; bu betikte doğrudan etkisi yok ancak alt
# süreçlere sızmasın diye temizlenir.
unset ELECTRON_RUN_AS_NODE || true

PORT="${1:-5174}"

echo "Jarvis — Kuantum Cam dev sunucusu"
echo "Adres        : http://localhost:${PORT}/"
echo "Durdurmak için: Ctrl+C"

exec npx vite dev --port "$PORT" --strictPort
