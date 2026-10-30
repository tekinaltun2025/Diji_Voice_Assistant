#!/bin/bash
# Diji Development Script
# Tüm servisleri geliştirme modunda başlatır

set -e

echo "🚀 Diji geliştirme ortamı başlatılıyor..."

# Renkler
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Fonksiyonlar

# LLM uc noktasi: varsayilan olarak her zaman ayakta olan yerel yonlendirici
LLM_BASE_URL="${DIJI_LLM_BASE_URL:-http://127.0.0.1:8000/v1}"
LLM_MODEL="${DIJI_LLM_MODEL:-agent}"
LLM_API_KEY="${DIJI_LLM_API_KEY:-sk-local}"

check_llm() {
  echo -e "${YELLOW}📋 LLM sunucusu kontrol ediliyor (${LLM_BASE_URL})...${NC}"

  # /v1/models uç noktasını API anahtarıyla sorgula
  local response
  response=$(curl -s -m 5 \
    -H "Authorization: Bearer ${LLM_API_KEY}" \
    "${LLM_BASE_URL}/models" 2>/dev/null || true)

  if [ -z "$response" ]; then
    echo -e "${RED}❌ LLM sunucusuna ulaşılamadı: ${LLM_BASE_URL}${NC}"
    echo -e "${YELLOW}   Sunucunun çalıştığını doğrulayın, örn:${NC}"
    echo -e "${YELLOW}   curl -H \"Authorization: Bearer ${LLM_API_KEY}\" ${LLM_BASE_URL}/models${NC}"
    echo -e "${YELLOW}   Farklı bir uç nokta için: export DIJI_LLM_BASE_URL=...${NC}"
    exit 1
  fi

  if echo "$response" | grep -q "\"${LLM_MODEL}\""; then
    echo -e "${GREEN}✅ LLM çalışıyor, '${LLM_MODEL}' modeli mevcut${NC}"
  else
    echo -e "${YELLOW}⚠️  LLM çalışıyor fakat '${LLM_MODEL}' modeli listede yok${NC}"
    echo -e "${YELLOW}   Mevcut modeller:${NC}"
    echo "$response" | grep -o '"id":"[^"]*"' | sed 's/"id":"//; s/"$//' | sed 's/^/     - /'
    echo -e "${YELLOW}   Modeli değiştirmek için: export DIJI_LLM_MODEL=<ad>${NC}"
  fi
}

# Not: LiveKit zorunlu DEĞİL. Diji kendi ses pipeline'ını (VAD→STT→LLM→TTS)
# doğrudan süreç içinde çalıştırır. Değişkenler yalnızca ileride uzak
# taşıma katmanı eklendiğinde gerekir; bu yüzden yalnızca bilgi verilir.
check_livekit() {
  if [ -n "$LIVEKIT_URL" ] && [ -n "$LIVEKIT_API_KEY" ] && [ -n "$LIVEKIT_API_SECRET" ]; then
    echo -e "${GREEN}✅ LiveKit yapılandırması mevcut (opsiyonel)${NC}"
  else
    echo -e "${YELLOW}ℹ️  LiveKit değişkenleri yok — yerel modda çalışılıyor (sorun değil)${NC}"
  fi
}

install_dependencies() {
  echo -e "${YELLOW}📦 Bağımlılıklar yükleniyor...${NC}"
  npm install
  echo -e "${GREEN}✅ Bağımlılıklar yüklendi${NC}"
}

build_shared() {
  echo -e "${YELLOW}🔨 Shared paket derleniyor...${NC}"
  npm run build:shared
  echo -e "${GREEN}✅ Shared paket derlendi${NC}"
}

start_services() {
  echo -e "${YELLOW}🎯 Servisler başlatılıyor...${NC}"
  npm run dev
}

# Ana akış
check_llm
check_livekit
install_dependencies
build_shared
start_services