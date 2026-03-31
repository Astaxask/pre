import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelRequest,
  ModelResponse,
  ModelTask,
  Message,
} from './types.js';
import { DEFAULT_MAX_TOKENS, CLOUD_COST_PER_TOKEN_USD } from './types.js';
import * as ollama from './ollama.js';

// ---------------------------------------------------------------------------
// PII Scanner — best-effort patterns for rejecting cloud-bound requests
// ---------------------------------------------------------------------------

type PIIMatch = {
  pattern: string;
  description: string;
};

const PII_PATTERNS: Array<{ regex: RegExp; description: string }> = [
  // Currency: $1,234.56 or 1234.56 USD or amounts with currency symbols
  { regex: /\$\s?\d[\d,]*\.?\d*/g, description: 'dollar amount' },
  { regex: /\d[\d,]*\.?\d*\s?USD/gi, description: 'USD amount' },
  // 16-digit card-like number strings
  { regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, description: '16-digit number (possible card)' },
  // Routing number patterns (9 digits)
  { regex: /\b\d{9}\b/g, description: 'routing number pattern' },
];

export function scanForPII(messages: Message[]): PIIMatch | null {
  for (const msg of messages) {
    for (const { regex, description } of PII_PATTERNS) {
      // Reset regex state for each message
      regex.lastIndex = 0;
      if (regex.test(msg.content)) {
        return { pattern: description, description };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Budget tracking (in-memory, resets on process restart or month change)
// ---------------------------------------------------------------------------

let currentMonthKey = '';
let monthlySpendUsd = 0;

function getMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function trackSpend(costUsd: number): void {
  const key = getMonthKey();
  if (key !== currentMonthKey) {
    currentMonthKey = key;
    monthlySpendUsd = 0;
  }
  monthlySpendUsd += costUsd;
}

export function getMonthlySpend(): number {
  const key = getMonthKey();
  if (key !== currentMonthKey) return 0;
  return monthlySpendUsd;
}

export function resetBudgetTracking(): void {
  currentMonthKey = '';
  monthlySpendUsd = 0;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type RouterConfig = {
  localModel: string;
  cloudEnabled: boolean;
  monthlyBudgetUsd: number;
  anthropicApiKey: string | undefined;
};

let config: RouterConfig = {
  localModel: process.env['PRE_LOCAL_MODEL'] ?? 'llama3.1:8b',
  cloudEnabled: false,
  monthlyBudgetUsd: 10,
  anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
};

export function configureRouter(partial: Partial<RouterConfig>): void {
  config = { ...config, ...partial };
}

// ---------------------------------------------------------------------------
// callModel — the ONLY way to call an LLM in this codebase
// ---------------------------------------------------------------------------

export async function callModel(
  request: ModelRequest,
): Promise<ModelResponse> {
  const maxTokens =
    request.maxTokens ?? DEFAULT_MAX_TOKENS[request.task];
  const temperature = request.temperature ?? 0.3;

  // Route based on privacyLevel
  if (request.privacyLevel === 'private') {
    return routeToOllama(request, maxTokens, temperature);
  }

  if (request.privacyLevel === 'summarizable') {
    // Summarizable: use Ollama for the summarization, result tagged cloud-safe
    return routeToOllama(request, maxTokens, temperature);
  }

  // cloud-safe: try Claude, fall back to Ollama
  return routeToCloud(request, maxTokens, temperature);
}

// ---------------------------------------------------------------------------
// Ollama route
// ---------------------------------------------------------------------------

async function routeToOllama(
  request: ModelRequest,
  maxTokens: number,
  temperature: number,
): Promise<ModelResponse> {
  const available = await ollama.isAvailable();
  if (!available) {
    if (request.privacyLevel === 'private') {
      // NEVER fall back to cloud for private data
      throw new Error(
        'Ollama is not available and privacyLevel is private — cannot route to cloud',
      );
    }
    // For summarizable, also stay local — fail rather than leak
    throw new Error(
      'Ollama is not available for summarizable request — cannot proceed',
    );
  }

  const result = await ollama.chat(config.localModel, request.messages, {
    temperature,
    maxTokens,
  });

  const response: ModelResponse = {
    content: result.content,
    model: config.localModel,
    tokensUsed: result.tokensUsed,
    costUsd: 0, // Local models are free
    routedTo: 'ollama',
  };

  logModelCall(request.task, response);
  return response;
}

// ---------------------------------------------------------------------------
// Cloud (Anthropic) route
// ---------------------------------------------------------------------------

async function routeToCloud(
  request: ModelRequest,
  maxTokens: number,
  temperature: number,
): Promise<ModelResponse> {
  // Check PII before sending to cloud
  const piiMatch = scanForPII(request.messages);
  if (piiMatch) {
    console.warn(
      `[model-router] PII detected in cloud-safe request (task=${request.task}, pattern=${piiMatch.pattern}) — downgrading to local`,
    );
    return routeToOllama(
      { ...request, privacyLevel: 'private' },
      maxTokens,
      temperature,
    );
  }

  // Check budget
  const monthKey = getMonthKey();
  if (monthKey !== currentMonthKey) {
    currentMonthKey = monthKey;
    monthlySpendUsd = 0;
  }
  if (monthlySpendUsd >= config.monthlyBudgetUsd) {
    console.warn(
      `[model-router] Monthly budget exceeded ($${monthlySpendUsd.toFixed(2)} >= $${config.monthlyBudgetUsd}) — falling back to local`,
    );
    return routeToOllama(
      { ...request, privacyLevel: 'private' },
      maxTokens,
      temperature,
    );
  }

  // Check if cloud is enabled and API key is available
  if (!config.cloudEnabled || !config.anthropicApiKey) {
    return routeToOllama(
      { ...request, privacyLevel: 'private' },
      maxTokens,
      temperature,
    );
  }

  try {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });

    // Separate system message from user/assistant messages
    const systemMsg = request.messages.find((m) => m.role === 'system');
    const otherMsgs = request.messages.filter((m) => m.role !== 'system');

    const result = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      temperature,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: otherMsgs.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const content =
      result.content[0]?.type === 'text' ? result.content[0].text : '';
    const tokensUsed =
      (result.usage?.input_tokens ?? 0) +
      (result.usage?.output_tokens ?? 0);
    const costUsd = tokensUsed * CLOUD_COST_PER_TOKEN_USD;

    trackSpend(costUsd);

    const response: ModelResponse = {
      content,
      model: 'claude-sonnet-4-20250514',
      tokensUsed,
      costUsd,
      routedTo: 'anthropic',
    };

    logModelCall(request.task, response);
    return response;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[model-router] Anthropic API failed: ${message} — falling back to local`,
    );
    return routeToOllama(
      { ...request, privacyLevel: 'private' },
      maxTokens,
      temperature,
    );
  }
}

// ---------------------------------------------------------------------------
// Logging (never log message content)
// ---------------------------------------------------------------------------

function logModelCall(task: ModelTask, response: ModelResponse): void {
  console.log(
    `[model-router] task=${task} model=${response.model} tokens=${response.tokensUsed} cost=$${response.costUsd.toFixed(4)} routed=${response.routedTo}`,
  );
}
