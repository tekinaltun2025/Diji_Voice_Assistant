<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Sesli asistan arayüzü tek sayfalı bir widget olarak tutulur; istek yalnızca ekran tasarımı olduğu için gerçek AI yanıtı taklit edilmez.
- Konuşma geçmişi cihazdaki tarayıcı depolamasında tutulur; hesap veya sunucu kurulumu gerektirmez.
- Sistem metrikleri ses formunun iki yanında, widget içinde örnek veriler olarak gösterilir; tarayıcı Ubuntu donanım ölçümlerine doğrudan erişemediği için gerçek veri gibi sunulmaz.
- Python masaüstü teslimi ayrı bir kaynak paketidir; web önizlemesinden bağımsızdır ve gerçek CPU/RAM ölçümlerini okurken desteklenmeyen metrikleri boş bırakır.
- QuantumWave renders the liquid audio form using Canvas 2D; microphone analysis stays entirely in the browser and releases tracks and AudioContext on stop or unmount, without speech recognition or audio uploads.
- Electron masaüstü teslimi `vite.electron.config.ts` (base './', spa.enabled) + `scripts/prepare-electron.cjs` + `electron/main.cjs` ile üretilir; çıktı `app://jarvis/` özel protokolü üzerinden yüklenir çünkü file:// yolunda yönlendirici "/" rotasını bulamaz. `electron-release` çıktıları repoya yazılmaz (10 MB dosya limiti) ve paketleme `--out=/tmp` ile yapılır.
