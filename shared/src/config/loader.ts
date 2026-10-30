import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { AgentConfig } from '../types/agent';
import { AgentConfigSchema, AgentConfigSchemaType } from './schema';
import { DEFAULT_AGENT_CONFIG } from './default';

export class ConfigLoader {
  private config: AgentConfig;

  constructor(configPath?: string) {
    this.config = this.loadConfig(configPath);
  }

  private loadConfig(configPath?: string): AgentConfig {
    let userConfig: Partial<AgentConfig> = {};

    if (configPath && existsSync(configPath)) {
      const fileContent = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(fileContent);
      userConfig = parsed;
    } else if (existsSync(join(process.cwd(), 'config.json'))) {
      const fileContent = readFileSync(join(process.cwd(), 'config.json'), 'utf-8');
      const parsed = JSON.parse(fileContent);
      userConfig = parsed;
    }

    const mergedConfig = this.deepMerge(DEFAULT_AGENT_CONFIG, userConfig);
    const validated = AgentConfigSchema.parse(mergedConfig);

    return validated as AgentConfig;
  }

  private deepMerge(target: any, source: any): any {
    if (!target || !source) return target || source;
    const result = { ...target };

    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        const sourceValue = source[key];
        const targetValue = result[key];
        if (
          sourceValue !== undefined &&
          sourceValue !== null &&
          typeof sourceValue === 'object' &&
          !Array.isArray(sourceValue) &&
          targetValue !== undefined &&
          typeof targetValue === 'object' &&
          !Array.isArray(targetValue)
        ) {
          result[key] = this.deepMerge(targetValue, sourceValue);
        } else if (sourceValue !== undefined) {
          result[key] = sourceValue;
        }
      }
    }

    return result;
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  get<T extends keyof AgentConfig>(key: T): AgentConfig[T] {
    return this.config[key];
  }

  updateConfig(updates: Partial<AgentConfig>): void {
    this.config = this.deepMerge(this.config, updates);
    AgentConfigSchema.parse(this.config);
  }
}

export const configLoader = new ConfigLoader();
export const loadConfig = (configPath?: string): AgentConfig => {
  return new ConfigLoader(configPath).getConfig();
};