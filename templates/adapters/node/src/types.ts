export type AdapterMode = "sandbox" | "production";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface SimulationResult {
  accepted: boolean;
  estimatedDurationSeconds: number;
  estimatedCostUsd: number;
  warnings: string[];
  outputPreview: Record<string, unknown>;
}

export interface ExecutionResult {
  success: boolean;
  providerRequestId?: string;
  output: Record<string, unknown>;
  error?: string;
}

export interface AdapterHealth {
  status: "healthy" | "degraded" | "unhealthy";
  details: Record<string, unknown>;
}

export interface ActionContext {
  tenantId: string;
  correlationId: string;
  actorId: string;
  mode: AdapterMode;
}
