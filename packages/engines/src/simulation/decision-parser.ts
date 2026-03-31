import { callModel } from '@pre/models';
import type { Goal } from '@pre/memory';
import type { DecisionDescriptor, SimulationHorizon } from './simulation-types.js';
import { decisionDescriptorSchema } from './simulation-types.js';
import type { Result } from '@pre/shared';
import { ok, err } from '@pre/shared';

export async function parseDecision(
  raw: string,
  horizon: SimulationHorizon,
  activeGoals: Goal[],
): Promise<Result<DecisionDescriptor, string>> {
  const goalContext = activeGoals.length > 0
    ? `Active goals: ${activeGoals.map((g) => `${g.domain} - ${g.title}`).join('; ')}`
    : 'No active goals.';

  const response = await callModel({
    task: 'proactive-reasoning',
    privacyLevel: 'private',
    messages: [
      {
        role: 'system',
        content: [
          'You parse natural-language decisions into structured descriptors.',
          'Decision types: job-change, financial-major, habit-add, habit-remove, relationship-change, location-change, time-commitment, health-intervention.',
          'Domains: body, money, people, time, mind, world.',
          'Output ONLY valid JSON matching this schema:',
          '{"raw": string, "decisionType": string, "affectedDomains": string[], "horizon": string, "keyVariables": [{name,value,unit?}], "confidence": 0-1, "parserWarnings": string[]}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `Decision: "${raw}"\nHorizon: ${horizon}\n${goalContext}\n\nParse this into a DecisionDescriptor JSON object.`,
      },
    ],
  });

  try {
    // Try to extract JSON from the response
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return err('No JSON found in parser response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    parsed['raw'] = raw;
    parsed['horizon'] = horizon;

    const validated = decisionDescriptorSchema.parse(parsed);

    if (validated.confidence < 0.5) {
      return err(`Parser confidence too low: ${validated.confidence}. ${validated.parserWarnings.join('. ')}`);
    }

    return ok(validated);
  } catch (e) {
    return err(`Failed to parse decision: ${e instanceof Error ? e.message : String(e)}`);
  }
}
