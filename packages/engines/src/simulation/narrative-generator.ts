import { callModel } from '@pre/models';
import type { DomainOutcome, SimulationHorizon } from './simulation-types.js';

const RECOMMENDATION_PATTERNS = [
  /you should/i,
  /I recommend/i,
  /best choice/i,
  /you ought/i,
];

function containsRecommendation(text: string): boolean {
  return RECOMMENDATION_PATTERNS.some((re) => re.test(text));
}

function stripRecommendationSentences(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !RECOMMENDATION_PATTERNS.some((re) => re.test(sentence)))
    .join(' ');
}

export async function generateNarrative(
  outcomes: DomainOutcome[],
  decision: string,
  horizon: SimulationHorizon,
): Promise<string> {
  const outcomesSummary = outcomes
    .map((o) => {
      const direction = o.delta.p50 > 0 ? 'improve' : o.delta.p50 < 0 ? 'decline' : 'remain stable';
      return `${o.domain} (${o.metric}): likely to ${direction}, confidence ${o.confidence.toFixed(1)}, source: ${o.impactSource}`;
    })
    .join('\n');

  const messages = [
    {
      role: 'system' as const,
      content: [
        'You are summarizing the results of a life decision simulation.',
        `The user is considering: ${decision}`,
        `Time horizon: ${horizon}`,
        '',
        'Here are the projected outcomes for each life domain:',
        outcomesSummary,
        '',
        'Write a 3–4 sentence summary that:',
        '1. Names the domains most likely to change significantly',
        '2. Describes the direction of change (better/worse/uncertain)',
        '3. Explicitly mentions uncertainty where confidence is below 0.5',
        '4. Does NOT recommend for or against the decision',
        '5. Does NOT use specific numbers from the simulation (describe directionally)',
        '',
        'End with one sentence naming the assumptions this simulation rests on.',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: 'Generate the narrative summary.',
    },
  ];

  let narrative: string;
  try {
    const response = await callModel({
      task: 'simulation-narrative',
      privacyLevel: 'private',
      messages,
    });
    narrative = response.content;
  } catch {
    // Fallback: generate a template-based narrative
    const significantDomains = outcomes.filter((o) => o.deltaIsSignificant);
    const domainNames = significantDomains.map((o) => o.domain).join(', ');
    return `Based on your historical data, this decision would most likely affect the ${domainNames || 'modeled'} domain(s). Results carry varying degrees of uncertainty — treat wider ranges as less certain. This simulation is based on your personal patterns and general population data where personal history was insufficient.`;
  }

  // Check for recommendation language
  if (containsRecommendation(narrative)) {
    // Retry once
    try {
      const retry = await callModel({
        task: 'simulation-narrative',
        privacyLevel: 'private',
        messages: [
          ...messages,
          { role: 'assistant' as const, content: narrative },
          {
            role: 'user' as const,
            content: 'Your response contains recommendation language. Rewrite without any "you should", "I recommend", "best choice", or "you ought" phrases. Describe consequences only.',
          },
        ],
      });
      narrative = retry.content;
    } catch {
      // Use the stripped version
    }

    // If still present, strip the sentences
    if (containsRecommendation(narrative)) {
      console.warn('[simulation] Narrative still contains recommendation language after retry, stripping');
      narrative = stripRecommendationSentences(narrative);
    }
  }

  return narrative;
}
