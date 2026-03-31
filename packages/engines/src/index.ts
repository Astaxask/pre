// Types
export type {
  LifeInsight,
  InsightType,
  InsightPayload,
  TriggerRule,
  TriggerContext,
  Alert,
  AlertSeverity,
  InferenceResult,
  DetectedPattern,
} from './types.js';

// Inference engine
export {
  run as runInference,
  getInsights,
  type InferenceEngineDeps,
} from './inference/inference-engine.js';

// Proactive agent
export { evaluateInsights } from './proactive/proactive-agent.js';
export { evaluate as evaluateRules } from './proactive/rule-evaluator.js';
export { V1_TRIGGER_RULES } from './proactive/rules/index.js';

// Simulation core
export type {
  SimulationRequest,
  SimulationResult,
  SimulationMode,
  SimulationHorizon,
  DecisionDescriptor,
  DecisionType,
  DomainOutcome,
  Distribution,
  DataBasis,
} from './simulation/simulation-types.js';

export {
  runSimulation,
  clearCache as clearSimulationCache,
  type SimulationEngineDeps,
} from './simulation/simulation-engine.js';
