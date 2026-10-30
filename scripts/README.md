# Diji Scripts

Bu dizin Diji projesinin geliştirme, build ve dağıtım scriptlerini içerir.

## Scriptler

### `setup.sh` - İlk Kurulum
İlk kez kurulum yapmak için çalıştırın. Node.js sürümünü kontrol eder, bağımlılıkları yükler ve `.env` dosyasını oluşturur.

```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
```

### `dev.sh` - Geliştirme Ortamı
Tüm servisleri geliştirme modunda başlatır. Yerel LLM uç noktasını
(`DIJI_LLM_BASE_URL`, varsayılan `http://127.0.0.1:8000/v1`) ve LiveKit
değişkenlerini kontrol eder. LLM erişilemezse **çıkış yapar**; LiveKit
yoksa yalnızca bilgi verir (yerel modda gerekmez).

```bash
chmod +x scripts/dev.sh
./scripts/dev.sh
```

### `build.sh` - Production Build
Tüm paketleri production için derler. Shared → Agent → MCP → UI sırasıyla derleme yapar.

```bash
chmod +x scripts/build.sh
./scripts/build.sh
```

### `deploy.sh` - Dağıtım
Uygulamayı production veya staging ortamına dağıtır.

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh production
./scripts/deploy.sh staging
```

## Ön Koşullar

- Node.js >= 20
- **Yerel LLM uç noktası** — OpenAI uyumlu, varsayılan `http://127.0.0.1:8000/v1`,
  model `agent`, API anahtarı `sk-local`. Doğrulama:
  ```bash
  curl -s -H "Authorization: Bearer sk-local" \
    http://127.0.0.1:8000/v1/models
  ```
- Yerel ses modelleri: `./scripts/download-models.sh all`
- LiveKit hesabı **gerekmez** (yalnızca uzak taşıma katmanı için opsiyonel)

## Ortam Değişkenleri

`.env` dosyasında aşağıdaki değişkenleri ayarlayın:

```env
# LLM (varsayılanlar zaten yerel yönlendiriciye ayarlı)
DIJI_LLM_BASE_URL=http://127.0.0.1:8000/v1
DIJI_LLM_MODEL=agent
DIJI_LLM_API_KEY=sk-local

# Ses modelleri
DIJI_MODELS_DIR=/home/<kullanici>/.diji/models

# Opsiyonel: uzak taşıma katmanı
LIVEKIT_URL=wss://your-livekit-server.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret

LOG_LEVEL=info