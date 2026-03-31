import type { TriggerRule } from '../../types.js';
import { sleepDebtAccumulating } from './sleep-debt-accumulating.js';
import { financialStressPattern } from './financial-stress-pattern.js';
import { goalDriftWarning } from './goal-drift-warning.js';
import { relationshipSilence } from './relationship-silence.js';
import { overcommitmentAhead } from './overcommitment-ahead.js';
import { energyDecisionMismatch } from './energy-decision-mismatch.js';

export const V1_TRIGGER_RULES: TriggerRule[] = [
  sleepDebtAccumulating,
  financialStressPattern,
  goalDriftWarning,
  relationshipSilence,
  overcommitmentAhead,
  energyDecisionMismatch,
];

export {
  sleepDebtAccumulating,
  financialStressPattern,
  goalDriftWarning,
  relationshipSilence,
  overcommitmentAhead,
  energyDecisionMismatch,
};
