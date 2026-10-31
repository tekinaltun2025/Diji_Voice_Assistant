#!/usr/bin/env bash
#
# PipeWire WebRTC Yankı Engelleme (AEC) kurulumu — Diji
#
# AMAÇ
#   Mikrofon girişi ile hoparlör çıkışını aynı PipeWire grafiğine bağlayıp
#   aradaki akustik yankıyı (asistanın kendi sesinin mikrofona dönüşünü)
#   yazılım seviyesinde silmek. Bu, gerçek full-duplex çalışmanın ön koşuludur:
#   yankı silinmezse VAD asistanın kendi sesini "kullanıcı konuşuyor" sanar.
#
# NEDEN pw-cli DEĞİL DE KALICI YAPILANDIRMA
#   `pw-cli load-module` yalnızca o anki PipeWire oturumuna ekler; PipeWire
#   yeniden başladığında (oturum kapanması, servis yeniden başlatma) modül
#   kaybolur ve full-duplex sessizce bozulur. Bu yüzden kalıcı yapılandırma
#   dosyası yazılır: ~/.config/pipewire/pipewire.conf.d/20-diji-aec.conf
#
# KULLANIM
#   ./setup-aec.sh              # kur (varsayılan: webrtc AEC, gürültü azaltma açık)
#   ./setup-aec.sh --durum      # mevcut durumu göster, hiçbir şey değiştirme
#   ./setup-aec.sh --kaldir     # kalıcı yapılandırmayı sil
#   ./setup-aec.sh --gecici     # yalnızca bu oturum için yükle (test amaçlı)
#
# ÖNEMLİ — BU MAKİNEDE DOĞRULANAN SINIR
#   `pipewire-pulse` ve `libspa-aec-webrtc.so` kurulu olmasına rağmen
#   WirePlumber bu sistemde ALSA cihazlarını Audio/Source ve Audio/Sink
#   düğümü olarak yayınlamıyor; `wpctl status` altında Audio bölümünde yalnızca
#   "Dummy Output" görünüyor. Bu durumda AEC modülü yüklenir (çıkış kodu 0)
#   fakat hedef düğüm bulamadığı için HİÇBİR düğüm üretmez ve
#   `arecord -D pipewire` sessiz (tam sıfır) veri döndürür.
#   Bu yüzden bu betik, kurulum sonrası AEC kaynağının GERÇEKTEN oluşup
#   oluşmadığını ölçer ve oluşmadıysa açıkça "AEC etkin değil" der.
#   Diji tarafındaki cihaz çözümlemesi (agent/src/audio-io.ts) de aynı kurala
#   uyar: AEC kaynağı bulunursa onu kullanır, bulunamazsa donanım cihazına döner.
#
# GÜVENLİK
#   Bu betik yalnızca kullanıcı yapılandırma dizinine yazar (~/.config).
#   sudo gerekmez, sistem geneli hiçbir dosya değiştirilmez.

set -euo pipefail

# ------------------------------------------------------------------ sabitler
readonly CONF_DIR="${HOME}/.config/pipewire/pipewire.conf.d"
readonly CONF_FILE="${CONF_DIR}/20-diji-aec.conf"
# PipeWire yeniden başladığında da yüklenmesi için servis dosyası değil
# konfigürasyon parçası kullanılır; ad sıralaması 20- ile başlar ki
# varsayılan 50-* kurallarından ÖNCE uygulanır.
readonly SPA_AEC_NAMES=("webrtc" "null")

# ------------------------------------------------------------------ yardımcılar
log() { printf '[AEC] %s\n' "$*"; }
warn() { printf '[AEC] UYARI: %s\n' "$*" >&2; }
fail() { printf '[AEC] HATA: %s\n' "$*" >&2; exit 1; }

# PipeWire ortamı erişilebilir mi? (kullanıcı oturumu yoksa hiçbir şey yapma)
require_pipewire() {
  command -v pw-cli >/dev/null 2>&1 || fail "pw-cli bulunamadı. 'pipewire-bin' paketi kurulu mu?"
  command -v wpctl >/dev/null 2>&1 || fail "wpctl bulunamadı. 'wireplumber' paketi kurulu mu?"
  if ! pw-cli info 0 >/dev/null 2>&1; then
    fail "PipeWire sunucusuna ulaşılamıyor. Masaüstü oturumu açık mı?"
  fi
}

