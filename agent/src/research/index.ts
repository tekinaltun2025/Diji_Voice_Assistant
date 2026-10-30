import {
  ResearchTask,
  ResearchResult,
  ResearchSource,
  ResearchConfig,
  ResearchStatus,
  ResearchPriority,
  ResearchWorkerRequest,
  ResearchWorkerResponse,
} from './types';
import { ResearchQueue, createResearchQueue } from './queue';
import { ResearchWorker, createResearchWorker } from './worker';
import { QueryClassifier, createQueryClassifier, ClassificationResult } from './detector';
import { ResearchNotifier, createResearchNotifier } from './notifier';

export {
  ResearchTask,
  ResearchResult,
  ResearchSource,
  ResearchConfig,
  ResearchStatus,
  ResearchPriority,
  ResearchWorkerRequest,
  ResearchWorkerResponse,
  ClassificationResult,
};
export { ResearchQueue, createResearchQueue };
export { ResearchWorker, createResearchWorker };
export { QueryClassifier, createQueryClassifier };
export { ResearchNotifier, createResearchNotifier };

/**
 * Research modulu icin varsayilan yapilandirma.
 *
 * LLM, surekli ayakta olan yerel OpenAI uyumlu yonlendiriciyi kullanir.
 * Degerler ortam degiskenleriyle gecersiz kilinabilir; ana ajan
 * yapilandirmasiyla (`DIJI_LLM_*`) ayni kaynagi paylasir.
 */
export const DEFAULT_RESEARCH_CONFIG: ResearchConfig = {
  llmModel: process.env.DIJI_LLM_MODEL || 'agent',
  llmBaseUrl: process.env.DIJI_LLM_BASE_URL || 'http://127.0.0.1:8000/v1',
  temperature: Number(process.env.DIJI_RESEARCH_TEMPERATURE || 0.7),
  maxTokens: Number(process.env.DIJI_RESEARCH_MAX_TOKENS || 4096),
  timeout: Number(process.env.DIJI_RESEARCH_TIMEOUT_MS || 300000),
  maxSteps: Number(process.env.DIJI_RESEARCH_MAX_STEPS || 10),
};

/**
 * Research modülünü başlatır ve gerekli bileşenleri döner.
 */
export function createResearchModule(llmEngine: any, mcpClient?: any) {
  const queue = createResearchQueue();
  const notifier = createResearchNotifier();
  const classifier = createQueryClassifier(false, llmEngine);
  const worker = createResearchWorker(queue, llmEngine, DEFAULT_RESEARCH_CONFIG, mcpClient);

  return {
    queue,
    notifier,
    classifier,
    worker,
    config: DEFAULT_RESEARCH_CONFIG,
  };
}