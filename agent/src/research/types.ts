import { MCPTool } from '@diji/shared';

/**
 * Araştırma görevinin durumu
 */
export type ResearchStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

/**
 * Araştırma görevinin önceliği
 */
export type ResearchPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * Araştırma görevi tanımı
 */
export interface ResearchTask {
  id: string;
  userId: string;
  sessionId: string;
  query: string;
  status: ResearchStatus;
  priority: ResearchPriority;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  progress: number; // 0-100
  result?: ResearchResult;
  mcpToolsUsed?: string[];
}

/**
 * Araştırma sonucu
 */
export interface ResearchResult {
  taskId: string;
  summary: string;
  details: string;
  sources: ResearchSource[];
  mcpToolResults?: Record<string, unknown>;
  generatedAt: Date;
}

/**
 * Araştırma kaynağı
 */
export interface ResearchSource {
  name: string;
  url?: string;
  type: 'web' | 'email' | 'calendar' | 'drive' | 'notion' | 'slack' | 'chrome' | 'mcp';
  relevance: number; // 0-1
  snippet?: string;
}

/**
 * Araştırma yapılandırma seçenekleri
 */
export interface ResearchConfig {
  llmModel: string;
  llmBaseUrl: string;
  temperature: number;
  maxTokens: number;
  timeout: number; // ms
  maxSteps: number; // MCP tool çağrısı adım sayısı
}

/**
 * Araştırma worker istemi
 */
export interface ResearchWorkerRequest {
  task: ResearchTask;
  mcpTools: MCPTool[];
  config: ResearchConfig;
}

/**
 * Araştırma worker yanıtı
 */
export interface ResearchWorkerResponse {
  taskId: string;
  success: boolean;
  result?: ResearchResult;
  error?: string;
}