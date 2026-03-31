import type { Message } from './types.js';

const OLLAMA_BASE_URL = process.env['OLLAMA_URL'] ?? 'http://localhost:11434';

type OllamaChatResponse = {
  message: { role: string; content: string };
  eval_count?: number;
  prompt_eval_count?: number;
};

type OllamaEmbedResponse = {
  embeddings: number[][];
};

/**
 * Thin typed wrapper around the Ollama HTTP API.
 * No npm package needed — raw fetch only.
 */
export async function chat(
  model: string,
  messages: Message[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<{ content: string; tokensUsed: number }> {
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    options: {
      ...(options?.temperature !== undefined && {
        temperature: options.temperature,
      }),
      ...(options?.maxTokens !== undefined && {
        num_predict: options.maxTokens,
      }),
    },
  };

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama chat failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as OllamaChatResponse;
  const tokensUsed =
    (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0);

  return { content: data.message.content, tokensUsed };
}

export async function embed(
  model: string,
  text: string,
): Promise<number[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama embed failed (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as OllamaEmbedResponse;
  return data.embeddings[0]!;
}

export async function isAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