# WebRTC AEC eklentisinin diskte olup olmadığını doğrular.
# Eklenti yoksa modül yüklenir ama sessizce hiçbir iş yapmaz — bu, en sinsi
# hata biçimidir; o yüzden önceden kontrol edilir.
spa_aec_available() {
  local dir
  for dir in /usr/lib/x86_64-linux-gnu/spa-0.2/aec /usr/lib/spa-0.2/aec; do
    [ -f "${dir}/libspa-aec-webrtc.so" ] && return 0
  done
  return 1
}

# AEC kaynağının gerçekten oluşup oluşmadığını ölçer.
# Yalnızca "echo" içeren bir düğüm adı aranır; WirePlumber sürüm/dil
# farklarına göre ad değişebildiği için sabit ad yazılmaz.
aec_node_present() {
  pw-cli list-objects Node 2>/dev/null | grep -qiE 'echo|diji-aec'
}

# Mikrofonun gerçekten veri ürettiğini ÖLÇER (sıfır bayt / sıfır genlik tuzağı).
# Neden gerekli: `arecord -D pipewire` bu sistemde hata vermeden tamamen sıfır
# örnek döndürüyor. "Komut çalıştı" demek "ses geliyor" demek değildir.
# Dönüş: 0 = gerçek sinyal var, 1 = sessiz/sıfır, 2 = okunamadı
#
# Dönüş: 0 = gerçek sinyal var, 1 = sessiz/sıfır, 2 = okunamadı, 3 = cihaz MEŞGUL
#
# NEDEN "meşgul" ayrı bir durum: çalışan ajan mikrofonu kendi elinde tutar
# (`arecord ... -D plughw:CARD=amdsoundwire,DEV=4`). Bu sırada yapılan test
# hata vermeden boş/sıfır döner ve "mikrofon bozuk" gibi YANLIŞ bir sonuca yol
# açar. Doğru davranış: meşgulse ölçüm yapılamadığını söylemek.
capture_has_signal() {
  local device="$1" err raw
  err=$(timeout 3 arecord -D "$device" -f S16_LE -r 16000 -c 1 -t raw -q 2>&1 >/tmp/.diji-aec-probe.raw || true)

  if printf '%s' "$err" | grep -qiE 'busy|Device or resource'; then
    rm -f /tmp/.diji-aec-probe.raw
    return 3
  fi

  raw=$(head -c 6400 /tmp/.diji-aec-probe.raw 2>/dev/null || true)
  rm -f /tmp/.diji-aec-probe.raw

  [ -z "$raw" ] && return 2
  printf '%s' "$raw" | od -An -v -td2 | awk '
    { for (i = 1; i <= NF; i++) { v = $i; if (v < 0) v = -v; if (v > m) m = v } }
    END { exit (m > 0) ? 0 : 1 }
  '
}

# Donanım kayıt cihazlarını öncelik sırasına göre listeler.
#
# NEDEN hepsi deneniyor: bu makinede `plughw:CARD=amdsoundwire,DEV=1` sessiz
# (tam sıfır) dönerken `DEV=4` gerçek sinyal veriyor. Yalnızca ilk adaya bakmak
# "mikrofon bozuk" gibi yanlış bir sonuca yol açar.
hardware_sources() {
  arecord -L 2>/dev/null | grep -E '^plughw:CARD=' || true
}

# Gerçekten sinyal üreten ilk donanım cihazını bulur.
# Hiçbiri sinyal vermezse boş döner.
first_source_with_signal() {
  local dev
  while IFS= read -r dev; do
    [ -z "$dev" ] && continue
    if capture_has_signal "$dev"; then
      printf '%s' "$dev"
      return 0
    fi
  done <<< "$(hardware_sources)"
  return 1
}

