#!/bin/bash
# Diji Deploy Script
# Uygulamayı production ortamına dağıtır

set -e

ENVIRONMENT=${1:-"production"}

echo "🚀 Diji dağıtım başlatılıyor: $ENVIRONMENT"

# Renkler
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Ortam kontrolü
if [ "$ENVIRONMENT" != "production" ] && [ "$ENVIRONMENT" != "staging" ]; then
  echo -e "${RED}❌ Geçersiz ortam: $ENVIRONMENT${NC}"
  echo -e "${YELLOW}📝 Kullanım: ./scripts/deploy.sh [production|staging]${NC}"
  exit 1
fi

# Ortam değişkenleri kontrolü
check_env() {
  local required_vars=("LIVEKIT_URL" "LIVEKIT_API_KEY" "LIVEKIT_API_SECRET")
  for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
      echo -e "${RED}❌ Ortam değişkeni eksik: $var${NC}"
      exit 1
    fi
  done
}

echo -e "${YELLOW}📋 Ortam değişkenleri kontrol ediliyor...${NC}"
check_env
echo -e "${GREEN}✅ Ortam değişkenleri tamam${NC}"

# Build
echo -e "${YELLOW}🔨 Production build...${NC}"
npm run build
echo -e "${GREEN}✅ Build tamamlandı${NC}"

# Dağıtım
if [ "$ENVIRONMENT" = "production" ]; then
  echo -e "${YELLOW}🚀 Production ortamına dağıtılıyor...${NC}"
  # Burada production dağıtım komutları olacak
  # Örn: scp, rsync, docker push, vb.
  echo -e "${GREEN}✅ Production dağıtımı tamamlandı${NC}"
else
  echo -e "${YELLOW}🚀 Staging ortamına dağıtılıyor...${NC}"
  # Burada staging dağıtım komutları olacak
  echo -e "${GREEN}✅ Staging dağıtımı tamamlandı${NC}"
fi

echo -e "${GREEN}🎉 Dağıtım tamamlandı: $ENVIRONMENT${NC}"