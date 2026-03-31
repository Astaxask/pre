import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  callModel,
  configureRouter,
  scanForPII,
  resetBudgetTracking,
  getMonthlySpend,
} from './router.js';
import * as ollama from './ollama.js';
import type { ModelRequest } from './types.js';

// Mock the ollama module
vi.mock('./ollama.js', () => ({
  chat: vi.fn(),
  embed: vi.fn(),
  isAvailable: vi.fn(),
}));

// Mock @anthropic-ai/sdk
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'cloud response' }],
          usage: { input_tokens: 50, output_tokens: 30 },
        }),
      };
    },
  };
});

const mockOllamaChat = vi.mocked(ollama.chat);
const mockOllamaAvailable = vi.mocked(ollama.isAvailable);

describe('Model Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBudgetTracking();
    mockOllamaChat.mockResolvedValue({
      content: 'ollama response',
      tokensUsed: 100,
    });
    mockOllamaAvailable.mockResolvedValue(true);
    configureRouter({
      localModel: 'llama3.1:8b',
      cloudEnabled: false,
      monthlyBudgetUsd: 10,
      anthropicApiKey: undefined,
    });
  });

  describe('privacy routing', () => {
    it('privacyLevel=private always routes to Ollama regardless of config', async () => {
      configureRouter({
        cloudEnabled: true,
        anthropicApiKey: 'sk-test',
      });

      const request: ModelRequest = {
        task: 'summarize-event',
        privacyLevel: 'private',
        messages: [{ role: 'user', content: 'summarize this event' }],
      };

      const result = await callModel(request);
      expect(result.routedTo).toBe('ollama');
      expect(mockOllamaChat).toHaveBeenCalled();
    });

    it('privacyLevel=summarizable routes to Ollama', async () => {
      configureRouter({
        cloudEnabled: true,
        anthropicApiKey: 'sk-test',
      });

      const request: ModelRequest = {
        task: 'summarize-event',
        privacyLevel: 'summarizable',
        messages: [{ role: 'user', content: 'summarize this' }],
      };

      const result = await callModel(request);
      expect(result.routedTo).toBe('ollama');
    });

    it('privacyLevel=cloud-safe routes to cloud when enabled', async () => {
      configureRouter({
        cloudEnabled: true,
        anthropicApiKey: 'sk-test',
        monthlyBudgetUsd: 100,
      });

      const request: ModelRequest = {
        task: 'user-conversation',
        privacyLevel: 'cloud-safe',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await callModel(request);
      expect(result.routedTo).toBe('anthropic');
    });

    it('cloud-safe falls back to Ollama when no API key', async () => {
      configureRouter({
        cloudEnabled: true,
        anthropicApiKey: undefined,
      });

      const request: ModelRequest = {
        task: 'user-conversation',
        privacyLevel: 'cloud-safe',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await callModel(request);
      expect(result.routedTo).toBe('ollama');
    });
  });

  describe('PII scanner', () => {
    it('catches dollar amounts', () => {
      const result = scanForPII([
        { role: 'user', content: 'The balance is $1,234.56' },
      ]);
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe('dollar amount');
    });

    it('catches USD amounts', () => {
      const result = scanForPII([
        { role: 'user', content: 'They owe 500 USD' },
      ]);
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe('USD amount');
    });

    it('catches 16-digit card-like numbers', () => {
      const result = scanForPII([
        { role: 'user', content: 'Card: 4111 1111 1111 1111' },
      ]);
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe('16-digit number (possible card)');
    });

    it('passes clean text', () => {
      const result = scanForPII([
        {
          role: 'user',
          content:
            'The user shows a pattern of high financial stress this week',
        },
      ]);
      expect(result).toBeNull();
    });

    it('downgrades to local on PII detection in cloud-safe request', async () => {
      configureRouter({
        cloudEnabled: true,
        anthropicApiKey: 'sk-test',
        monthlyBudgetUsd: 100,
      });

      const request: ModelRequest = {
        task: 'user-conversation',
        privacyLevel: 'cloud-safe',
        messages: [
          { role: 'user', content: 'The balance is $847.00' },
        ],
      };

      const result = await callModel(request);
      expect(result.routedTo).toBe('ollama');
    });
  });

  describe('budget enforcement', () => {
    it('falls back to local when monthly budget is exceeded', async () => {
      configureRouter({
        cloudEnabled: true,
        anthropicApiKey: 'sk-test',
        monthlyBudgetUsd: 0.001, // Tiny budget
      });

      // First call — should go to cloud
      const request: ModelRequest = {
        task: 'user-conversation',
        privacyLevel: 'cloud-safe',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await callModel(request);
      // Cloud call costs tokens * rate = 80 * 0.000015 = 0.0012 > 0.001

      // Second call — budget should be exceeded
      const result2 = await callModel(request);
      expect(result2.routedTo).toBe('ollama');
    });
  });

  describe('Ollama unavailable', () => {
    it('private request throws when Ollama is down', async () => {
      mockOllamaAvailable.mockResolvedValue(false);

      const request: ModelRequest = {
        task: 'summarize-event',
        privacyLevel: 'private',
        messages: [{ role: 'user', content: 'test' }],
      };

      await expect(callModel(request)).rejects.toThrow(
        'Ollama is not available and privacyLevel is private',
      );
    });

    it('private request does NOT fall back to cloud even if cloud is configured', async () => {
      mockOllamaAvailable.mockResolvedValue(false);
      configureRouter({
        cloudEnabled: true,
        anthropicApiKey: 'sk-test',
      });

      const request: ModelRequest = {
        task: 'summarize-event',
        privacyLevel: 'private',
        messages: [{ role: 'user', content: 'test' }],
      };

      await expect(callModel(request)).rejects.toThrow();
    });
  });
});