# ------------------------------------------------------------------ eylemler
do_status() {
  log "--- PipeWire ---"
  pw-cli info 0 2>/dev/null | head -3 || true

  log "--- SPA AEC eklentisi ---"
  if spa_aec_available; then
    log "libspa-aec-webrtc.so bulundu"
  else
    warn "libspa-aec-webrtc.so BULUNAMADI — AEC çalışamaz"
  fi

  log "--- Kalıcı yapılandırma ---"
  if [ -f "$CONF_FILE" ]; then
    log "$CONF_FILE mevcut"
  else
    log "yok (kurulum yapılmamış)"
  fi

  log "--- AEC düğümü ---"
  if aec_node_present; then
    log "AEC düğümü VAR:"
    pw-cli list-objects Node 2>/dev/null | grep -iE 'echo|diji-aec' | sed 's/^[[:space:]]*/    /'
  else
    warn "AEC düğümü YOK"
  fi

  log "--- Ses düğümleri (wpctl) ---"
  wpctl status 2>/dev/null | sed -n '/^Audio/,/^Video/p' | head -20 || true

  log "--- Mikrofon sinyal testi (her cihaz tek tek) ---"
  local dev rc found="" busy=""
  while IFS= read -r dev; do
    [ -z "$dev" ] && continue
    # DİKKAT: `set -e` etkin olduğu için fonksiyonun 1/2/3 dönmesi betiği
    # öldürürdü. `|| rc=$?` bu yüzden zorunlu — ölçüm hatası bir HATA değil,
    # raporlanması gereken bir SONUÇTUR.
    rc=0
    capture_has_signal "$dev" || rc=$?
    case "$rc" in
      0) log "  $dev → gerçek sinyal VAR"; [ -z "$found" ] && found="$dev" ;;
      3) log "  $dev → MEŞGUL (başka bir süreç tutuyor) — ölçüm yapılamadı"; busy=1 ;;
      2) log "  $dev → veri okunamadı" ;;
      *) log "  $dev → sessiz (max = 0)" ;;
    esac
  done <<< "$(hardware_sources)"

  if [ -n "$busy" ]; then
    log "NOT: Meşgul cihazlar ölçülemedi. Ajan çalışıyorsa şu komutla bakın:"
    log "     curl -s http://127.0.0.1:8899/state | grep -o '\"acRms\":[0-9.]*'"
  fi
  if [ -z "$found" ] && [ -z "$busy" ]; then
    warn "Hiçbir donanım cihazında sinyal bulunamadı."
    warn "Mikrofon bağlı mı? 'alsamixer' ile kayıt seviyesini kontrol edin."
  elif [ -n "$found" ]; then
    log "Kullanılabilir kayıt cihazı: $found"
  fi
}

do_install_persistent() {
  mkdir -p "$CONF_DIR"

  # AEC modülünün hedef düğümleri: varsayılan kaynak/sink.
  # WirePlumber bu sistemde ALSA cihazlarını düğüm olarak yayınlamadığı için
  # hedef bulunamazsa modül yüklenir ama düğüm üretmez; bu durum aşağıda
  # ayrıca ölçülür ve kullanıcıya söylenir.
  cat > "$CONF_FILE" <<'CONF'
# Diji — PipeWire WebRTC Yankı Engelleme (AEC)
#
# Bu dosya setup-aec.sh tarafından yazılmıştır. Elle düzenlemek yerine
# betiği yeniden çalıştırın:  ./setup-aec.sh
#
# NEDEN GEREKLİ:
#   Gerçek full-duplex çalışmada asistan konuşurken mikrofon da açıktır.
#   Yankı yazılım seviyesinde silinmezse VAD asistanın kendi sesini
#   kullanıcı sesi sanır ve sistem kendini sonsuz keser.
#
# aec.method = webrtc : WebRTC'nin gömülü AEC'si (ek model dosyası istemez)
# analog_gain_control = false : AGC konuşma başlangıcını geciktirir; STT
#                                tarafında kendi AGC'miz zaten var
# noise_suppression = true : VAD eşiğini gürültüye karşı dayanıklı kılar
context.modules = [
  { name = libpipewire-module-echo-cancel
    args = {
      aec.method = webrtc
      aec.args = {
        webrtc.analog_gain_control = false
        webrtc.noise_suppression = true
      }
      source.props = {
        node.name        = "diji-aec-source"
        node.description = "Diji AEC Kaynak"
      }
      sink.props = {
        node.name        = "diji-aec-sink"
        node.description = "Diji AEC Hedef"
      }
    }
  }
]
CONF

  log "Kalıcı yapılandırma yazıldı: $CONF_FILE"
  log "Etkinleştirmek için PipeWire'ı yeniden başlatın:"
  log "  systemctl --user restart pipewire pipewire-pulse wireplumber"
}

