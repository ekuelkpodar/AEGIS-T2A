import type {
  ActionContext,
  AdapterHealth,
  ExecutionResult,
  SimulationResult,
  ValidationResult,
} from "./types.js";

export interface AdapterPlugin<TConfig, TPayload> {
  readonly name: string;
  connect(config: TConfig): Promise<void>;
  validate(payload: TPayload): Promise<ValidationResult>;
  simulate(payload: TPayload, context: ActionContext): Promise<SimulationResult>;
  execute(payload: TPayload, context: ActionContext): Promise<ExecutionResult>;
  rollback(payload: TPayload, context: ActionContext): Promise<ExecutionResult>;
  healthCheck(): Promise<AdapterHealth>;
}

export abstract class BaseAdapter<TConfig, TPayload> implements AdapterPlugin<TConfig, TPayload> {
  abstract readonly name: string;
  abstract connect(config: TConfig): Promise<void>;
  abstract validate(payload: TPayload): Promise<ValidationResult>;
  abstract simulate(payload: TPayload, context: ActionContext): Promise<SimulationResult>;
  abstract execute(payload: TPayload, context: ActionContext): Promise<ExecutionResult>;
  abstract rollback(payload: TPayload, context: ActionContext): Promise<ExecutionResult>;
  abstract healthCheck(): Promise<AdapterHealth>;
}
