/**
 * AEGIS-T2A Core Types
 *
 * Foundational types for the Text-to-Action Anywhere platform.
 * All components depend on these type definitions.
 */

import { z } from 'zod';

// =============================================================================
// Enums and Constants
// =============================================================================

export const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  DESTRUCTIVE: 'destructive',
} as const;

export type RiskLevel = typeof RiskLevel[keyof typeof RiskLevel];

export const Sensitivity = {
  PUBLIC: 'public',
  INTERNAL: 'internal',
  CONFIDENTIAL: 'confidential',
  RESTRICTED: 'restricted',
} as const;

export type Sensitivity = typeof Sensitivity[keyof typeof Sensitivity];

export const StepStatus = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  COMPENSATING: 'compensating',
  COMPENSATED: 'compensated',
  SKIPPED: 'skipped',
} as const;

export type StepStatus = typeof StepStatus[keyof typeof StepStatus];

export const WorkflowStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  AWAITING_APPROVAL: 'awaiting_approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  COMPENSATING: 'compensating',
  CANCELLED: 'cancelled',
} as const;

export type WorkflowStatus = typeof WorkflowStatus[keyof typeof WorkflowStatus];

export const ApprovalDecision = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
  DELEGATED: 'delegated',
  TIMEOUT: 'timeout',
} as const;

export type ApprovalDecision = typeof ApprovalDecision[keyof typeof ApprovalDecision];

export const ActorType = {
  USER: 'user',
  AGENT: 'agent',
  SYSTEM: 'system',
} as const;

export type ActorType = typeof ActorType[keyof typeof ActorType];

export const EventType = {
  INTENT_CREATED: 'intent_created',
  INTENT_VALIDATED: 'intent_validated',
  INTENT_REJECTED: 'intent_rejected',
  PLAN_GENERATED: 'plan_generated',
  PLAN_VALIDATED: 'plan_validated',
  SIMULATION_STARTED: 'simulation_started',
  SIMULATION_COMPLETED: 'simulation_completed',
  APPROVAL_REQUESTED: 'approval_requested',
  APPROVAL_GRANTED: 'approval_granted',
  APPROVAL_DENIED: 'approval_denied',
  WORKFLOW_STARTED: 'workflow_started',
  WORKFLOW_PAUSED: 'workflow_paused',
  WORKFLOW_RESUMED: 'workflow_resumed',
  WORKFLOW_COMPLETED: 'workflow_completed',
  WORKFLOW_FAILED: 'workflow_failed',
  STEP_STARTED: 'step_started',
  STEP_COMPLETED: 'step_completed',
  STEP_FAILED: 'step_failed',
  COMPENSATION_STARTED: 'compensation_started',
  COMPENSATION_COMPLETED: 'compensation_completed',
  COMPENSATION_FAILED: 'compensation_failed',
  SECRET_ISSUED: 'secret_issued',
  SECRET_REVOKED: 'secret_revoked',
  POLICY_VIOLATION: 'policy_violation',
  ANOMALY_DETECTED: 'anomaly_detected',
} as const;

export type EventType = typeof EventType[keyof typeof EventType];

// =============================================================================
// Zod Schemas
// =============================================================================

export const BudgetSchema = z.object({
  currency: z.string().default('USD'),
  limit: z.number().positive(),
  spent: z.number().min(0).default(0),
});

export const ResourceRequirementSchema = z.object({
  type: z.string(),
  cpu: z.number().optional(),
  memoryMb: z.number().optional(),
  storageGb: z.number().optional(),
  region: z.string().optional(),
});