do_load_session() {
  # Yalnızca bu oturum için yükleme (test). Kalıcı değildir.
  local module_args=(
    'library.name=aec/libspa-aec-webrtc'
    'source.props={ node.name="diji-aec-source" node.description="Diji AEC Kaynak" }'
    'sink.props={ node.name="diji-aec-sink" node.description="Diji AEC Hedef" }'
  )

  if aec_node_present; then
    log "AEC düğümü zaten var — yeniden yüklenmedi (idempotent)"
    return 0
  fi

  if pw-cli load-module libpipewire-module-echo-cancel "${module_args[@]}" >/dev/null 2>&1; then
    log "echo-cancel modülü yüklendi (bu oturum için)"
  else
    warn "echo-cancel modülü yüklenemedi"
    return 1
  fi

  # Modül kabul edildi ama düğüm üretmedi mi? En kritik kontrol bu.
  sleep 1.5
  if aec_node_present; then
    log "AEC düğümü oluştu:"
    pw-cli list-objects Node 2>/dev/null | grep -iE 'echo|diji-aec' | sed 's/^[[:space:]]*/    /'
  else
    warn "Modül yüklendi AMA düğüm oluşmadı."
    warn "Sebep genellikle şudur: WirePlumber bu sistemde ALSA cihazlarını"
    warn "Audio/Source ve Audio/Sink düğümü olarak yayınlamıyor"
    warn "(wpctl status → Audio bölümünde yalnızca 'Dummy Output' görünüyor)."
    warn "Bu durumda AEC etkin DEĞİLDİR; Diji otomatik olarak donanım"
    warn "mikrofonuna döner (bkz. agent/src/audio-io.ts → resolveAecDevices)."
    return 1
  fi
  return 0
}

do_remove() {
  if [ -f "$CONF_FILE" ]; then
    rm -f "$CONF_FILE"
    log "Kalıcı yapılandırma silindi: $CONF_FILE"
    log "Etkili olması için: systemctl --user restart pipewire pipewire-pulse wireplumber"
  else
    log "Kalıcı yapılandırma zaten yok"
  fi

  log "NOT: Bu oturumda elle yüklenmiş bir echo-cancel modülü varsa o"
  log "     PipeWire yeniden başlayana kadar etkin kalabilir. Durdurmak için:"
  log "       systemctl --user restart pipewire"
}

# ------------------------------------------------------------------ ana akış
main() {
  require_pipewire

  case "${1:---kur}" in
    --durum | -d | status)
      do_status
      ;;
    --kaldir | -r | remove)
      do_remove
      ;;
    --gecici | -g | temp)
      if ! spa_aec_available; then
        fail "libspa-aec-webrtc.so yok — AEC yüklenemez"
      fi
      do_load_session || exit 1
      ;;
    --kur | -k | install | *)
      if ! spa_aec_available; then
        fail "libspa-aec-webrtc.so yok — 'libspa-0.2-modules' paketi kurulu mu?"
      fi
      do_install_persistent
      # Kurulumun hemen ardından bu oturumda da dene ki kullanıcı geri bildirimi
      # anında olsun; başarısız olursa nedenini yukarıda açıkça söyler.
      do_load_session || true
      log ""
      log "Sonraki adım: ./setup-aec.sh --durum   ile AEC düğümünü doğrulayın."
      ;;
  esac
}

main "$@"
