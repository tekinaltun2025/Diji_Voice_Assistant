/**
 * Ajan testleri.
 *
 * Not: Bu testler MODEL DOSYASI GEREKTIRMEZ. Gercek motorlar (Whisper,
 * VITS, Silero) model dosyalari olmadan baslatilamaz; bu yuzden onlarin
 * uctan uca dogrulamasi ayri bir "smoke" betigiyle yapilir
 * (bkz. scripts/smoke-test.js). Buradaki testler saf mantigi kapsar:
 * izin cikarimi, izin kapisi, turn detector, MCP protokol ayristirma.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@diji/shared$': '<rootDir>/../shared/dist/index.js',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
  testTimeout: 15000,
};
