#!/bin/bash
# Diji Setup Script
# İlk kurulum ve yapılandırma

set -e

echo "🛠️ Diji kurulum başlatılıyor..."

# Renkler
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Node.js sürüm kontrolü
echo -e "${YELLOW}📋 Node.js sürüm kontrol ediliyor...${NC}"
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "${RED}❌ Node.js 20+ gereklidir. Mevcut: $(node -v)${NC}"
  exit 1
fi
echo -e "${GREEN}✅ Node.js sürüm uygun: $(node -v)${NC}"

# npm kurulumu
echo -e "${YELLOW}📦 npm bağımlılıkları yükleniyor...${NC}"
npm install
echo -e "${GREEN}✅ npm bağımlılıkları yüklendi${NC}"

# Ortam değişkenleri dosyası oluştur
echo -e "${YELLOW}⚙️ Ortam değişkenleri dosyası oluşturuluyor...${NC}"
if [ ! -f .env ]; then
  cp ui/.env.example .env
  echo -e "${GREEN}✅ .env dosyası oluşturuldu${NC}"
  echo -e "${YELLOW}⚠️  Lütfen .env dosyasını düzenleyin ve gerekli değerleri girin${NC}"
else
  echo -e "${YELLOW}⚠️  .env dosyası zaten mevcut, atlanıyor${NC}"
fi

# Klasörler oluştur
echo -e "${YELLOW}📁 Gerekli klasörler oluşturuluyor...${NC}"
mkdir -p logs
mkdir -p ui/assets
echo -e "${GREEN}✅ Klasörler oluşturuldu${NC}"

# Drifting TTS (önerilen TTS arka ucu) kontrolü
echo -e "${YELLOW}🔊 Drifting TTS kontrol ediliyor...${NC}"
if python3 -c "import drifting_tts" >/dev/null 2>&1; then
  echo -e "${GREEN}✅ drifting-tts Python paketi mevcut${NC}"
  echo -e "${YELLOW}ℹ️  Ağırlıklar ilk sentezde HuggingFace Hub'dan indirilir (Vyvo/drifting-tts-tr)${NC}"
else
  echo -e "${YELLOW}⚠️  drifting-tts paketi bulunamadı${NC}"
  echo -e "${YELLOW}📥 Kurulum: pip install \"drifting-tts[bigvgan] @ git+https://github.com/kadirnar/drifting-tts\"${NC}"
  echo -e "${YELLOW}   (torch/ROCm zaten kuruluysa --no-deps ekleyin)${NC}"
  echo -e "${YELLOW}   Yedek motor sherpa-vits ile devam edilir: DIJI_TTS_PROVIDER=sherpa-vits${NC}"
fi

# LLM uç noktası kontrolü
# Varsayılan: her zaman ayakta olan yerel yönlendirici (127.0.0.1:8000)
LLM_BASE_URL="${DIJI_LLM_BASE_URL:-http://127.0.0.1:8000/v1}"
LLM_MODEL="${DIJI_LLM_MODEL:-agent}"
LLM_API_KEY="${DIJI_LLM_API_KEY:-sk-local}"

echo -e "${YELLOW}🤖 LLM sunucusu kontrol ediliyor (${LLM_BASE_URL})...${NC}"
LLM_RESPONSE=$(curl -s -m 5 \
  -H "Authorization: Bearer ${LLM_API_KEY}" \
  "${LLM_BASE_URL}/models" 2>/dev/null || true)

if [ -z "$LLM_RESPONSE" ]; then
  echo -e "${YELLOW}⚠️  LLM sunucusuna ulaşılamadı — kontrol atlanıyor${NC}"
  echo -e "${YELLOW}   Diji yine de kurulur; LLM olmadan sesli boru hattı çalışır${NC}"
  echo -e "${YELLOW}   (isLlmReady=false). Sunucuyu başlatıp doğrulayın:${NC}"
  echo -e "${YELLOW}   curl -H \"Authorization: Bearer ${LLM_API_KEY}\" ${LLM_BASE_URL}/models${NC}"
elif echo "$LLM_RESPONSE" | grep -q "\"${LLM_MODEL}\""; then
  echo -e "${GREEN}✅ LLM çalışıyor, '${LLM_MODEL}' modeli mevcut${NC}"
else
  echo -e "${YELLOW}⚠️  LLM çalışıyor fakat '${LLM_MODEL}' modeli listede yok${NC}"
  echo -e "${YELLOW}   Mevcut modeller:${NC}"
  echo "$LLM_RESPONSE" | grep -o '"id":"[^"]*"' | sed 's/"id":"//; s/"$//' | sed 's/^/     - /'
  echo -e "${YELLOW}   Modeli değiştirmek için: export DIJI_LLM_MODEL=<ad>${NC}"
fi

echo -e "${GREEN}🎉 Kurulum tamamlandı!${NC}"
echo -e "${YELLOW}📝 Sonraki adımlar:${NC}"
echo -e "  1. .env dosyasını düzenleyin"
echo -e "  2. Yerel ses modellerini indirin: ./scripts/download-models.sh all"
echo -e "  3. LLM sunucusunun çalıştığını doğrulayın:"
echo -e "     curl -H \"Authorization: Bearer ${LLM_API_KEY}\" ${LLM_BASE_URL}/models"
echo -e "  4. Geliştirme başlatın: ./scripts/dev.sh"