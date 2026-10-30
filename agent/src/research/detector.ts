import { LLMEngine, LLMMessage, LLMResponse } from '../llm';
import { logInfo, logDebug, logWarn } from '@diji/shared';

/**
 * Sorgu sınıflandırma sonucu.
 */
export interface ClassificationResult {
  type: 'quick' | 'heavy';
  confidence: number; // 0-1
  reason: string;
  keywords: string[];
}

/**
 * Ağır araştırma için anahtar kelime listesi (Türkçe).
 */
const HEAVY_RESEARCH_KEYWORDS = [
  'araştır',
  'derinlemesine',
  'kapsamlı',
  'detaylı',
  'rapor',
  'analiz',
  'karşılaştır',
  'değerlendir',
  'incele',
  'etüd',
  'inceleme',
  'gelişmiş',
  'geliştirmeli',
  'kapsayan',
  'bir araya getir',
  'sentezle',
  'kapsamlı araştırma',
  'derinlemesine araştırma',
  'ayrıntılı araştırma',
  'kapsamlı bir',
  'bir rapor hazırla',
  'bir analiz yap',
  'karşılaştırmalı',
  'kapsamlı inceleme',
  'detaylı analiz',
  'ayrıntılı analiz',
  'kapsamlı değerlendirme',
  'ayrıntılı değerlendirme',
];

/**
 * Hızlı yanıt için anahtar kelime listesi (Türkçe).
 */
const QUICK_RESPONSE_KEYWORDS = [
  'merhaba',
  'selam',
  'nasılsın',
  'saat',
  'hava',
  'teşekkür',
  'görüşürüz',
  'hoşça kal',
  'yardım',
  'ne demek',
  'nedir',
  'hangi',
  'ne zaman',
  'nerede',
  'kim',
  'naber',
  'iyi misin',
];

/**
 * Sorgu sınıflandırıcı: "hızlı" vs "ağır araştırma" tespiti.
 * İkincil olarak LLM tabanlı sınıflandırma da destekler.
 */
export class QueryClassifier {
  private llmEngine: LLMEngine | null = null;
  private useLLMClassification: boolean = false;
  private llmModel: string = process.env.DIJI_LLM_MODEL || 'agent';
  private llmBaseUrl: string =
    process.env.DIJI_LLM_BASE_URL || 'http://127.0.0.1:8000/v1';

  constructor(useLLMClassification: boolean = false, llmEngine?: LLMEngine) {
    this.useLLMClassification = useLLMClassification;
    this.llmEngine = llmEngine || null;
  }

  /**
   * LLM motorunu ayarlar (opsiyonel LLM tabanlı sınıflandırma için).
   */
  setLLMEngine(llmEngine: LLMEngine): void {
    this.llmEngine = llmEngine;
    this.useLLMClassification = true;
    logInfo('QueryClassifier LLM motoruna bağlandı');
  }

  /**
   * Sorguyu sınıflandırır: hızlı yanıt mı yoksa ağır araştırma mı?
   */
  async classify(query: string): Promise<ClassificationResult> {
    // 1. Adım: Anahtar kelime tabanlı ön sınıflandırma
    const keywordResult = this.classifyByKeywords(query);

    // 2. Adım: LLM ile sınıflandırma (etkinse ve keyword ile netleşmezse)
    if (this.useLLMClassification && this.llmEngine && keywordResult.confidence < 0.7) {
      const llmResult = await this.classifyByLLM(query);
      // LLM sonucu daha güvenilirse onu kullan
      if (llmResult.confidence > keywordResult.confidence) {
        return llmResult;
      }
    }

    return keywordResult;
  }

