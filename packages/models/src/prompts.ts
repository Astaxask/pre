import type { LifeDomain } from '@pre/shared';
import type { Message } from './types.js';

/**
 * Prompt: summarize-event
 *
 * Produces a 1–2 sentence plain-language summary of a LifeEvent
 * suitable for RAG retrieval. Must not include specific numbers or PII.
 */
export function summarizeEvent(input: {
  domain: LifeDomain;
  eventType: string;
  timestamp: number;
}): Message[] {
  const date = new Date(input.timestamp).toISOString().split('T')[0];

  return [
    {
      role: 'system',
      content: [
        'You are a concise summarizer for a personal life-tracking system.',
        'Write a 1–2 sentence summary of the described event.',
        'The summary will be used for semantic search (RAG retrieval).',
        'Rules:',
        '- Do NOT include specific dollar amounts, account numbers, or names.',
        '- Do NOT include PII of any kind.',
        '- Use general language: "a restaurant purchase" not "$47.50 at Chipotle".',
        '- Include the general domain and nature of the event.',
        '- Keep it under 50 words.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Summarize this event: domain="${input.domain}", type="${input.eventType}", date="${date}".`,
    },
  ];
}

/**
 * Prompt: goal-extraction
 *
 * Extracts a structured Goal from user natural language input.
 * Returns a JSON object with title, domain, and optional targetDate.
 */
export function goalExtraction(input: {
  userInput: string;
}): Message[] {
  return [
    {
      role: 'system',
      content: [
        'You extract structured goals from natural language.',
        'Return a JSON object with these fields:',
        '  "title": string — a clear, actionable goal title',
        '  "domain": one of "body", "money", "people", "time", "mind", "world"',
        '  "targetDate": ISO date string or null if not specified',
        'Return ONLY the JSON object, no markdown or explanation.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: input.userInput,
    },
  ];
}
