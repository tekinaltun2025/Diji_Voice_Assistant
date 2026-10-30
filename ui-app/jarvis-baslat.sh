#!/usr/bin/env bash
# Jarvis — Kuantum Cam masaüstü başlatıcı (TEK KOMUT).
#
#   ./jarvis-baslat.sh
#
# Ne yapar (sırayla):
#   1. Proje köküne geçer (betik nereden çağrılırsa çağrılsın).
#   2. VSCode tümleşik terminalinde tanımlı ELECTRON_RUN_AS_NODE değişkenini kaldırır
#      (bu değişken Electron'u Node gibi davranmaya zorlar ve pencere açılmaz).
#   3. Diji ajanını (127.0.0.1:8899) gerekirse başlatır ve hazır olmasını bekler.
#      Ajan zaten çalışıyorsa DOKUNMAZ (ikinci süreç mikrofon için yarışır).
#   4. SPA derlemesini denetler; yoksa üretir ve göreli varlık yollarını hazırlar.
#   5. Electron'u yalnızca --no-sandbox bayrağıyla başlatır.
#
# Ortam değişkenleri (isteğe bağlı):
#   DIJI_HOME        Ajan projesinin kökü (varsayılan: ~/Documents/Jarvis_V1)
#   DIJI_CONTROL_PORT Kontrol sunucusu portu (varsayılan: 8899)
#   DIJI_TTS_ENABLED  1 = yanıtlar seslendirilir, 0 = yalnızca panel
#   DIJI_CDP_PORT    Verilirse DevTools uzaktan hata ayıklama açılır (örn. 9333).
#                    Yalnızca tanılama/otomasyon içindir; normal kullanımda boş bırakın.
#
# Bilinçli olarak KULLANILMAYAN bayraklar:
#   --disable-gpu                 -> bu oturumda exitCode 133 ile çöktü
#   --ozone-platform-hint / --enable-features=UseOzonePlatform
#                                 -> "GPU process isn't usable. Goodbye." hatası
#   --disable-dev-shm-usage       -> shm döngüsü kaydı var
set -euo pipefail

cd "$(dirname "$0")"
APP_ROOT="$(pwd)"
DIJI_HOME="${DIJI_HOME:-$HOME/Documents/Jarvis_V1}"
PORT="${DIJI_CONTROL_PORT:-8899}"
AGENT_LOG="/tmp/diji-agent-ui.log"

# VSCode terminalinde ELECTRON_RUN_AS_NODE=1 tanımlıdır; Electron'u bozar.
unset ELECTRON_RUN_AS_NODE || true

echo "Jarvis — Kuantum Cam başlatıcı"
echo "Arayüz dizini : $APP_ROOT"
echo "Ajan dizini   : $DIJI_HOME"
echo "Kontrol portu : $PORT"

# --- 1) Ajan denetimi / başlatma ------------------------------------------
agent_healthy() {
  curl -sf -m 2 "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1
}

if agent_healthy; then
  echo "· Ajan zaten çalışıyor ($PORT) — yeniden başlatılmadı."
else
  if [ ! -f "$DIJI_HOME/agent/dist/index.js" ]; then
    echo "HATA: $DIJI_HOME/agent/dist/index.js bulunamadı." >&2
    echo "Çözüm: (cd '$DIJI_HOME' && npx tsc -b --force) çalıştırın." >&2
    exit 1
  fi
  echo "· Ajan başlatılıyor… (günlük: $AGENT_LOG)"
  (
    cd "$DIJI_HOME"
    # ELECTRON_RUN_AS_NODE alt süreçlere sızmasın; setsid ile terminalden kopar.
    exec setsid env -u ELECTRON_RUN_AS_NODE node agent/dist/index.js
  ) > "$AGENT_LOG" 2>&1 < /dev/null &

  echo "· Ajanın hazır olması bekleniyor (en çok 60 sn)…"
  for _ in $(seq 1 60); do
    if agent_healthy; then break; fi
    sleep 1
  done

  if ! agent_healthy; then
    echo "HATA: Ajan $PORT üzerinde açılmadı. Son günlük satırları:" >&2
    tail -20 "$AGENT_LOG" >&2 || true
    exit 1
  fi
  echo "· Ajan hazır ($PORT)."
fi

# --- 2) Derleme denetimi ---------------------------------------------------
# TanStack Start SPA derlemesi kök belgeyi sürüme göre `_shell.html` olarak yazar;
# `prepare-electron.cjs` bundan göreli yollu `index.html` üretir.
if [ ! -f "dist/client/index.html" ] || [ ! -d "dist/client/assets" ]; then
  echo "· SPA derlemesi üretiliyor…"
  npx vite build -c vite.electron.config.ts
  echo "· Electron için göreli varlık yolları hazırlanıyor…"
  node scripts/prepare-electron.cjs
  echo "· Derleme tamamlandı."
else
  echo "· Derleme hazır — atlandı (yenilemek için: rm -rf dist)."
fi

# --- 3) Electron ikili denetimi -------------------------------------------
if [ ! -x "./node_modules/electron/dist/electron" ]; then
  echo "HATA: ./node_modules/electron/dist/electron bulunamadı." >&2
  echo "Çözüm: 'npm install' çalıştırın (Electron ikilisini de indirir)." >&2
  exit 1
fi

# --- 4) Başlat -------------------------------------------------------------
EXTRA_FLAGS=()
if [ -n "${DIJI_CDP_PORT:-}" ]; then
  EXTRA_FLAGS+=("--remote-debugging-port=${DIJI_CDP_PORT}")
  echo "· DevTools uzaktan hata ayıklama: ${DIJI_CDP_PORT} (tanılama modu)"
fi

echo "· Electron penceresi açılıyor (bayrak: --no-sandbox)…"
exec ./node_modules/electron/dist/electron electron/main.cjs --no-sandbox "${EXTRA_FLAGS[@]}"