export const TypedIntentSchema = z.object({
  intentId: z.string().uuid(),
  userId: z.string().uuid(),
  timestamp: z.string().datetime(),
  nlText: z.string().min(1),
  actionType: z.string(),
  riskLevel: z.enum(['low', 'medium', 'high', 'destructive']),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
  budget: BudgetSchema,
  requiredCapabilities: z.array(z.string()),
  requiredInfra: z.array(ResourceRequirementSchema).optional(),
  sideEffect: z.boolean(),
  idempotencyKey: z.string(),
  policyStatus: z.enum(['pending', 'approved', 'denied']).default('pending'),
  approvalRequired: z.boolean(),
  confidence: z.number().min(0).max(1),
  metadata: z.record(z.unknown()).optional(),
});

export const CompensationActionSchema = z.object({
  action: z.string(),
  toolAdapter: z.string(),
  parameters: z.record(z.unknown()),
  idempotencyKey: z.string(),
  timeout: z.number().optional(),
});

export const PlanStepSchema = z.object({
  stepId: z.string().uuid(),
  planId: z.string().uuid(),
  sequenceNumber: z.number().int().min(0),
  action: z.string(),
  description: z.string(),
  toolAdapter: z.string(),
  parameters: z.record(z.unknown()),
  targetResource: z.string().optional(),
  sideEffect: z.boolean(),
  compensationAction: CompensationActionSchema.optional(),
  dependencies: z.array(z.string().uuid()),
  requiredCapabilities: z.array(z.string()),
  idempotencyKey: z.string(),
  estimatedCost: z.number().min(0),
  estimatedDuration: z.number().int().min(0),
  riskLevel: z.enum(['low', 'medium', 'high', 'destructive']),
  approvalRequired: z.boolean(),
  timeout: z.number().int().positive().default(60000),
  retryPolicy: z.object({
    maxRetries: z.number().int().min(0).default(3),
    backoffMs: z.number().int().min(0).default(1000),
    backoffMultiplier: z.number().min(1).default(2),
  }).optional(),
});

export const PlanManifestSchema = z.object({
  planId: z.string().uuid(),
  intentId: z.string().uuid(),
  version: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  steps: z.array(PlanStepSchema),
  totalEstimatedCost: z.number().min(0),
  totalEstimatedDuration: z.number().int().min(0),
  riskLevel: z.enum(['low', 'medium', 'high', 'destructive']),
  approvalRequired: z.boolean(),
  checksum: z.string(),
  signature: z.string().optional(),
});

export const SimulationResultSchema = z.object({
  simulationId: z.string().uuid(),
  planId: z.string().uuid(),
  timestamp: z.string().datetime(),
  status: z.enum(['success', 'partial_fail', 'fail']),
  blastRadius: z.enum(['low', 'medium', 'high']),
  riskScore: z.number().min(0).max(100),
  estimatedCost: z.number().min(0),
  anomalies: z.array(z.string()),
  stepResults: z.array(z.object({
    stepId: z.string().uuid(),
    status: z.enum(['success', 'fail', 'skipped']),
    outputs: z.record(z.unknown()).optional(),
    error: z.string().optional(),
  })),
  humanReviewRequired: z.boolean(),
  recommendations: z.array(z.string()),
});

export const ApprovalRecordSchema = z.object({
  approvalId: z.string().uuid(),
  workflowId: z.string().uuid(),
  stepId: z.string().uuid().optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'destructive']),
  approverId: z.string().uuid(),
  approverIdentity: z.object({
    email: z.string().email(),
    mfaMethod: z.enum(['totp', 'webauthn', 'sms', 'none']),
    mfaVerified: z.boolean(),
  }),
  decision: z.enum(['approved', 'rejected', 'delegated', 'timeout']),
  rationale: z.string().optional(),
  modifications: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime(),
  signature: z.string(),
  previousApprovalHash: z.string().optional(),
});

