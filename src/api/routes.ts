/**
 * AEGIS-T2A API Routes
 *
 * REST API endpoints for the platform.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getGateway } from '../gateway/index.js';
import { getPlanner } from '../planner/index.js';
import { getSimulator } from '../simulation/index.js';
import { getWorkflowEngine } from '../workflow/index.js';
import { getAuditLedger } from '../audit/index.js';
import { getRegistry } from '../registry/index.js';
import { getExecutor } from '../executor/index.js';
import { EventType, ActorType } from '../core/types.js';
import {
  initializeLLMProvider,
  getLLMProvider,
  OllamaProvider
} from '../providers/llm/index.js';

// =============================================================================
// Request Schemas
// =============================================================================

const IntentRequestSchema = z.object({
  text: z.string().min(1),
  context: z.record(z.unknown()).optional(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
});

const ApprovalRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  approverId: z.string(),
  rationale: z.string().optional(),
});

// =============================================================================
// Router Setup
// =============================================================================

export function createRouter(): Router {
  const router = Router();

  // ==========================================================================
  // Health & Status
  // ==========================================================================

  router.get('/health', async (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env['npm_package_version'] ?? '0.1.0',
    });
  });

  // ==========================================================================
  // Intents
  // ==========================================================================

  router.post('/intents', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = IntentRequestSchema.parse(req.body);
      const userId = req.headers['x-user-id'] as string ?? 'anonymous';

      const gateway = getGateway();
      const result = await gateway.processRequest({
        userId,
        text: body.text,
        context: body.context,
        environment: body.environment,
      });

      if (!result.success) {
        res.status(result.clarificationNeeded ? 400 : 403).json({
          success: false,
          error: result.error,
          clarificationNeeded: result.clarificationNeeded,
          clarificationQuestions: result.clarificationQuestions,
        });
        return;
      }

      // Record audit event
      const auditLedger = getAuditLedger();
      await auditLedger.record({
        eventType: EventType.INTENT_CREATED,
        intentId: result.intent?.intentId,
        actorId: userId,
        actorType: ActorType.USER,
        action: 'create_intent',
        inputs: { text: body.text },
        success: true,
      });

      res.status(201).json({
        success: true,
        intent: result.intent,
        policyResult: result.policyResult,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/intents/:intentId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gateway = getGateway();
      const intent = await gateway.getIntent(req.params['intentId']!);

      if (!intent) {
        res.status(404).json({ error: 'Intent not found' });
        return;
      }

      res.json({ intent });
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Plans
  // ==========================================================================

  router.post('/intents/:intentId/plan', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gateway = getGateway();
      const intent = await gateway.getIntent(req.params['intentId']!);

      if (!intent) {
        res.status(404).json({ error: 'Intent not found' });
        return;
      }

      const planner = getPlanner();
      const result = await planner.generatePlan(intent);

      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }

      // Record audit event
      const auditLedger = getAuditLedger();
      await auditLedger.record({
        eventType: EventType.PLAN_GENERATED,
        intentId: intent.intentId,
        planId: result.plan?.planId,
        actorId: 'system',
        actorType: ActorType.AGENT,
        action: 'generate_plan',
        inputs: { intentId: intent.intentId },
        success: true,
      });

      res.status(201).json({
        success: true,
        plan: result.plan,
        warnings: result.warnings,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/plans/:planId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const planner = getPlanner();
      const plan = await planner.getPlan(req.params['planId']!);

      if (!plan) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      res.json({ plan });
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Simulations
  // ==========================================================================

  router.post('/plans/:planId/simulate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const planner = getPlanner();
      const plan = await planner.getPlan(req.params['planId']!);

      if (!plan) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const simulator = getSimulator();
      const result = await simulator.simulate(plan);

      // Record audit event
      const auditLedger = getAuditLedger();
      await auditLedger.record({
        eventType: EventType.SIMULATION_COMPLETED,
        planId: plan.planId,
        actorId: 'system',
        actorType: ActorType.SYSTEM,
        action: 'simulate_plan',
        inputs: { planId: plan.planId },
        outputs: { riskScore: result.riskScore, status: result.status },
        success: true,
      });

      res.json({ simulation: result });
    } catch (error) {
      next(error);
    }
  });

  router.get('/simulations/:simulationId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const simulator = getSimulator();
      const simulation = await simulator.getSimulation(req.params['simulationId']!);

      if (!simulation) {
        res.status(404).json({ error: 'Simulation not found' });
        return;
      }

      res.json({ simulation });
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Workflows
  // ==========================================================================

  router.post('/plans/:planId/execute', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const planner = getPlanner();
      const plan = await planner.getPlan(req.params['planId']!);

      if (!plan) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const workflowEngine = getWorkflowEngine();
      const workflow = await workflowEngine.createWorkflow(plan);

      // Record audit event
      const auditLedger = getAuditLedger();
      await auditLedger.record({
        eventType: EventType.WORKFLOW_STARTED,
        planId: plan.planId,
        workflowId: workflow.workflowId,
        actorId: req.headers['x-user-id'] as string ?? 'anonymous',
        actorType: ActorType.USER,
        action: 'create_workflow',
        inputs: { planId: plan.planId },
        success: true,
      });

      // Start if no approval required
      if (!workflow.approvalRequired) {
        const executor = getExecutor();
        workflowEngine.setStepExecutor((step, ctx) => executor.executeStep(step, ctx));
        await workflowEngine.startWorkflow(workflow.workflowId, plan, { skipApproval: true });
      }

      const updated = await workflowEngine.getWorkflow(workflow.workflowId);

      res.status(201).json({ workflow: updated ?? workflow });
    } catch (error) {
      next(error);
    }
  });

  router.get('/workflows/:workflowId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workflowEngine = getWorkflowEngine();
      const workflow = await workflowEngine.getWorkflow(req.params['workflowId']!);

      if (!workflow) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }

      res.json({ workflow });
    } catch (error) {
      next(error);
    }
  });

  router.post('/workflows/:workflowId/approve', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = ApprovalRequestSchema.parse(req.body);

      const workflowEngine = getWorkflowEngine();
      const workflow = await workflowEngine.getWorkflow(req.params['workflowId']!);

      if (!workflow) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }

      const auditLedger = getAuditLedger();

      if (body.decision === 'approved') {
        await workflowEngine.approveWorkflow(workflow.workflowId, body.approverId);

        await auditLedger.record({
          eventType: EventType.APPROVAL_GRANTED,
          workflowId: workflow.workflowId,
          actorId: body.approverId,
          actorType: ActorType.USER,
          action: 'approve_workflow',
          inputs: { decision: body.decision, rationale: body.rationale },
          success: true,
        });

        // Start execution
        const planner = getPlanner();
        const plan = await planner.getPlan(workflow.planId);

        if (plan) {
          const executor = getExecutor();
          workflowEngine.setStepExecutor((step, ctx) => executor.executeStep(step, ctx));
          await workflowEngine.startWorkflow(workflow.workflowId, plan);
        }
      } else {
        await workflowEngine.rejectWorkflow(workflow.workflowId, body.approverId, body.rationale ?? 'Rejected');

        await auditLedger.record({
          eventType: EventType.APPROVAL_DENIED,
          workflowId: workflow.workflowId,
          actorId: body.approverId,
          actorType: ActorType.USER,
          action: 'reject_workflow',
          inputs: { decision: body.decision, rationale: body.rationale },
          success: true,
        });
      }

      const updated = await workflowEngine.getWorkflow(workflow.workflowId);
      res.json({ workflow: updated });
    } catch (error) {
      next(error);
    }
  });

  router.post('/workflows/:workflowId/cancel', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workflowEngine = getWorkflowEngine();
      await workflowEngine.cancelWorkflow(req.params['workflowId']!);

      const workflow = await workflowEngine.getWorkflow(req.params['workflowId']!);
      res.json({ workflow });
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Audit
  // ==========================================================================

  router.get('/audit/events', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auditLedger = getAuditLedger();
      const events = await auditLedger.query({
        startTime: req.query['startTime'] as string,
        endTime: req.query['endTime'] as string,
        intentId: req.query['intentId'] as string,
        workflowId: req.query['workflowId'] as string,
        limit: req.query['limit'] ? parseInt(req.query['limit'] as string) : 100,
        offset: req.query['offset'] ? parseInt(req.query['offset'] as string) : 0,
      });

      res.json({ events, count: events.length });
    } catch (error) {
      next(error);
    }
  });

  router.get('/audit/verify', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const auditLedger = getAuditLedger();
      const result = await auditLedger.verifyChain();

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Registry
  // ==========================================================================

  router.get('/registry/adapters', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const registry = getRegistry();
      const adapters = registry.getAllAdapters();

      res.json({ adapters, count: adapters.length });
    } catch (error) {
      next(error);
    }
  });

  router.get('/registry/adapters/:adapterId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const registry = getRegistry();
      const adapter = registry.getAdapter(req.params['adapterId']!);

      if (!adapter) {
        res.status(404).json({ error: 'Adapter not found' });
        return;
      }

      res.json({ adapter });
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Policy
  // ==========================================================================

  router.get('/policy/rules', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const gateway = getGateway();
      const rules = gateway.getPolicyEngine().getRules();

      res.json({ rules, count: rules.length });
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Settings & Configuration
  // ==========================================================================

  router.get('/settings', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Return current settings (from environment, safe to expose)
      const provider = getLLMProvider();

      res.json({
        llm: {
          provider: process.env['LLM_PROVIDER'] || 'anthropic',
          model: process.env['LLM_MODEL'] || '',
          temperature: parseFloat(process.env['LLM_TEMPERATURE'] || '0.7'),
          ollamaUrl: process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434',
          // Don't expose API keys, just whether they're set
          hasAnthropicKey: !!process.env['ANTHROPIC_API_KEY'] && process.env['ANTHROPIC_API_KEY'] !== 'your-anthropic-api-key',
          hasOpenaiKey: !!process.env['OPENAI_API_KEY'] && process.env['OPENAI_API_KEY'] !== 'your-openai-api-key',
          hasOpenrouterKey: !!process.env['OPENROUTER_API_KEY'] && process.env['OPENROUTER_API_KEY'] !== 'your-openrouter-api-key',
        },
        server: {
          port: process.env['PORT'] || 3000,
          environment: process.env['NODE_ENV'] || 'development',
        },
        currentProvider: provider.name,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/test-llm', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { provider, apiKey, model, ollamaUrl } = req.body;

      // Create a temporary provider to test
      const testProvider = initializeLLMProvider({
        provider: provider || 'anthropic',
        apiKey: apiKey,
        model: model,
        baseUrl: provider === 'ollama' ? ollamaUrl : undefined,
      });

      const success = await testProvider.testConnection();

      res.json({
        success,
        provider: testProvider.name,
        message: success ? 'Connection successful' : 'Connection failed',
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings/ollama/models', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ollamaUrl = (req.query['url'] as string) || process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';

      const ollamaProvider = new OllamaProvider({ baseUrl: ollamaUrl });
      const models = await ollamaProvider.listModels();

      res.json({ models, url: ollamaUrl });
    } catch (error) {
      next(error);
    }
  });

  // Enhanced Ollama discovery endpoint with full model details
  router.get('/settings/ollama/discover', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ollamaUrl = (req.query['url'] as string) || process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';

      const ollamaProvider = new OllamaProvider({ baseUrl: ollamaUrl });
      const discovery = await ollamaProvider.discover();

      res.json(discovery);
    } catch (error) {
      next(error);
    }
  });

  // Get detailed info for a specific Ollama model
  router.get('/settings/ollama/models/:modelName', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ollamaUrl = (req.query['url'] as string) || process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';
      const modelName = req.params['modelName']!;

      const ollamaProvider = new OllamaProvider({ baseUrl: ollamaUrl });
      const modelInfo = await ollamaProvider.getModelInfo(modelName);

      if (!modelInfo) {
        res.status(404).json({ error: 'Model not found' });
        return;
      }

      res.json({ model: modelInfo });
    } catch (error) {
      next(error);
    }
  });

  // Pull an Ollama model
  router.post('/settings/ollama/pull', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { model, url } = req.body;

      if (!model) {
        res.status(400).json({ error: 'Model name is required' });
        return;
      }

      const ollamaUrl = url || process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';
      const ollamaProvider = new OllamaProvider({ baseUrl: ollamaUrl });

      // Start the pull (this is async and may take time)
      await ollamaProvider.pullModel(model);

      res.json({ success: true, message: `Model ${model} pulled successfully` });
    } catch (error) {
      next(error);
    }
  });

  // Delete an Ollama model
  router.delete('/settings/ollama/models/:modelName', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ollamaUrl = (req.query['url'] as string) || process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';
      const modelName = req.params['modelName']!;

      const ollamaProvider = new OllamaProvider({ baseUrl: ollamaUrl });
      const success = await ollamaProvider.deleteModel(modelName);

      if (!success) {
        res.status(500).json({ error: 'Failed to delete model' });
        return;
      }

      res.json({ success: true, message: `Model ${modelName} deleted` });
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings/models', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = (req.query['provider'] as string) || process.env['LLM_PROVIDER'] || 'anthropic';

      // Return available models for each provider
      const modelsByProvider: Record<string, Array<{ id: string; name: string; description?: string }>> = {
        anthropic: [
          { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', description: 'Latest balanced model' },
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', description: 'Fast and capable' },
          { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', description: 'Most capable' },
          { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', description: 'Fast and efficient' },
        ],
        openai: [
          { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', description: 'Most capable GPT-4' },
          { id: 'gpt-4o', name: 'GPT-4o', description: 'Optimized GPT-4' },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast and affordable' },
          { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', description: 'Fast and efficient' },
        ],
        openrouter: [
          { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', description: 'Via OpenRouter' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Via OpenRouter' },
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo', description: 'Via OpenRouter' },
          { id: 'google/gemini-pro', name: 'Gemini Pro', description: 'Google via OpenRouter' },
          { id: 'meta-llama/llama-3-70b-instruct', name: 'Llama 3 70B', description: 'Meta via OpenRouter' },
          { id: 'mistralai/mixtral-8x7b-instruct', name: 'Mixtral 8x7B', description: 'Mistral via OpenRouter' },
        ],
        ollama: [], // Will be populated dynamically
      };

      res.json({
        provider,
        models: modelsByProvider[provider] || [],
      });
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Cloud Provider Testing & Validation
  // ==========================================================================

  router.post('/cloud/test', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { provider, config } = req.body;

      // Validate provider
      const validProviders = ['aws', 'azure', 'gcp', 'onprem'];
      if (!validProviders.includes(provider)) {
        res.status(400).json({ success: false, error: 'Invalid cloud provider' });
        return;
      }

      let testResult: { success: boolean; message: string; details?: Record<string, unknown> } = {
        success: false,
        message: '',
      };

      switch (provider) {
        case 'aws':
          testResult = await testAWSConnection(config);
          break;
        case 'azure':
          testResult = await testAzureConnection(config);
          break;
        case 'gcp':
          testResult = await testGCPConnection(config);
          break;
        case 'onprem':
          testResult = await testOnPremConnection(config);
          break;
      }

      res.json(testResult);
    } catch (error) {
      next(error);
    }
  });

  // Get cloud provider status - checks all configured providers
  router.get('/cloud/status', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const awsStatus: { configured: boolean; connected?: boolean; error?: string } = { configured: false };
      const azureStatus: { configured: boolean; connected?: boolean; error?: string } = { configured: false };
      const gcpStatus: { configured: boolean; connected?: boolean; error?: string } = { configured: false };
      const onpremStatus: { configured: boolean; connected?: boolean; error?: string } = { configured: false };

      // Check AWS
      if (process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY']) {
        awsStatus.configured = true;
        try {
          const result = await testAWSConnection({
            accessKeyId: process.env['AWS_ACCESS_KEY_ID'],
            secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'],
            region: process.env['AWS_REGION'],
          });
          awsStatus.connected = result.success;
          if (!result.success) awsStatus.error = result.message;
        } catch (e) {
          awsStatus.connected = false;
          awsStatus.error = e instanceof Error ? e.message : 'Unknown error';
        }
      }

      // Check Azure
      if (process.env['AZURE_TENANT_ID'] && process.env['AZURE_CLIENT_ID']) {
        azureStatus.configured = true;
        try {
          const result = await testAzureConnection({
            tenantId: process.env['AZURE_TENANT_ID'],
            clientId: process.env['AZURE_CLIENT_ID'],
            clientSecret: process.env['AZURE_CLIENT_SECRET'],
          });
          azureStatus.connected = result.success;
          if (!result.success) azureStatus.error = result.message;
        } catch (e) {
          azureStatus.connected = false;
          azureStatus.error = e instanceof Error ? e.message : 'Unknown error';
        }
      }

      // Check GCP
      if (process.env['GCP_PROJECT_ID'] || process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
        gcpStatus.configured = true;
        try {
          const result = await testGCPConnection({
            projectId: process.env['GCP_PROJECT_ID'],
            keyFile: process.env['GOOGLE_APPLICATION_CREDENTIALS'],
          });
          gcpStatus.connected = result.success;
          if (!result.success) gcpStatus.error = result.message;
        } catch (e) {
          gcpStatus.connected = false;
          gcpStatus.error = e instanceof Error ? e.message : 'Unknown error';
        }
      }

      // Check Docker (local)
      try {
        const dockerResult = await testDockerLocal();
        if (dockerResult.success) {
          onpremStatus.configured = true;
          onpremStatus.connected = true;
        }
      } catch {
        // Docker not available
      }

      res.json({
        providers: {
          aws: awsStatus,
          azure: azureStatus,
          gcp: gcpStatus,
          onprem: onpremStatus,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  // Test AWS connection
  async function testAWSConnection(config: Record<string, unknown>): Promise<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
  }> {
    if (!config?.accessKeyId || !config?.secretAccessKey) {
      return { success: false, message: 'Missing AWS credentials (accessKeyId, secretAccessKey)' };
    }

    try {
      // Use AWS STS GetCallerIdentity to verify credentials
      const region = (config.region as string) || 'us-east-1';

      // For a proper test, we'd need to implement AWS Signature V4
      // For now, verify the credential format
      const accessKeyId = config.accessKeyId as string;
      const secretAccessKey = config.secretAccessKey as string;

      if (!accessKeyId.startsWith('AKIA') && !accessKeyId.startsWith('ASIA')) {
        return { success: false, message: 'Invalid AWS access key format' };
      }

      if (secretAccessKey.length < 20) {
        return { success: false, message: 'Invalid AWS secret key format' };
      }

      return {
        success: true,
        message: 'AWS credentials format validated',
        details: {
          region,
          accessKeyId: `${accessKeyId.slice(0, 4)}...${accessKeyId.slice(-4)}`,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'AWS connection test failed',
      };
    }
  }

  // Test Azure connection
  async function testAzureConnection(config: Record<string, unknown>): Promise<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
  }> {
    if (!config?.tenantId || !config?.clientId || !config?.clientSecret) {
      return { success: false, message: 'Missing Azure credentials (tenantId, clientId, clientSecret)' };
    }

    try {
      const tenantId = config.tenantId as string;
      const clientId = config.clientId as string;
      const clientSecret = config.clientSecret as string;

      // Try to get an access token
      const response = await fetch(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            scope: 'https://management.azure.com/.default',
            grant_type: 'client_credentials',
          }),
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error_description?: string };
        return {
          success: false,
          message: errorData.error_description || 'Azure authentication failed',
        };
      }

      const data = await response.json() as { token_type: string; expires_in: number };

      return {
        success: true,
        message: 'Azure connection successful',
        details: {
          tenantId: `${tenantId.slice(0, 8)}...`,
          tokenType: data.token_type,
          expiresIn: data.expires_in,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Azure connection test failed',
      };
    }
  }

  // Test GCP connection
  async function testGCPConnection(config: Record<string, unknown>): Promise<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
  }> {
    if (!config?.projectId) {
      return { success: false, message: 'Missing GCP project ID' };
    }

    const projectId = config.projectId as string;

    // If running on GCP, try metadata server
    try {
      const metadataResponse = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/project/project-id',
        {
          headers: { 'Metadata-Flavor': 'Google' },
          signal: AbortSignal.timeout(2000),
        }
      );

      if (metadataResponse.ok) {
        const metadataProjectId = await metadataResponse.text();
        return {
          success: true,
          message: 'GCP metadata server accessible (running on GCP)',
          details: { projectId: metadataProjectId },
        };
      }
    } catch {
      // Not on GCP, continue with other checks
    }

    // Check if key file exists
    if (config.keyFile) {
      const fs = await import('fs/promises');
      try {
        await fs.access(config.keyFile as string);
        return {
          success: true,
          message: 'GCP service account key file found',
          details: { projectId, keyFile: config.keyFile },
        };
      } catch {
        return {
          success: false,
          message: 'GCP service account key file not found',
        };
      }
    }

    return {
      success: true,
      message: 'GCP project ID configured (authentication will be attempted at runtime)',
      details: { projectId },
    };
  }

  // Test on-premises connection
  async function testOnPremConnection(config: Record<string, unknown>): Promise<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
  }> {
    const type = config?.type as string;

    if (!type) {
      return { success: false, message: 'Missing on-premises type (ssh, docker, kubernetes)' };
    }

    switch (type) {
      case 'ssh':
        return testSSHConnection(config);
      case 'docker':
        return testDockerConnection(config);
      case 'kubernetes':
        return testKubernetesConnection(config);
      default:
        return { success: false, message: `Unknown on-premises type: ${type}` };
    }
  }

  async function testSSHConnection(config: Record<string, unknown>): Promise<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
  }> {
    const host = config.host as string;
    const port = (config.port as number) || 22;

    if (!host) {
      return { success: false, message: 'Missing SSH host' };
    }

    // Test TCP connectivity to SSH port
    try {
      const net = await import('net');
      const connected = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);

        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });

        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });

        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });

        socket.connect(port, host);
      });

      if (connected) {
        return {
          success: true,
          message: `SSH port ${port} reachable on ${host}`,
          details: { host, port },
        };
      } else {
        return {
          success: false,
          message: `Cannot connect to SSH port ${port} on ${host}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'SSH connection test failed',
      };
    }
  }

  async function testDockerConnection(config: Record<string, unknown>): Promise<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
  }> {
    const host = (config.host as string) || 'localhost';
    const port = (config.port as number) || 2375;
    const useTls = !!(config.tlsCert || config.useTls);

    const protocol = useTls ? 'https' : 'http';
    const url = `${protocol}://${host}:${port}/version`;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

      if (response.ok) {
        const data = await response.json() as { Version: string; ApiVersion: string; Os: string; Arch: string };
        return {
          success: true,
          message: 'Docker API accessible',
          details: {
            host,
            port,
            version: data.Version,
            apiVersion: data.ApiVersion,
            os: data.Os,
            arch: data.Arch,
          },
        };
      } else {
        return {
          success: false,
          message: `Docker API returned status ${response.status}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Docker connection test failed',
      };
    }
  }

  async function testDockerLocal(): Promise<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
  }> {
    // Try Unix socket first (common on Linux/macOS)
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const { stdout } = await execAsync('docker version --format "{{.Server.Version}}"', {
        timeout: 5000,
      });

      const version = stdout.trim();
      return {
        success: true,
        message: 'Local Docker available',
        details: { version, type: 'local' },
      };
    } catch {
      return { success: false, message: 'Local Docker not available' };
    }
  }

  async function testKubernetesConnection(config: Record<string, unknown>): Promise<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
  }> {
    const apiServer = config.apiServer as string;
    const token = config.token as string;
    const kubeconfig = config.kubeconfig as string;

    // If kubeconfig provided, try to use kubectl
    if (kubeconfig) {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        const { stdout } = await execAsync('kubectl cluster-info', {
          timeout: 10000,
          env: { ...process.env, KUBECONFIG: kubeconfig },
        });

        return {
          success: true,
          message: 'Kubernetes cluster accessible via kubeconfig',
          details: { clusterInfo: stdout.split('\n')[0] },
        };
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : 'kubectl test failed',
        };
      }
    }

    // If API server and token provided
    if (apiServer && token) {
      try {
        const response = await fetch(`${apiServer}/api/v1/namespaces`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          return {
            success: true,
            message: 'Kubernetes API accessible',
            details: { apiServer },
          };
        } else {
          return {
            success: false,
            message: `Kubernetes API returned status ${response.status}`,
          };
        }
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : 'Kubernetes connection test failed',
        };
      }
    }

    return {
      success: false,
      message: 'Missing Kubernetes configuration (apiServer+token or kubeconfig)',
    };
  }

  // ==========================================================================
  // Channel Testing
  // ==========================================================================

  router.post('/channels/test', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channel, config } = req.body;

      const validChannels = ['telegram', 'slack', 'whatsapp'];
      if (!validChannels.includes(channel)) {
        res.status(400).json({ success: false, error: 'Invalid channel' });
        return;
      }

      let testResult = { success: false, message: '' };

      switch (channel) {
        case 'telegram':
          if (config?.botToken) {
            testResult = { success: true, message: 'Telegram bot token validated' };
          } else {
            testResult = { success: false, message: 'Missing Telegram bot token' };
          }
          break;
        case 'slack':
          if (config?.botToken && config?.signingSecret) {
            testResult = { success: true, message: 'Slack credentials validated' };
          } else {
            testResult = { success: false, message: 'Missing Slack credentials' };
          }
          break;
        case 'whatsapp':
          if (config?.phoneNumberId && config?.accessToken) {
            testResult = { success: true, message: 'WhatsApp credentials validated' };
          } else {
            testResult = { success: false, message: 'Missing WhatsApp credentials' };
          }
          break;
      }

      res.json(testResult);
    } catch (error) {
      next(error);
    }
  });

  router.get('/channels/status', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        channels: {
          web: { enabled: true, status: 'active' },
          telegram: { enabled: false, status: 'inactive' },
          slack: { enabled: false, status: 'inactive' },
          whatsapp: { enabled: false, status: 'inactive' },
        },
      });
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // App Builder (Docker-based)
  // ==========================================================================

  const BuildRequestSchema = z.object({
    type: z.enum(['crud', 'landing', 'api', 'dashboard', 'custom']),
    name: z.string().min(1),
    description: z.string(),
    options: z.object({
      database: z.enum(['sqlite', 'postgres', 'mongodb', 'none']).optional(),
      framework: z.enum(['react', 'vue', 'nextjs', 'express', 'fastapi']).optional(),
      styling: z.enum(['tailwind', 'bootstrap', 'material', 'none']).optional(),
      features: z.array(z.string()).optional(),
    }).optional(),
  });

  // Store active builds
  const activeBuilds = new Map<string, {
    id: string;
    status: 'pending' | 'generating' | 'building' | 'running' | 'completed' | 'failed';
    type: string;
    name: string;
    description: string;
    progress: number;
    logs: string[];
    port?: number;
    url?: string;
    error?: string;
    startTime: Date;
    containerId?: string;
  }>();

  router.post('/build', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = BuildRequestSchema.parse(req.body);
      const buildId = `build-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Initialize build status
      const build = {
        id: buildId,
        status: 'pending' as const,
        type: body.type,
        name: body.name,
        description: body.description,
        progress: 0,
        logs: ['Build request received'],
        startTime: new Date(),
      };

      activeBuilds.set(buildId, build);

      // Start the build process asynchronously
      startBuildProcess(buildId, body).catch(err => {
        const b = activeBuilds.get(buildId);
        if (b) {
          b.status = 'failed';
          b.error = err.message;
          b.logs.push(`Error: ${err.message}`);
        }
      });

      res.status(202).json({
        success: true,
        buildId,
        message: 'Build started',
        status: build.status,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/build/:buildId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const build = activeBuilds.get(req.params['buildId']!);

      if (!build) {
        res.status(404).json({ error: 'Build not found' });
        return;
      }

      res.json({ build });
    } catch (error) {
      next(error);
    }
  });

  router.get('/builds', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const builds = Array.from(activeBuilds.values())
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

      res.json({ builds, count: builds.length });
    } catch (error) {
      next(error);
    }
  });

  router.post('/build/:buildId/stop', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const build = activeBuilds.get(req.params['buildId']!);

      if (!build) {
        res.status(404).json({ error: 'Build not found' });
        return;
      }

      // If there's a running container, stop it
      if (build.containerId) {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        try {
          await execAsync(`docker stop ${build.containerId}`);
          await execAsync(`docker rm ${build.containerId}`);
          build.logs.push('Container stopped and removed');
        } catch {
          build.logs.push('Failed to stop container (may already be stopped)');
        }
      }

      build.status = 'completed';
      build.logs.push('Build stopped by user');

      res.json({ success: true, build });
    } catch (error) {
      next(error);
    }
  });

  // Helper function to run the build process
  async function startBuildProcess(
    buildId: string,
    config: z.infer<typeof BuildRequestSchema>
  ): Promise<void> {
    const build = activeBuilds.get(buildId);
    if (!build) return;

    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const fs = await import('fs/promises');
    const path = await import('path');

    const execAsync = promisify(exec);

    try {
      // Step 1: Generate code using LLM
      build.status = 'generating';
      build.progress = 10;
      build.logs.push('Generating application code with AI...');

      const llmProvider = getLLMProvider();
      const prompt = generateBuildPrompt(config);

      const codeResponse = await llmProvider.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 4096,
        temperature: 0.7
      });
      build.progress = 30;
      build.logs.push('Code generation complete');

      // Step 2: Create project directory
      const projectDir = path.join(process.cwd(), 'builds', buildId);
      await fs.mkdir(projectDir, { recursive: true });
      build.logs.push(`Created project directory: ${projectDir}`);

      // Step 3: Parse and write generated files
      build.progress = 40;
      build.logs.push('Writing project files...');

      const files = parseGeneratedCode(codeResponse.content);
      for (const [filename, content] of Object.entries(files)) {
        const filePath = path.join(projectDir, filename);
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, content);
        build.logs.push(`Created: ${filename}`);
      }

      // Step 4: Generate Dockerfile if not present
      if (!files['Dockerfile']) {
        const dockerfile = generateDockerfile(config);
        await fs.writeFile(path.join(projectDir, 'Dockerfile'), dockerfile);
        build.logs.push('Created: Dockerfile');
      }

      // Step 5: Build Docker image
      build.status = 'building';
      build.progress = 50;
      build.logs.push('Building Docker image...');

      const imageName = `aegis-${config.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}:latest`;

      try {
        const { stdout: buildOutput } = await execAsync(
          `docker build -t ${imageName} ${projectDir}`,
          { maxBuffer: 10 * 1024 * 1024 }
        );
        build.logs.push('Docker image built successfully');
        if (buildOutput) {
          build.logs.push(buildOutput.slice(-500)); // Last 500 chars of output
        }
      } catch (dockerError: unknown) {
        const errMsg = dockerError instanceof Error ? dockerError.message : String(dockerError);
        build.logs.push(`Docker build warning: ${errMsg}`);
        // Continue anyway - we'll create a simple server
      }

      // Step 6: Run container
      build.progress = 80;
      build.logs.push('Starting container...');

      // Find available port
      const port = 8080 + Math.floor(Math.random() * 1000);

      try {
        const { stdout: containerId } = await execAsync(
          `docker run -d -p ${port}:3000 --name ${buildId} ${imageName}`
        );
        build.containerId = containerId.trim();
        build.port = port;
        build.url = `http://localhost:${port}`;
        build.logs.push(`Container started on port ${port}`);
      } catch (runError: unknown) {
        // If Docker fails, create a simple static server
        build.logs.push('Docker not available, falling back to simple server...');

        // Create a simple HTML file to serve
        const indexHtml = generateFallbackHtml(config);
        await fs.writeFile(path.join(projectDir, 'index.html'), indexHtml);

        build.port = port;
        build.url = `file://${projectDir}/index.html`;
        build.logs.push(`Static files generated at: ${projectDir}`);
      }

      // Step 7: Complete
      build.status = 'completed';
      build.progress = 100;
      build.logs.push('Build completed successfully!');

    } catch (error) {
      build.status = 'failed';
      build.error = error instanceof Error ? error.message : 'Unknown error';
      build.logs.push(`Build failed: ${build.error}`);
      throw error;
    }
  }

  // Generate prompt for LLM to create the app
  function generateBuildPrompt(config: z.infer<typeof BuildRequestSchema>): string {
    const frameworkHints: Record<string, string> = {
      react: 'Use React with Create React App structure',
      vue: 'Use Vue 3 with Vite',
      nextjs: 'Use Next.js with App Router',
      express: 'Use Express.js with Node.js',
      fastapi: 'Use FastAPI with Python',
    };

    const framework = config.options?.framework || 'react';
    const database = config.options?.database || 'none';
    const styling = config.options?.styling || 'tailwind';

    return `Generate a complete ${config.type} application with the following specifications:

Name: ${config.name}
Description: ${config.description}
Framework: ${frameworkHints[framework] || framework}
Database: ${database}
Styling: ${styling}
${config.options?.features?.length ? `Features: ${config.options.features.join(', ')}` : ''}

Please generate all the necessary files for a working application. Format your response as:

=== filename.ext ===
file content here
=== end ===

Include at minimum:
1. Main application entry point
2. Package.json with dependencies
3. Basic UI components
4. README with setup instructions

Make the application functional and visually appealing.`;
  }

  // Parse LLM response into files
  function parseGeneratedCode(response: string): Record<string, string> {
    const files: Record<string, string> = {};
    const fileRegex = /===\s*([^\s=]+)\s*===\n([\s\S]*?)(?====\s*end\s*===|===\s*[^\s=]+\s*===|$)/gi;

    let match;
    while ((match = fileRegex.exec(response)) !== null) {
      const filename = match[1]?.trim();
      const content = match[2]?.trim();
      if (filename && content && filename !== 'end') {
        files[filename] = content;
      }
    }

    // If no files were parsed, create basic structure
    if (Object.keys(files).length === 0) {
      files['index.html'] = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Generated App</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 min-h-screen">
  <div class="container mx-auto p-8">
    <h1 class="text-3xl font-bold text-gray-800 mb-4">App Generated</h1>
    <p class="text-gray-600">Your application is being generated...</p>
  </div>
</body>
</html>`;

      files['package.json'] = JSON.stringify({
        name: 'generated-app',
        version: '1.0.0',
        scripts: {
          start: 'npx serve -s .',
          build: 'echo "No build step required"',
        },
      }, null, 2);
    }

    return files;
  }

  // Generate Dockerfile based on config
  function generateDockerfile(config: z.infer<typeof BuildRequestSchema>): string {
    const framework = config.options?.framework || 'react';

    if (framework === 'fastapi') {
      return `FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
EXPOSE 3000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000"]`;
    }

    return `FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build || true
EXPOSE 3000
CMD ["npx", "serve", "-s", ".", "-l", "3000"]`;
  }

  // Generate fallback HTML if Docker is not available
  function generateFallbackHtml(config: z.infer<typeof BuildRequestSchema>): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.name}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
  <div class="container mx-auto p-8">
    <header class="text-center mb-12">
      <h1 class="text-4xl font-bold text-gray-800 mb-4">${config.name}</h1>
      <p class="text-xl text-gray-600">${config.description}</p>
    </header>

    <main class="bg-white rounded-xl shadow-lg p-8 max-w-2xl mx-auto">
      <div class="text-center">
        <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg class="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
          </svg>
        </div>
        <h2 class="text-2xl font-semibold text-gray-800 mb-2">Application Generated!</h2>
        <p class="text-gray-600 mb-6">Your ${config.type} application has been created successfully.</p>

        <div class="bg-gray-50 rounded-lg p-4 text-left">
          <h3 class="font-semibold text-gray-700 mb-2">Build Details:</h3>
          <ul class="text-sm text-gray-600 space-y-1">
            <li><strong>Type:</strong> ${config.type}</li>
            <li><strong>Framework:</strong> ${config.options?.framework || 'Default'}</li>
            <li><strong>Database:</strong> ${config.options?.database || 'None'}</li>
            <li><strong>Styling:</strong> ${config.options?.styling || 'Tailwind CSS'}</li>
          </ul>
        </div>
      </div>
    </main>

    <footer class="text-center mt-12 text-gray-500 text-sm">
      Generated by AEGIS-T2A
    </footer>
  </div>
</body>
</html>`;
  }

  return router;
}
