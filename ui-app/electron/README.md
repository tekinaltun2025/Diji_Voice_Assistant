# Jarvis — Electron Masaüstü Uygulaması

Jarvis'ın Ubuntu için Electron + TypeScript + React paketidir. Sohbet geçmişi
uygulamanın kendi deposunda (localStorage) tutulur; hesap gerekmez, sunucuya
bağlantı kurulmaz. Mikrofon yalnızca ses formunu hareketlendirmek için kullanılır.

## Çalıştırma

```sh
tar xzf Jarvis-Electron-Ubuntu.tar.gz
cd Jarvis-linux-x64
./Jarvis
```

Eksik kütüphane hatası alırsanız:

```sh
sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1 libxss1
```

## Kaynaktan derleme

Proje deposunda:

```sh
npm install
npx vite build -c vite.electron.config.ts   # SPA kabuğu (Electron için)
node scripts/prepare-electron.cjs           # göreli yol düzeltmesi
npx electron .
```

Notlar:
- Yüklenen sayfa `app://jarvis/` özel protokolü üzerinden servis edilir;
  yönlendirici kök yoldan çalışır ve localStorage kalıcıdır.
- Mikrofon izni `electron/main.cjs` içinde yerel olarak onaylanır.
- Yapay zekâ yanıtları ve servis bağlantıları bu pakette bağlı değildir.