  /**
   * Anahtar kelime tabanlı sınıflandırma.
   */
  private classifyByKeywords(query: string): ClassificationResult {
    const normalizedQuery = query.toLowerCase().trim();

    let heavyMatches: string[] = [];
    let quickMatches: string[] = [];

    for (const keyword of HEAVY_RESEARCH_KEYWORDS) {
      if (normalizedQuery.includes(keyword.toLowerCase())) {
        heavyMatches.push(keyword);
      }
    }

    for (const keyword of QUICK_RESPONSE_KEYWORDS) {
      if (normalizedQuery.includes(keyword.toLowerCase())) {
        quickMatches.push(keyword);
      }
    }

    // Ağır araştırma anahtar kelimesi varsa ağır olarak işaretle
    if (heavyMatches.length > 0 && quickMatches.length === 0) {
      const confidence = Math.min(0.9, 0.5 + heavyMatches.length * 0.1);
      return {
        type: 'heavy',
        confidence,
        reason: `Ağır araştırma anahtar kelimesi tespit edildi: ${heavyMatches.join(', ')}`,
        keywords: heavyMatches,
      };
    }

    // Hızlı yanıt anahtar kelimesi varsa ve ağır yoksa hızlı
    if (quickMatches.length > 0 && heavyMatches.length === 0) {
      const confidence = Math.min(0.9, 0.5 + quickMatches.length * 0.1);
      return {
        type: 'quick',
        confidence,
        reason: `Hızlı yanıt anahtar kelimesi tespit edildi: ${quickMatches.join(', ')}`,
        keywords: quickMatches,
      };
    }

    // Her ikisi de varsa veya hiçbiri yoksa: sorgu uzunluğuna bak
    const words = normalizedQuery.split(/\s+/).filter((w) => w.length > 0);
    const wordCount = words.length;

    if (wordCount >= 15) {
      return {
        type: 'heavy',
        confidence: 0.6,
        reason: `Uzun sorgu (${wordCount} kelime), ağır araştırma olarak sınıflandırıldı`,
        keywords: [],
      };
    }

    if (wordCount <= 5) {
      return {
        type: 'quick',
        confidence: 0.6,
        reason: `Kısa sorgu (${wordCount} kelime), hızlı yanıt olarak sınıflandırıldı`,
        keywords: [],
      };
    }

    // Varsayılan: hızlı (responsive kalmak için)
    return {
      type: 'quick',
      confidence: 0.5,
      reason: 'Belirgin anahtar kelime yok, varsayılan hızlı yanıt',
      keywords: [],
    };
  }

  /**
   * LLM tabanlı sınıflandırma (daha hassas).
   */
  private async classifyByLLM(query: string): Promise<ClassificationResult> {
    if (!this.llmEngine) {
      return this.classifyByKeywords(query);
    }

    const systemPrompt = `Sen Diji'nin sorgu sınıflandırma asistanısın. Kullanıcının sorgusunu "hızlı" veya "ağır araştırma" olarak sınıflandıracaksın.

KURALLAR:
1. Daima Türkçe yanıt ver
2. Sadece JSON formatında yanıt ver
3. "hızlı": selamlaşma, kısa bilgi sorusu, basit komut, tek kelime cümle
4. "ağır araştırma": derinlemesine analiz, karşılaştırma, rapor, kapsamlı inceleme, birden fazla kaynak gerektiren soru

JSON ŞEMASI:
{
  "type": "hızlı" | "ağır araştırma",
  "confidence": 0.0-1.0,
  "reason": "sınıflandırma nedeni (Türkçe)",
  "keywords": ["anahtar kelime1", "anahtar kelime2"]
}

Kullanıcı sorgusu: ${query}`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ];

    try {
      const response: LLMResponse = await this.llmEngine.generateResponse(
        messages,
        undefined,
        systemPrompt
      );

      const result = JSON.parse(response.content) as {
        type: 'hızlı' | 'ağır araştırma';
        confidence: number;
        reason: string;
        keywords: string[];
      };

      return {
        type: result.type === 'ağır araştırma' ? 'heavy' : 'quick',
        confidence: Math.max(0, Math.min(1, result.confidence)),
        reason: result.reason,
        keywords: result.keywords || [],
      };
    } catch (error) {
      logWarn('LLM sınıflandırma başarısız, anahtar kelime yöntemine geçiliyor', {
        error: (error as Error).message,
      });
      return this.classifyByKeywords(query);
    }
  }

  /**
   * Belirli bir sorgu için ağır araştırma mı gerekli olduğunu döner (basit boolean).
   */
  async isHeavyResearch(query: string): Promise<boolean> {
    const result = await this.classify(query);
    return result.type === 'heavy';
  }
}

export const createQueryClassifier = (
  useLLMClassification?: boolean,
  llmEngine?: LLMEngine
): QueryClassifier => {
  return new QueryClassifier(useLLMClassification ?? false, llmEngine);
};