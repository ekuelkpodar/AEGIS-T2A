import { randomUUID } from "node:crypto";

import { BaseAdapter } from "./base.js";
import type {
  ActionContext,
  AdapterHealth,
  ExecutionResult,
  SimulationResult,
  ValidationResult,
} from "./types.js";

export interface TwilioConfig {
  accountSid: string;
  authTokenRef: string;
  fromPhone: string;
}

export interface TwilioDispatchPayload {
  toPhone: string;
  message: string;
  routeId?: string;
  metadata?: Record<string, unknown>;
}

export class SimulatedTwilioAdapter extends BaseAdapter<TwilioConfig, TwilioDispatchPayload> {
  readonly name = "twilio-simulated";

  private connected = false;
  private config?: TwilioConfig;

  async connect(config: TwilioConfig): Promise<void> {
    if (!config.accountSid || !config.authTokenRef || !config.fromPhone) {
      throw new Error("Missing required Twilio config fields");
    }

    this.config = config;
    this.connected = true;
  }

  async validate(payload: TwilioDispatchPayload): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!payload.toPhone || payload.toPhone.length < 8) {
      errors.push("toPhone is required and must be a valid E.164-like value");
    }
    if (!payload.message || payload.message.trim().length < 3) {
      errors.push("message is required");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  async simulate(payload: TwilioDispatchPayload, context: ActionContext): Promise<SimulationResult> {
    const validation = await this.validate(payload);
    if (!validation.valid) {
      return {
        accepted: false,
        estimatedDurationSeconds: 0,
        estimatedCostUsd: 0,
        warnings: validation.errors,
        outputPreview: {},
      };
    }

    const cost = Math.min(0.01 + payload.message.length * 0.0001, 0.08);

    return {
      accepted: true,
      estimatedDurationSeconds: 2,
      estimatedCostUsd: Number(cost.toFixed(4)),
      warnings: context.mode === "sandbox" ? ["Sandbox mode: no provider call will be made"] : [],
      outputPreview: {
        to: payload.toPhone,
        from: this.config?.fromPhone,
        routeId: payload.routeId,
        messageLength: payload.message.length,
      },
    };
  }

  async execute(payload: TwilioDispatchPayload, context: ActionContext): Promise<ExecutionResult> {
    if (!this.connected || !this.config) {
      return {
        success: false,
        error: "Adapter not connected",
        output: {},
      };
    }

    const validation = await this.validate(payload);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.errors.join("; "),
        output: {},
      };
    }

    if (context.mode === "sandbox") {
      return {
        success: true,
        providerRequestId: `sandbox-${randomUUID()}`,
        output: {
          simulated: true,
          to: payload.toPhone,
          from: this.config.fromPhone,
          message: payload.message,
        },
      };
    }

    // Replace with real Twilio API call in production adapter.
    return {
      success: true,
      providerRequestId: `twilio-${randomUUID()}`,
      output: {
        delivered: true,
        to: payload.toPhone,
        from: this.config.fromPhone,
      },
    };
  }

  async rollback(payload: TwilioDispatchPayload, context: ActionContext): Promise<ExecutionResult> {
    return {
      success: true,
      providerRequestId: `rollback-${randomUUID()}`,
      output: {
        action: "send_compensation_message",
        to: payload.toPhone,
        correlationId: context.correlationId,
      },
    };
  }

  async healthCheck(): Promise<AdapterHealth> {
    return {
      status: this.connected ? "healthy" : "degraded",
      details: {
        connected: this.connected,
        provider: "twilio",
        mode: "simulated",
      },
    };
  }
}
