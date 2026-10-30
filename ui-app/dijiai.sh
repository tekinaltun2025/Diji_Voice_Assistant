#!/usr/bin/env bash
# DijiAI — tek tıkla başlatıcı (masaüstü / uygulama menüsü girdisi bunu çağırır).
#
# Tasarım notları
# ---------------
# 1) SÜREÇ KOPARMA: Electron, başlatan kabuk öldüğünde SIGHUP alıp sessizce
#    kapanıyordu (terminal kapanınca uygulama da gidiyordu). Bu yüzden `setsid`
#    ile yeni oturuma alınır, `nohup` ile SIGHUP yok sayılır ve çıktı dosyaya
#    yönlendirilir. Kabuk hemen döner; pencere açık kalır.
# 2) TEK ÖRNEK: İkinci süreç mikrofon için birinciyle yarışır (ALSA cihazı tek).
#    Zaten çalışıyorsa yeni süreç açılmaz, var olan pencere öne getirilir.
# 3) GÖRÜNÜR HATA: Masaüstünden başlatıldığında stdout görünmez. Bu yüzden tüm
#    adımlar `/tmp/dijiai.log` dosyasına yazılır; kritik hata olursa ayrıca
#    `zenity`/`notify-send` varsa kullanıcıya gösterilir.
# 4) ELECTRON_RUN_AS_NODE: VSCode tümleşik terminalinde 1 olarak tanımlıdır ve
#    Electron'u saf Node gibi çalıştırır (pencere açılmaz). Temizlenir.
set -uo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$APP_ROOT/.." && pwd)"
DIJI_HOME="${DIJI_HOME:-$PROJECT_ROOT}"
PORT="${DIJI_CONTROL_PORT:-8899}"
LOG="/tmp/dijiai.log"

export ELECTRON_DISABLE_SANDBOX=1
unset ELECTRON_RUN_AS_NODE || true

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG"; }

# Kullanıcıya görünür bildirim (varsa). Sessiz başarısızlık en kötü senaryo.
fail() {
  log "HATA: $*"
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="DijiAI" --width=460 --text="$*" 2>/dev/null || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send -u critical "DijiAI açılamadı" "$*" 2>/dev/null || true
  fi
  exit 1
}

: >"$LOG"
log "DijiAI başlatıcı — kök: $APP_ROOT"

# --------------------------------------------------------------- tek örnek
# `pkill -f` kendini de eşleştirebildiği için tam yol deseni kullanılıyor.
if pgrep -f "$APP_ROOT/electron/main.cjs" >/dev/null 2>&1; then
  log "Zaten çalışıyor — yeni süreç açılmadı, pencere öne getiriliyor."
  command -v wmctrl >/dev/null 2>&1 && wmctrl -a "DijiAI" 2>/dev/null || true
  exit 0
fi

# --------------------------------------------------------------- ajan
agent_healthy() { curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; }

if agent_healthy; then
  log "Ajan zaten ayakta ($PORT)."
else
  [ -f "$DIJI_HOME/agent/dist/index.js" ] || \
    fail "Ajan derlemesi yok:
$DIJI_HOME/agent/dist/index.js

Çözüm: cd '$DIJI_HOME' && npx tsc -b --force"
  log "Ajan başlatılıyor…"
  ( cd "$DIJI_HOME" && exec setsid env -u ELECTRON_RUN_AS_NODE \
      node agent/dist/index.js ) >/tmp/diji-agent-ui.log 2>&1 </dev/null &
  for _ in $(seq 1 60); do agent_healthy && break; sleep 1; done
  agent_healthy || fail "Ajan $PORT portunda açılmadı.
Günlük: /tmp/diji-agent-ui.log"
  log "Ajan hazır."
fi

# --------------------------------------------------------------- derleme
# TanStack Start kök belgeyi sürüme göre `_shell.html` yazar; prepare-electron
# ondan göreli yollu `index.html` üretir. Derleme yoksa bir kez üretilir.
if [ ! -f "$APP_ROOT/dist/client/index.html" ] || [ ! -d "$APP_ROOT/dist/client/assets" ]; then
  log "SPA derlemesi üretiliyor…"
  ( cd "$APP_ROOT" && npx vite build -c vite.electron.config.ts \
      && node scripts/prepare-electron.cjs ) >>"$LOG" 2>&1 \
    || fail "SPA derlemesi başarısız. Günlük: $LOG"
  log "Derleme tamam."
fi

# --------------------------------------------------------------- electron
ELECTRON_BIN=""
for candidate in "$APP_ROOT/node_modules/electron/dist/electron" \
                 "$PROJECT_ROOT/node_modules/electron/dist/electron"; do
  [ -x "$candidate" ] && { ELECTRON_BIN="$candidate"; break; }
done
[ -n "$ELECTRON_BIN" ] || fail "Electron ikilisi bulunamadı.
Denenen:
  $APP_ROOT/node_modules/electron/dist/electron
  $PROJECT_ROOT/node_modules/electron/dist/electron

Çözüm: proje kökünde 'npm install'."
log "Electron: $ELECTRON_BIN"

# `--class` masaüstü girdisindeki StartupWMClass ile eşleşmeli; aksi halde
# görev çubuğu ikonu genel Electron simgesine düşer.
cd "$APP_ROOT" || fail "Dizin açılamadı: $APP_ROOT"
log "Pencere açılıyor…"
setsid nohup "$ELECTRON_BIN" electron/main.cjs \
  --no-sandbox --class=DijiAI >>"$LOG" 2>&1 </dev/null &

# Sürecin gerçekten ayakta kaldığını doğrula (sessiz çöküşleri yakalar).
for _ in $(seq 1 20); do
  sleep 1
  if pgrep -f "$APP_ROOT/electron/main.cjs" >/dev/null 2>&1; then
    log "Çalışıyor (PID $(pgrep -f "$APP_ROOT/electron/main.cjs" | head -1))."
    exit 0
  fi
done

fail "Electron penceresi açılmadı.
Günlük: $LOG"
