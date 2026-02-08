/**
 * AEGIS-T2A Agent Registry
 *
 * Manages tool adapters, versioning, and capability enforcement.
 */

import { ToolAdapter, RiskLevel } from '../core/types.js';
import { componentLogger } from '../core/logger.js';
import { execute, queryOne, queryAll } from '../core/database.js';
import { hashObject, verifyObjectSignature, signObject } from '../core/crypto.js';
import { getIntegrationCatalog } from '../integrations/index.js';

const logger = componentLogger('registry');

// =============================================================================
// Types
// =============================================================================

export interface RegistrationResult {
  success: boolean;
  adapterId?: string;
  error?: string;
}

export interface CapabilityCheck {
  hasCapability: boolean;
  adapter?: ToolAdapter;
  reason?: string;
}

// =============================================================================
// Default Adapters
// =============================================================================

const DEFAULT_ADAPTERS: Omit<ToolAdapter, 'signature'>[] = [
  {
    adapterId: 'http:request',
    name: 'HTTP Request',
    version: '1.0.0',
    description: 'Make HTTP API requests',
    capabilities: ['http:get', 'http:post', 'http:put', 'http:delete'],
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'object' },
      },
      required: ['url'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'number' },
        body: { type: 'object' },
      },
    },
    sideEffects: true,
    compensationSupported: false,
    riskLevel: 'medium',
    timeout: 30000,
  },
  {
    adapterId: 'shell:command',
    name: 'Shell Command',
    version: '1.0.0',
    description: 'Execute shell commands',
    capabilities: ['shell:execute'],
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        env: { type: 'object' },
      },
      required: ['command'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        exitCode: { type: 'number' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
      },
    },
    sideEffects: true,
    compensationSupported: false,
    riskLevel: 'high',
    timeout: 60000,
  },
  {
    adapterId: 'database:query',
    name: 'Database Query',
    version: '1.0.0',
    description: 'Execute database queries',
    capabilities: ['database:read', 'database:write'],
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        params: { type: 'array' },
      },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        rowCount: { type: 'number' },
        rows: { type: 'array' },
      },
    },
    sideEffects: true,
    compensationSupported: true,
    riskLevel: 'high',
    timeout: 30000,
  },
  {
    adapterId: 'notification:send',
    name: 'Notification',
    version: '1.0.0',
    description: 'Send notifications via various channels',
    capabilities: ['notification:email', 'notification:slack', 'notification:webhook'],
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        recipient: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['channel', 'message'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        messageId: { type: 'string' },
      },
    },
    sideEffects: true,
    compensationSupported: false,
    riskLevel: 'low',
    timeout: 10000,
  },
  {
    adapterId: 'zapier:mcp',
    name: 'Zapier MCP Bridge',
    version: '1.0.0',
    description: 'Execute actions via Zapier MCP bridge',
    capabilities: ['zapier:mcp:action'],
    inputSchema: {
      type: 'object',
      properties: {
        actionId: { type: 'string' },
        input: { type: 'object' },
      },
      required: ['actionId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: { type: 'object' },
      },
    },
    sideEffects: true,
    compensationSupported: false,
    riskLevel: 'medium',
    timeout: 30000,
  },
  {
    adapterId: 'webhook:invoke',
    name: 'Webhook Invoke',
    version: '1.0.0',
    description: 'Invoke external webhooks',
    capabilities: ['webhook:invoke'],
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'object' },
      },
      required: ['url'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'number' },
        body: { type: 'object' },
      },
    },
    sideEffects: true,
    compensationSupported: false,
    riskLevel: 'medium',
    timeout: 30000,
  },
];

// =============================================================================
// Registry
// =============================================================================

export class AgentRegistry {
  private initialized = false;
  private adapters = new Map<string, ToolAdapter>();

  /**
   * Initialize the registry
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.loadAdapters();
    this.initialized = true;

    logger.info({ adapterCount: this.adapters.size }, 'Agent registry initialized');
  }

  /**
   * Load adapters from database
   */
  private async loadAdapters(): Promise<void> {
    const rows = queryAll<{
      adapter_id: string;
      name: string;
      version: string;
      description: string;
      capabilities: string;
      input_schema: string;
      output_schema: string;
      side_effects: number;
      compensation_supported: number;
      risk_level: string;
      timeout: number;
      rate_limits: string | null;
      sbom_hash: string | null;
      signature: string | null;
      enabled: number;
    }>('SELECT * FROM tool_adapters WHERE enabled = 1');

    if (rows.length === 0) {
      await this.registerDefaultAdapters();
      return this.loadAdapters();
    }

    for (const row of rows) {
      const adapter: ToolAdapter = {
        adapterId: row.adapter_id,
        name: row.name,
        version: row.version,
        description: row.description,
        capabilities: JSON.parse(row.capabilities),
        inputSchema: JSON.parse(row.input_schema),
        outputSchema: JSON.parse(row.output_schema),
        sideEffects: row.side_effects === 1,
        compensationSupported: row.compensation_supported === 1,
        riskLevel: row.risk_level as RiskLevel,
        timeout: row.timeout,
        rateLimits: row.rate_limits ? JSON.parse(row.rate_limits) : undefined,
        sbomHash: row.sbom_hash ?? undefined,
        signature: row.signature ?? undefined,
      };

      this.adapters.set(adapter.adapterId, adapter);
      try {
        getIntegrationCatalog().indexAdapter(adapter);
      } catch (error) {
        logger.warn({ adapterId: adapter.adapterId, error }, 'Failed to index adapter in integration catalog');
      }
    }
  }