export const WorkflowStateSchema = z.object({
  workflowId: z.string().uuid(),
  intentId: z.string().uuid(),
  planId: z.string().uuid(),
  planVersion: z.number().int().min(1),
  status: z.enum([
    'pending', 'running', 'paused', 'awaiting_approval',
    'completed', 'failed', 'compensating', 'cancelled'
  ]),
  currentStepId: z.string().uuid().optional(),
  completedSteps: z.array(z.string().uuid()),
  failedSteps: z.array(z.string().uuid()),
  compensationStack: z.array(z.object({
    stepId: z.string().uuid(),
    compensationAction: CompensationActionSchema,
    executedAt: z.string().datetime().optional(),
    outputs: z.record(z.unknown()).optional(),
  })),
  checkpointData: z.record(z.unknown()).optional(),
  approvalRequired: z.boolean(),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

export const AuditEventSchema = z.object({
  eventId: z.string().uuid(),
  timestamp: z.string().datetime(),
  eventType: z.string(),
  intentId: z.string().uuid().optional(),
  planId: z.string().uuid().optional(),
  planVersion: z.number().int().optional(),
  stepId: z.string().uuid().optional(),
  workflowId: z.string().uuid().optional(),
  actorId: z.string().uuid(),
  actorType: z.enum(['user', 'agent', 'system']),
  actorSpiffeId: z.string().optional(),
  parentSpiffeId: z.string().optional(),
  svidSerialNumber: z.string().optional(),
  action: z.string(),
  targetResource: z.string().optional(),
  inputsHash: z.string(),
  outputsHash: z.string().optional(),
  success: z.boolean(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'destructive']).optional(),
  costIncurred: z.number().optional(),
  durationMs: z.number().int().optional(),
  signature: z.string(),
  previousEventHash: z.string(),
});

export const ToolAdapterSchema = z.object({
  adapterId: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  capabilities: z.array(z.string()),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()),
  sideEffects: z.boolean(),
  compensationSupported: z.boolean(),
  riskLevel: z.enum(['low', 'medium', 'high', 'destructive']),
  timeout: z.number().int().positive().default(30000),
  rateLimits: z.object({
    requestsPerMinute: z.number().int().positive(),
    burstLimit: z.number().int().positive(),
  }).optional(),
  sbomHash: z.string().optional(),
  signature: z.string().optional(),
});

export const EphemeralCredentialSchema = z.object({
  credentialId: z.string().uuid(),
  workflowId: z.string().uuid(),
  stepId: z.string().uuid(),
  scope: z.array(z.string()),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: z.string(),
  signature: z.string(),
});

export const PolicyRuleSchema = z.object({
  ruleId: z.string(),
  name: z.string(),
  description: z.string(),
  condition: z.string(),
  action: z.enum(['allow', 'deny', 'require_approval']),
  riskLevel: z.enum(['low', 'medium', 'high', 'destructive']).optional(),
  priority: z.number().int(),
  enabled: z.boolean().default(true),
});

// =============================================================================
// Type Exports (inferred from schemas)
// =============================================================================

export type Budget = z.infer<typeof BudgetSchema>;
export type ResourceRequirement = z.infer<typeof ResourceRequirementSchema>;
export type TypedIntent = z.infer<typeof TypedIntentSchema>;
export type CompensationAction = z.infer<typeof CompensationActionSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanManifest = z.infer<typeof PlanManifestSchema>;
export type SimulationResult = z.infer<typeof SimulationResultSchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type ToolAdapter = z.infer<typeof ToolAdapterSchema>;
export type EphemeralCredential = z.infer<typeof EphemeralCredentialSchema>;
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

// =============================================================================
// Utility Types
// =============================================================================

export interface Result<T, E = Error> {
  success: boolean;
  data?: T;
  error?: E;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: Record<string, {
    status: 'healthy' | 'degraded' | 'unhealthy';
    latencyMs?: number;
    message?: string;
  }>;
  timestamp: string;
}

export interface StepExecutionResult {
  stepId: string;
  status: StepStatus;
  outputs: Record<string, unknown>;
  error?: string;
  durationMs: number;
  costIncurred: number;
}

export interface WorkflowExecutionContext {
  workflowId: string;
  intentId: string;
  planId: string;
  userId: string;
  variables: Record<string, unknown>;
  secrets: Map<string, string>;
}
