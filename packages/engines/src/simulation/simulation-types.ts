import { z } from 'zod';
import type { LifeDomain } from '@pre/shared';

export type DecisionType =
  | 'job-change'
  | 'financial-major'
  | 'habit-add'
  | 'habit-remove'
  | 'relationship-change'
  | 'location-change'
  | 'time-commitment'
  | 'health-intervention';

export type SimulationHorizon = '30d' | '90d' | '180d';
export type SimulationMode = 'disabled' | 'shallow' | 'standard' | 'deep' | 'full';

export type KeyVariable = {
  name: string;
  value: string;
  unit?: string;
};

export type DecisionDescriptor = {
  raw: string;
  decisionType: DecisionType;
  affectedDomains: LifeDomain[];
  horizon: SimulationHorizon;
  keyVariables: KeyVariable[];
  confidence: number;
  parserWarnings: string[];
};

export const decisionDescriptorSchema = z.object({
  raw: z.string(),
  decisionType: z.enum([
    'job-change', 'financial-major', 'habit-add', 'habit-remove',
    'relationship-change', 'location-change', 'time-commitment', 'health-intervention',
  ]),
  affectedDomains: z.array(z.enum(['body', 'money', 'people', 'time', 'mind', 'world'])),
  horizon: z.enum(['30d', '90d', '180d']),
  keyVariables: z.array(z.object({
    name: z.string(),
    value: z.string(),
    unit: z.string().optional(),
  })),
  confidence: z.number(),
  parserWarnings: z.array(z.string()),
});

export type Distribution = {
  p10: number;
  p50: number;
  p90: number;
  unit: string;
};

export type DomainOutcome = {
  domain: LifeDomain;
  metric: string;
  unit: string;
  baseline: Distribution;
  projected: Distribution;
  delta: Distribution;
  deltaIsSignificant: boolean;
  confidence: number;
  impactSource: 'empirical' | 'generic-prior';
  analogCount: number;
};

export type DataBasis = {
  domain: LifeDomain;
  eventsAnalyzed: number;
  daysCovered: number;
  oldestEventTs: number;
};

export type SimulationResult = {
  requestId: string;
  decision: string;
  decisionType: DecisionType;
  horizon: SimulationHorizon;
  simulationMode: SimulationMode;
  generatedAt: number;
  outcomes: DomainOutcome[];
  narrative: string;
  assumptions: string[];
  dataBasis: DataBasis[];
  overallConfidence: number;
  hasGenericPriors: boolean;
  genericPriorDomains: string[];
};

export type SimulationRequest = {
  decision: string;
  horizon: SimulationHorizon;
  domains: LifeDomain[];
};
