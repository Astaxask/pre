import type { PrivacyLevel } from '@pre/shared';

/**
 * All possible LLM task types in the system.
 * Every callModel() must specify one of these.
 */
export type ModelTask =
  | 'summarize-event'
  | 'pattern-analysis'
  | 'proactive-reasoning'
  | 'simulation-narrative'
  | 'user-conversation'
  | 'goal-extraction';

export type Message = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ModelRequest = {
  task: ModelTask;
  privacyLevel: PrivacyLevel;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
};

export type ModelResponse = {
  content: string;
  model: string;
  tokensUsed: number;
  costUsd: number;
  routedTo: 'ollama' | 'anthropic';
};

/**
 * Default maxTokens ceilings per task type.
 */
export const DEFAULT_MAX_TOKENS: Record<ModelTask, number> = {
  'summarize-event': 256,
  'pattern-analysis': 1024,
  'proactive-reasoning': 512,
  'simulation-narrative': 2048,
  'user-conversation': 4096,
  'goal-extraction': 512,
};

/**
 * Approximate per-token cost for cloud models (Claude Sonnet).
 * Input and output averaged for simplicity.
 */
export const CLOUD_COST_PER_TOKEN_USD = 0.000015;
