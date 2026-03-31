import type { MemoryReader } from '@pre/memory';
import type { LifeInsight, Alert } from '../types.js';
import { evaluate } from './rule-evaluator.js';
import { V1_TRIGGER_RULES } from './rules/index.js';

type ProactiveAgentDeps = {
  reader: MemoryReader;
  writeTriggerLog: (entry: {
    id: string;
    ruleId: string;
    firedAt: number;
    severity: string;
  }) => void;
};

export async function evaluateInsights(
  insights: LifeInsight[],
  deps: ProactiveAgentDeps,
): Promise<Alert[]> {
  return evaluate(insights, V1_TRIGGER_RULES, deps);
}
