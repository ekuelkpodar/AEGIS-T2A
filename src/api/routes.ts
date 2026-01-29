/**
 * AEGIS-T2A API Routes
 *
 * REST API endpoints for the platform.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getGateway, initializeGateway } from '../gateway/index.js';
import { getPlanner, initializePlanner } from '../planner/index.js';
import { getSimulator, initializeSimulator } from '../simulation/index.js';
import { getWorkflowEngine, initializeWorkflowEngine } from '../workflow/index.js';
import { getAuditLedger, initializeAuditLedger } from '../audit/index.js';
import { getRegistry, initializeRegistry } from '../registry/index.js';
import { getSecretsVault, initializeSecretsVault } from '../secrets/index.js';
import { getExecutor, initializeExecutor } from '../executor/index.js';
import { componentLogger } from '../core/logger.js';
import { EventType, ActorType } from '../core/types.js';

const logger = componentLogger('api');

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

  router.get('/audit/verify', async (req: Request, res: Response, next: NextFunction) => {
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

  return router;
}
