# Jarvis — Devir Teslim Notu (HANDOFF)

Jarvis, tarayıcıda ve Ubuntu masaüstünde çalışan **Türkçe sesli asistan arayüzü**dür.
Bu paket, projenin temiz kaynak kodunu (bağımlılıklar ve derleme çıktıları hariç) içerir.

## Proje ne yapar?

- **Web arayüzü:** Tek sayfa; mikrofona tepki veren "Kuantum Cam" ses formu, sohbet ekranı,
  yandan açılır geçmiş, sistem göstergeleri (CPU/RAM/VRAM/kablosuz — **örnek veri**).
- **Sohbet geçmişi** tarayıcı depolamasında (localStorage) tutulur; hesap veya sunucu gerekmez.
- **Gerçek AI bağlantısı yoktur:** bu bir arayüz/tasarım teslimi; mesaj gönderimi yalnızca
  yerel olarak kaydedilir, yapay zekâ yanıtı üretilmez.
- **Mikrofon** yalnızca ses formunu hareketlendirmek için kullanılır; ses kaydedilmez,
  sunucuya gönderilmez, konuşma tanıma yapılmaz.

## Klasör yapısı

| Yol | İçerik |
| --- | --- |
| `src/routes/index.tsx` | Tüm arayüz: widget, sohbet, geçmiş, göstergeler |
| `src/components/quantum-wave.tsx` | Canvas 2D ses formu (mikrofon seviyesine tepki verir) |
| `src/styles.css` | Tüm görsel tema (Tailwind v4 + özel CSS) |
| `electron/main.cjs` | Electron ana süreci (`app://jarvis/` özel protokolü) |
| `scripts/prepare-electron.cjs` | Electron için SPA kabuğu hazırlığı |
| `tests/quantum_wave_browser.py` | Arayüz doğrulaması için Playwright betiği |
| `AGENTS.md`, `roadmap.md` | Proje kararları ve görev geçmişi — okumadan değişiklik yapmayın |

## Kurulum ve çalıştırma

```sh
npm install          # veya bun install / pnpm install
npm run dev          # geliştirme sunucusu (varsayılan http://localhost:8080)
```

Derleme (Node sunucusu, SSR):

```sh
npm run build        # çıktı: .output (nitro node-server preset)
```

Electron masaüstü paketi:

```sh
npx vite build -c vite.electron.config.ts   # SPA kabuğu (dist/client)
node scripts/prepare-electron.cjs           # göreli yol düzeltmesi
npx electron .                              # pencereyi açar
```

Ubuntu'ya dağıtılabilir paket için `@electron/packager` kullanılabilir
(bkz. `electron/README.md`).

## Teknik özet

- **Dil/Ekosistem:** TypeScript, React 19, TanStack Start v1 (SSR + Vite 8), Tailwind CSS v4.
- **Yönlendirme:** TanStack Router (`src/routes/`); `src/routeTree.gen.ts` otomatik üretilir,
  elle düzenlemeyin.
- **Derleme:** `nitro` (node-server preset) — dış sunucu/veritabanı bağlantısı yoktur.
- **Durum:** yalnızca React state + localStorage; backend, kimlik doğrulama ve veritabanı yoktur.

## Bilinen notlar

- Bu paketteki `vite.config.ts` ve `vite.electron.config.ts`, Lovable'ın özel sarmalayıcı
  paketi yerine **standart Vite eklentileriyle** yazılmıştır; derleme test edilmiştir.
- Sistem göstergelerindeki değerler örnektir; tarayıcı Ubuntu donanım ölçümlerini okuyamaz.
  Gerçek CPU/RAM ölçümü ayrı **Python** paketinde (psutil) yapılmaktadır.
- `Alt+Space` kısayolu geçmiş panelini açar/kapatır.
