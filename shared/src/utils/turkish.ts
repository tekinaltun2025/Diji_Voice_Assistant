/**
 * Türkçe karakterleri İngilizce karakterlere dönüştürür (dosya adı, slug vb. için)
 */
export const turkishToAscii = (text: string): string => {
  const map: Record<string, string> = {
    ç: 'c',
    ğ: 'g',
    ı: 'i',
    ö: 'o',
    ş: 's',
    ü: 'u',
    Ç: 'C',
    Ğ: 'G',
    İ: 'I',
    Ö: 'O',
    Ş: 'S',
    Ü: 'U',
  };
  return text.replace(/[çğıöşüÇĞİÖŞÜ]/g, (char) => map[char] || char);
};

/**
 * Türkçe başlık/başlık metni oluşturur
 */
export const turkishTitleCase = (text: string): string => {
  return text
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

/**
 * Türkçe hata mesajı öneki
 */
export const turkishErrorPrefix = (error: Error | string): string => {
  const message = error instanceof Error ? error.message : error;
  return `Hata: ${message}`;
};