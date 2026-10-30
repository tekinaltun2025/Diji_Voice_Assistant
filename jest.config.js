/**
 * Kök Jest yapılandırması.
 *
 * Neden gerekli: CI ve geliştiriciler depo kökünden `npx jest` çalıştırır.
 * Jest yapılandırmayı yalnızca kökte arar; `agent/jest.config.js` dosyasını
 * otomatik bulmaz. Bu dosya olmadan Jest Babel varsayılanına düşer ve
 * TypeScript sözdiziminde (`type X = ...`) "Missing semicolon" hatası verir.
 *
 * Her çalışma alanı kendi projesi olarak tanımlanır; böylece `rootDir` ve
 * `moduleNameMapper` yolları doğru çözülür.
 */
module.exports = {
  // Not: `testTimeout` proje kökünde geçersizdir; her projenin kendi
  // yapılandırmasında tanımlanır (bkz. agent/jest.config.js).
  // Model dosyası gerektiren uçtan uca kontroller burada değil,
  // `scripts/smoke-test.js` içinde yapılır.
  projects: ['<rootDir>/agent/jest.config.js'],
};
