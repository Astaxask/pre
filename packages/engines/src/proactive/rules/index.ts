import type { TriggerRule } from '../../types.js';

// --- V1 rules (statistical pattern-based) ---
import { sleepDebtAccumulating } from './sleep-debt-accumulating.js';
import { financialStressPattern } from './financial-stress-pattern.js';
import { goalDriftWarning } from './goal-drift-warning.js';
import { relationshipSilence } from './relationship-silence.js';
import { overcommitmentAhead } from './overcommitment-ahead.js';
import { energyDecisionMismatch } from './energy-decision-mismatch.js';

// --- V2 rules (Dynamic Insight Composer-powered) ---
import { moneyWasteDetected } from './money-waste-detected.js';
import { burnoutEarlyWarning } from './burnout-early-warning.js';
import { productivityHack } from './productivity-hack.js';
import { selfKnowledgeReveal } from './self-knowledge-reveal.js';
import { healthCrossDomain } from './health-cross-domain.js';
import { predictionAlert } from './prediction-alert.js';

/**
 * All trigger rules, ordered by severity (intervention first).
 * V1 rules fire on statistical patterns from the sidecar.
 * V2 rules fire on dynamic insights from the LLM Composer.
 */
export const V1_TRIGGER_RULES: TriggerRule[] = [
  // Intervention-level
  burnoutEarlyWarning,

  // Warning-level
  sleepDebtAccumulating,
  financialStressPattern,
  overcommitmentAhead,
  energyDecisionMismatch,
  predictionAlert,

  // Info-level
  goalDriftWarning,
  relationshipSilence,
  moneyWasteDetected,
  productivityHack,
  selfKnowledgeReveal,
  healthCrossDomain,
];

export {
  // V1
  sleepDebtAccumulating,
  financialStressPattern,
  goalDriftWarning,
  relationshipSilence,
  overcommitmentAhead,
  energyDecisionMismatch,
  // V2
  moneyWasteDetected,
  burnoutEarlyWarning,
  productivityHack,
  selfKnowledgeReveal,
  healthCrossDomain,
  predictionAlert,
};
