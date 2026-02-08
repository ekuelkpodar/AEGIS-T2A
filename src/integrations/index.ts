/**
 * Integration catalog and Zapier MCP bridge.
 */

import { componentLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { ToolAdapter } from '../core/types.js';
import {
  IntegrationEntryKind,
  IntegrationSensitivity,
  IntegrationTier,
  IntegrationTool,
  getTool,
  getFallback,
  listFallbacks,
  listTools,
  searchEntries,
  setFallback,
  upsertEntry,
  upsertTool,
} from './store.js';

const logger = componentLogger('integrations');

const DEFAULT_FALLBACK_PREFIXES: Array<{ prefix: string; fallback: string }> = [
  { prefix: 'slack', fallback: 'zapier:mcp' },
  { prefix: 'jira', fallback: 'zapier:mcp' },
  { prefix: 'github', fallback: 'zapier:mcp' },
  { prefix: 'pagerduty', fallback: 'zapier:mcp' },
  { prefix: 'salesforce', fallback: 'zapier:mcp' },
  { prefix: 'hubspot', fallback: 'zapier:mcp' },
  { prefix: 'notion', fallback: 'zapier:mcp' },
  { prefix: 'asana', fallback: 'zapier:mcp' },
  { prefix: 'clickup', fallback: 'zapier:mcp' },
  { prefix: 'zendesk', fallback: 'zapier:mcp' },
  { prefix: 'servicenow', fallback: 'zapier:mcp' },
  { prefix: 'google', fallback: 'zapier:mcp' },
  { prefix: 'microsoft', fallback: 'zapier:mcp' },
  { prefix: 'webhook', fallback: 'http:request' },
];

export interface IntegrationSearchOptions {
  query: string;
  limit?: number;
}

export class IntegrationCatalog {
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;
    this.ensureDefaults();
    this.initialized = true;
    logger.info('Integration catalog initialized');
  }

  indexAdapter(adapter: ToolAdapter): void {
    const tool = this.ensureToolForAdapter(adapter);
    for (const capability of adapter.capabilities) {
      upsertEntry(tool.toolId, capability, capability, adapter.description, 'capability');
    }
  }

  search(options: IntegrationSearchOptions) {
    return searchEntries(options.query, options.limit ?? 10);
  }

  listTools(limit?: number): IntegrationTool[] {
    return listTools(limit);
  }

  getTool(toolId: string): IntegrationTool | null {
    return getTool(toolId);
  }

  getFallbackAdapter(adapterId: string): string | null {
    return getFallback(adapterId);
  }

  listFallbacks() {
    return listFallbacks();
  }

  setFallback(primaryAdapter: string, fallbackAdapter: string, matchType: 'exact' | 'prefix'): void {
    setFallback(primaryAdapter, fallbackAdapter, matchType);
  }

  private ensureDefaults(): void {
    const zapierTool = upsertTool({
      name: 'Zapier MCP Bridge',
      category: 'integration',
      subcategory: 'mcp',
      description: 'Universal integration bridge via Zapier MCP',
      authType: 'oauth2',
      sensitivity: 'confidential',
      tier: 'tier2',
      metadata: { provider: 'zapier' },
    });

    upsertEntry(zapierTool.toolId, 'zapier:mcp', 'Zapier MCP', 'Execute Zapier MCP actions', 'action');

    const webhookTool = upsertTool({
      name: 'Webhooks',
      category: 'integration',
      subcategory: 'webhook',
      description: 'Custom webhook invocation',
      authType: 'api-key',
      sensitivity: 'public',
      tier: 'tier3',
      metadata: { provider: 'custom' },
    });

    upsertEntry(webhookTool.toolId, 'webhook:invoke', 'Webhook Invoke', 'Invoke external webhooks', 'action');

    for (const fallback of DEFAULT_FALLBACK_PREFIXES) {
      setFallback(fallback.prefix, fallback.fallback, 'prefix');
    }
  }

  private ensureToolForAdapter(adapter: ToolAdapter): IntegrationTool {
    const { category, tier, sensitivity } = classifyAdapter(adapter.adapterId, adapter.riskLevel);
    return upsertTool({
      name: adapter.name,
      category,
      subcategory: adapter.adapterId.split(':')[0] ?? undefined,
      description: adapter.description,
      authType: adapter.rateLimits ? 'api-key' : undefined,
      sensitivity,
      tier,
      metadata: {
        adapterId: adapter.adapterId,
        version: adapter.version,
        capabilities: adapter.capabilities,
      },
    });
  }
}

export class ZapierMcpClient {
  private endpoint: string | undefined;
  private apiKey: string | undefined;
  private timeoutMs: number;

  constructor() {
    const config = getConfig();
    this.endpoint = config.zapierMcpEndpoint;
    this.apiKey = config.zapierMcpApiKey;
    this.timeoutMs = config.zapierMcpTimeoutMs;
  }

  async execute(actionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.endpoint) {
      logger.warn('Zapier MCP endpoint not configured; returning mock response');
      return { success: false, mock: true, reason: 'zapier_mcp_endpoint_not_configured' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.endpoint}/v1/mcp/actions/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ actionId, input }),
        signal: controller.signal,
      });

      const json = (await response.json()) as Record<string, unknown>;
      return { success: response.ok, status: response.status, ...json };
    } catch (error) {
      logger.error({ error }, 'Zapier MCP request failed');
      return { success: false, error: (error as Error).message };
    } finally {
      clearTimeout(timeout);
    }
  }
}

let catalog: IntegrationCatalog | null = null;

export function initializeIntegrations(): void {
  if (!catalog) {
    catalog = new IntegrationCatalog();
  }
  catalog.initialize();
}

export function getIntegrationCatalog(): IntegrationCatalog {
  if (!catalog) {
    catalog = new IntegrationCatalog();
    catalog.initialize();
  }
  return catalog;
}

function classifyAdapter(adapterId: string, riskLevel: string): {
  category: string;
  tier: IntegrationTier;
  sensitivity: IntegrationSensitivity;
} {
  const prefix = adapterId.split(':')[0] ?? 'generic';
  let category = 'general';

  if (['slack', 'notification', 'telegram', 'whatsapp', 'email'].includes(prefix)) {
    category = 'communication';
  } else if (['github', 'gitlab', 'jira', 'linear'].includes(prefix)) {
    category = 'devtools';
  } else if (['aws', 'gcp', 'azure'].includes(prefix)) {
    category = 'cloud';
  } else if (['http', 'webhook'].includes(prefix)) {
    category = 'integration';
  }

  const tier: IntegrationTier = prefix === 'zapier' ? 'tier2' : prefix === 'webhook' || prefix === 'http' ? 'tier3' : 'tier1';
  const sensitivity: IntegrationSensitivity = riskLevel === 'destructive' || riskLevel === 'high' ? 'restricted' : 'confidential';

  return { category, tier, sensitivity };
}
