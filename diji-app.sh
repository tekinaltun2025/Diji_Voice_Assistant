#!/bin/bash
# Diji masaüstü uygulaması başlatıcısı.
#
# Neden gerekli: AppImage içindeki `chrome-sandbox` SUID olamaz, Ubuntu 24.04+
# ise `kernel.apparmor_restrict_unprivileged_userns=1` ile kullanıcı ad
# alanlarını kısıtlar. Bu durumda Electron "SUID sandbox helper binary ...
# aborting" hatasıyla sessizce kapanır ve uygulama hiç açılmaz.
# Chromium sandbox'ı bu yerel, tek kullanıcı uygulaması için kapatılıyor.
set -e
export ELECTRON_DISABLE_SANDBOX=1

# Bazi terminal/IDE ortamlarinda `ELECTRON_RUN_AS_NODE=1` set edilmis olur.
# Bu durumda Electron GUI acmaz, kendini saf Node gibi calistirir ve
# `app.commandLine` undefined kalir ("Cannot read properties of undefined").
# Arayuzun gercekten acilmasi icin bu degisken kaldirilir.
unset ELECTRON_RUN_AS_NODE

# Seslendirme açık (canlı kullanım): yanıtlar hem panelde gösterilir hem
# hoparlörden okunur. Kapatmak için bu satırı 0 yapın.
#
# Uygulama çalışırken kapatmak için yeniden başlatma GEREKMEZ: tray menüsündeki
# `TTS (seslendirme)` onay kutusu ya da arayüzdeki ses düğmesi yeterlidir.
# Buradaki değer yalnızca açılış varsayılanıdır.
export DIJI_TTS_ENABLED=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ajan arayüz tarafından kendisi başlatılır; burada ayrıca bir şey yapılmaz.
APPIMAGE="$ROOT/ui/release/Diji-1.0.0.AppImage"
UNPACKED="$ROOT/ui/release/linux-unpacked/@dijiui"

# AppImage calisirken kendini FUSE ile gecici bir dizine baglar. Bazi
# ortamlarda (kisitli konteyner/uzak oturum, `fusermount: file descriptor 5
# is not a socket`) bu baglama basarisiz olur ve uygulama hic acilmaz.
# Bu yuzden ayni derlemenin acilmis (unpacked) ikilisi varsa o tercih edilir;
# yoksa normal AppImage yolu denenir.
if [ -x "$UNPACKED" ]; then
  exec "$UNPACKED" "$@"
fi

if [ -x "$APPIMAGE" ]; then
  # FUSE yoksa AppImage'in kendi cikarma moduna dus (yavas ama calisir).
  exec env APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE" "$@"
fi

echo "Diji ikilisi bulunamadi: $UNPACKED veya $APPIMAGE" >&2
exit 1
