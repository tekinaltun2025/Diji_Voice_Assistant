#!/usr/bin/env bash
# ==============================================================================
# Diji - Yerel Model Indirme Script'i
#
# Bu script, Diji'nin yerel olarak calisan motorlari icin gereken modelleri
# indirir. Modeller ~/.diji/models altina yerlestirilir.
#
# Kullanim:
#   ./scripts/download-models.sh           # hepsini indir
#   ./scripts/download-models.sh stt       # sadece STT
#   ./scripts/download-models.sh tts       # sadece TTS
#   ./scripts/download-models.sh vad       # sadece VAD
# ==============================================================================

set -euo pipefail

MODELS_DIR="${DIJI_MODELS_DIR:-$HOME/.diji/models}"
mkdir -p "$MODELS_DIR"

info()  { printf '\033[32m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }

download_and_extract() {
  local url="$1"
  local target_dir="$2"
  local archive="$MODELS_DIR/$(basename "$url")"

  if [ -d "$target_dir" ] && [ -n "$(ls -A "$target_dir" 2>/dev/null)" ]; then
    info "Zaten mevcut, atlaniyor: $target_dir"
    return 0
  fi

  info "Indiriliyor: $url"
  curl -fL --retry 3 --progress-bar -o "$archive" "$url"

  info "Acilıyor: $archive"
  tar -xf "$archive" -C "$MODELS_DIR"
  rm -f "$archive"

  info "Tamamlandi: $target_dir"
}

install_stt() {
  info "=== STT (SenseVoice - Turkce destekli, cok dilli) ==="
  download_and_extract \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2" \
    "$MODELS_DIR/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
  warn "Not: SenseVoice Turkce'yi dogrudan desteklemez."
  warn "Turkce icin whisper modeli onerilir:"
  warn "  https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models"
  warn "  sherpa-onnx-whisper-small / sherpa-onnx-whisper-medium"
}

# Tek bir Whisper modelini indirir. $1 = onek (tiny|base|small|medium|large-v3)
install_whisper_model() {
  local prefix="$1"
  info "=== STT (Whisper ${prefix} - Turkce) ==="
  download_and_extract \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-${prefix}.tar.bz2" \
    "$MODELS_DIR/sherpa-onnx-whisper-${prefix}"
}

install_whisper() {
  # ONCELIK: medium > small. Diskte medium varsa small indirilmez. Medium modeli int8-quantized.
  # (uygulama zaten en buyuk modeli secer; gereksiz indirme yapilmaz).
  if [ -d "$MODELS_DIR/sherpa-onnx-whisper-medium" ] && \
     [ -n "$(ls -A "$MODELS_DIR/sherpa-onnx-whisper-medium" 2>/dev/null)" ]; then
    info "Whisper medium zaten mevcut — kullanilacak model: medium"
    return 0
  fi
  install_whisper_model "medium"
  info ""
  info "Dogruluk/gecikme dengesi icin small da indirilebilir: $0 stt-small"
}

# Turkce dogrulugu en yuksek model (CPU'da belirgin yavas).
install_whisper_large() {
  install_whisper_model "large-v3"
}

install_tts() {
  info "=== TTS (VITS - Turkce) ==="
  download_and_extract \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-tr_TR-fettah-medium.tar.bz2" \
    "$MODELS_DIR/vits-piper-tr_TR-fettah-medium"
}

install_vad() {
  info "=== VAD (Silero) ==="
  local vad_file="$MODELS_DIR/silero_vad.onnx"
  if [ -f "$vad_file" ]; then
    info "Zaten mevcut, atlaniyor: $vad_file"
    return 0
  fi
  curl -fL --retry 3 --progress-bar -o "$vad_file" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
  info "Tamamlandi: $vad_file"
}

case "${1:-all}" in
  stt)        install_whisper ;;
  whisper)    install_whisper ;;
  stt-small)  install_whisper_model "small" ;;
  stt-base)   install_whisper_model "base" ;;
  stt-tiny)   install_whisper_model "tiny" ;;
  stt-large)  install_whisper_large ;;
  sense)      install_stt ;;
  tts)        install_tts ;;
  vad)        install_vad ;;
  all)
    install_vad
    install_whisper
    install_tts
    ;;
  *)
    error "Bilinmeyen hedef: $1"
    echo "Kullanim: $0 [stt|whisper|stt-tiny|stt-base|stt-small|stt-large|sense|tts|vad|all]"
    exit 1
    ;;
esac

info ""
info "Modeller su dizinde: $MODELS_DIR"
ls -1 "$MODELS_DIR"