  /**
   * Register default adapters
   */
  private async registerDefaultAdapters(): Promise<void> {
    const now = new Date().toISOString();

    for (const adapter of DEFAULT_ADAPTERS) {
      const signature = signObject(adapter);

      execute(
        `INSERT OR IGNORE INTO tool_adapters
         (adapter_id, name, version, description, capabilities, input_schema, output_schema,
          side_effects, compensation_supported, risk_level, timeout, rate_limits,
          sbom_hash, signature, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          adapter.adapterId,
          adapter.name,
          adapter.version,
          adapter.description,
          JSON.stringify(adapter.capabilities),
          JSON.stringify(adapter.inputSchema),
          JSON.stringify(adapter.outputSchema),
          adapter.sideEffects ? 1 : 0,
          adapter.compensationSupported ? 1 : 0,
          adapter.riskLevel,
          adapter.timeout,
          adapter.rateLimits ? JSON.stringify(adapter.rateLimits) : null,
          adapter.sbomHash ?? null,
          signature,
          now,
          now,
        ]
      );
    }

    logger.info({ count: DEFAULT_ADAPTERS.length }, 'Default adapters registered');
  }

  /**
   * Register a new adapter
   */
  async registerAdapter(adapter: Omit<ToolAdapter, 'signature'>): Promise<RegistrationResult> {
    try {
      const signature = signObject(adapter);
      const now = new Date().toISOString();

      execute(
        `INSERT OR REPLACE INTO tool_adapters
         (adapter_id, name, version, description, capabilities, input_schema, output_schema,
          side_effects, compensation_supported, risk_level, timeout, rate_limits,
          sbom_hash, signature, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          adapter.adapterId,
          adapter.name,
          adapter.version,
          adapter.description,
          JSON.stringify(adapter.capabilities),
          JSON.stringify(adapter.inputSchema),
          JSON.stringify(adapter.outputSchema),
          adapter.sideEffects ? 1 : 0,
          adapter.compensationSupported ? 1 : 0,
          adapter.riskLevel,
          adapter.timeout,
          adapter.rateLimits ? JSON.stringify(adapter.rateLimits) : null,
          adapter.sbomHash ?? null,
          signature,
          now,
          now,
        ]
      );

      const registered: ToolAdapter = { ...adapter, signature };
      this.adapters.set(adapter.adapterId, registered);
      try {
        getIntegrationCatalog().indexAdapter(registered);
      } catch (error) {
        logger.warn({ adapterId: adapter.adapterId, error }, 'Failed to index adapter in integration catalog');
      }

      logger.info({ adapterId: adapter.adapterId }, 'Adapter registered');

      return { success: true, adapterId: adapter.adapterId };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Registration failed',
      };
    }
  }

  /**
   * Get an adapter by ID
   */
  getAdapter(adapterId: string): ToolAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  /**
   * Check if a capability is available
   */
  checkCapability(capability: string): CapabilityCheck {
    for (const adapter of this.adapters.values()) {
      if (adapter.capabilities.includes(capability)) {
        return { hasCapability: true, adapter };
      }
    }

    // Check prefix match
    const prefix = capability.split(':')[0];
    for (const adapter of this.adapters.values()) {
      if (adapter.adapterId.startsWith(prefix + ':')) {
        return { hasCapability: true, adapter };
      }
    }

    return { hasCapability: false, reason: `No adapter provides capability: ${capability}` };
  }

  /**
   * Get all adapters
   */
  getAllAdapters(): ToolAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Verify adapter signature
   */
  verifyAdapter(adapterId: string): boolean {
    const adapter = this.adapters.get(adapterId);
    if (!adapter || !adapter.signature) return false;

    const { signature, ...adapterData } = adapter;
    return verifyObjectSignature(adapterData, signature);
  }

  /**
   * Disable an adapter
   */
  disableAdapter(adapterId: string): void {
    execute(
      'UPDATE tool_adapters SET enabled = 0, updated_at = ? WHERE adapter_id = ?',
      [new Date().toISOString(), adapterId]
    );
    this.adapters.delete(adapterId);
    logger.info({ adapterId }, 'Adapter disabled');
  }
}

// =============================================================================
// Singleton
// =============================================================================

let registry: AgentRegistry | null = null;

export function getRegistry(): AgentRegistry {
  if (!registry) {
    registry = new AgentRegistry();
  }
  return registry;
}

export async function initializeRegistry(): Promise<AgentRegistry> {
  const r = getRegistry();
  await r.initialize();
  return r;
}
