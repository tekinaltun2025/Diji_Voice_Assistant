#!/bin/bash
# Diji Build Script
# Tüm paketleri production için derler

set -e

echo "🔨 Diji production build başlatılıyor..."

# Renkler
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Temizleme
echo -e "${YELLOW}🧹 Eski build dosyaları temizleniyor...${NC}"
npm run clean
echo -e "${GREEN}✅ Temizleme tamam${NC}"

# Bağımlılıkları yükle
echo -e "${YELLOW}📦 Bağımlılıklar yükleniyor...${NC}"
npm install --production
echo -e "${GREEN}✅ Bağımlılıklar yüklendi${NC}"

# Shared paketi derle
echo -e "${YELLOW}🔨 Shared paket derleniyor...${NC}"
npm run build:shared
echo -e "${GREEN}✅ Shared paket derlendi${NC}"

# Agent derle
echo -e "${YELLOW}🔨 Agent derleniyor...${NC}"
npm run build:agent
echo -e "${GREEN}✅ Agent derlendi${NC}"

# MCP sunucuları derle
echo -e "${YELLOW}🔨 MCP sunucuları derleniyor...${NC}"
npm run build:mcp
echo -e "${GREEN}✅ MCP sunucuları derlendi${NC}"

# UI derle
echo -e "${YELLOW}🔨 UI derleniyor...${NC}"
npm run build:ui
echo -e "${GREEN}✅ UI derlendi${NC}"

echo -e "${GREEN}🎉 Tüm build işlemleri tamamlandı!${NC}"
echo -e "${YELLOW}📁 Çıktı dizinleri:${NC}"
echo -e "  - agent/dist/"
echo -e "  - mcp_servers/*/dist/"
echo -e "  - ui/dist/"
echo -e "  - ui/release/"