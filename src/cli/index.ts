#!/usr/bin/env node
/**
 * AEGIS-T2A CLI
 *
 * Command-line interface for the Text-to-Action Anywhere Platform.
 */

import { Command } from 'commander';
import { getConfig } from '../core/config.js';
import { runMigrations } from '../core/database.js';
import { initializeSigningKey, initializeEncryptionKey } from '../core/crypto.js';
import { logger } from '../core/logger.js';

// Component imports
import { initializeGateway, getGateway } from '../gateway/index.js';
import { initializePlanner, getPlanner } from '../planner/index.js';
import { initializeSimulator, getSimulator } from '../simulation/index.js';
import { initializeWorkflowEngine, getWorkflowEngine } from '../workflow/index.js';
import { initializeExecutor, getExecutor } from '../executor/index.js';
import { initializeRegistry, getRegistry } from '../registry/index.js';
import { initializeAuditLedger, getAuditLedger } from '../audit/index.js';
import { initializeSecretsVault } from '../secrets/index.js';

const program = new Command();

// =============================================================================
// Initialization
// =============================================================================

async function initializeAll(): Promise<void> {
  const config = getConfig();
  initializeSigningKey(process.env['SIGNING_KEY']);
  if (config.secretsEncryptionKey) {
    initializeEncryptionKey(config.secretsEncryptionKey);
  }

  runMigrations();

  await initializeRegistry();
  await initializeSecretsVault();
  await initializeAuditLedger();
  await initializeGateway();
  await initializePlanner();
  await initializeSimulator();
  await initializeExecutor();
  await initializeWorkflowEngine();
}

// =============================================================================
// Commands
// =============================================================================

program
  .name('aegis')
  .description('AEGIS-T2A: Text-to-Action Anywhere Platform CLI')
  .version('0.1.0');

// Intent command
program
  .command('intent')
  .description('Process a natural language intent')
  .argument('<text>', 'The intent text to process')
  .option('-u, --user <userId>', 'User ID', 'cli-user')
  .option('-e, --env <environment>', 'Environment (development/staging/production)', 'development')
  .option('--execute', 'Execute the workflow after planning')
  .option('--dry-run', 'Run in dry-run mode')
  .action(async (text: string, options) => {
    try {
      await initializeAll();

      console.log('\n📝 Processing intent:', text);
      console.log('─'.repeat(60));

      // Process intent
      const gateway = getGateway();
      const intentResult = await gateway.processRequest({
        userId: options.user,
        text,
        environment: options.env,
      });

      if (!intentResult.success || !intentResult.intent) {
        console.error('❌ Intent processing failed:', intentResult.error);
        if (intentResult.clarificationNeeded) {
          console.log('\n❓ Clarification needed:');
          intentResult.clarificationQuestions?.forEach((q: string) => console.log(`   • ${q}`));
        }
        process.exit(1);
      }

      console.log('✅ Intent created:', intentResult.intent.intentId);
      console.log('   Risk level:', intentResult.intent.riskLevel);
      console.log('   Approval required:', intentResult.intent.approvalRequired);

      // Generate plan
      console.log('\n📋 Generating plan...');
      const planner = getPlanner();
      const planResult = await planner.generatePlan(intentResult.intent);

      if (!planResult.success || !planResult.plan) {
        console.error('❌ Plan generation failed:', planResult.error);
        process.exit(1);
      }

      console.log('✅ Plan generated:', planResult.plan.planId);
      console.log('   Steps:', planResult.plan.steps.length);
      console.log('   Estimated cost: $', planResult.plan.totalEstimatedCost.toFixed(2));
      console.log('   Risk level:', planResult.plan.riskLevel);

      // Show steps
      console.log('\n📌 Plan steps:');
      planResult.plan.steps.forEach((step, i) => {
        console.log(`   ${i + 1}. [${step.riskLevel}] ${step.action}`);
        console.log(`      └─ ${step.description}`);
      });

      // Simulate
      console.log('\n🧪 Running simulation...');
      const simulator = getSimulator();
      const simResult = await simulator.simulate(planResult.plan);

      console.log('✅ Simulation completed');
      console.log('   Status:', simResult.status);
      console.log('   Risk score:', simResult.riskScore);
      console.log('   Blast radius:', simResult.blastRadius);

      if (simResult.anomalies.length > 0) {
        console.log('   ⚠️  Anomalies:');
        simResult.anomalies.forEach((a: string) => console.log(`      • ${a}`));
      }

      // Execute if requested
      if (options.execute) {
        console.log('\n🚀 Creating workflow...');
        const workflowEngine = getWorkflowEngine();
        const workflow = await workflowEngine.createWorkflow(planResult.plan);

        console.log('✅ Workflow created:', workflow.workflowId);
        console.log('   Status:', workflow.status);

        if (workflow.status === 'awaiting_approval') {
          console.log('\n⏳ Workflow requires approval before execution');
          console.log('   Use: aegis workflow approve', workflow.workflowId);
        } else {
          console.log('\n▶️  Starting execution...');
          const executor = getExecutor();
          workflowEngine.setStepExecutor((step, ctx) => executor.executeStep(step, ctx));

          await workflowEngine.startWorkflow(workflow.workflowId, planResult.plan, {
            dryRun: options.dryRun,
          });

          const final = await workflowEngine.getWorkflow(workflow.workflowId);
          console.log('✅ Execution completed');
          console.log('   Final status:', final?.status);
          console.log('   Completed steps:', final?.completedSteps.length);
        }
      }

      console.log('\n' + '─'.repeat(60));
      console.log('Done!');

    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Workflow commands
program
  .command('workflow')
  .description('Manage workflows')
  .argument('<action>', 'Action: list, status, approve, reject, cancel')
  .argument('[workflowId]', 'Workflow ID')
  .option('-r, --reason <reason>', 'Reason for rejection')
  .action(async (action: string, workflowId: string | undefined, options) => {
    try {
      await initializeAll();

      const workflowEngine = getWorkflowEngine();

      switch (action) {
        case 'status':
          if (!workflowId) {
            console.error('Workflow ID required');
            process.exit(1);
          }
          const workflow = await workflowEngine.getWorkflow(workflowId);
          if (!workflow) {
            console.error('Workflow not found');
            process.exit(1);
          }
          console.log(JSON.stringify(workflow, null, 2));
          break;

        case 'approve':
          if (!workflowId) {
            console.error('Workflow ID required');
            process.exit(1);
          }
          await workflowEngine.approveWorkflow(workflowId, 'cli-user');
          console.log('Workflow approved');
          break;

        case 'reject':
          if (!workflowId) {
            console.error('Workflow ID required');
            process.exit(1);
          }
          await workflowEngine.rejectWorkflow(workflowId, 'cli-user', options.reason ?? 'Rejected via CLI');
          console.log('Workflow rejected');
          break;

        case 'cancel':
          if (!workflowId) {
            console.error('Workflow ID required');
            process.exit(1);
          }
          await workflowEngine.cancelWorkflow(workflowId);
          console.log('Workflow cancelled');
          break;

        default:
          console.error('Unknown action:', action);
          process.exit(1);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Audit commands
program
  .command('audit')
  .description('View audit logs')
  .option('-n, --limit <number>', 'Number of events to show', '20')
  .option('-w, --workflow <workflowId>', 'Filter by workflow ID')
  .option('-i, --intent <intentId>', 'Filter by intent ID')
  .option('--verify', 'Verify audit chain integrity')
  .action(async (options) => {
    try {
      await initializeAll();

      const auditLedger = getAuditLedger();

      if (options.verify) {
        console.log('Verifying audit chain...');
        const result = await auditLedger.verifyChain();
        console.log('Valid:', result.valid);
        console.log('Events checked:', result.eventsChecked);
        if (result.errors.length > 0) {
          console.log('Errors:');
          result.errors.forEach((e: string) => console.log(`  • ${e}`));
        }
        return;
      }

      const events = await auditLedger.query({
        limit: parseInt(options.limit),
        workflowId: options.workflow,
        intentId: options.intent,
      });

      console.log(`Showing ${events.length} events:\n`);
      events.forEach((event) => {
        const status = event.success ? '✅' : '❌';
        console.log(`${status} [${event.timestamp}] ${event.eventType}`);
        console.log(`   Action: ${event.action}`);
        if (event.workflowId) console.log(`   Workflow: ${event.workflowId}`);
        console.log();
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Registry commands
program
  .command('registry')
  .description('View registered tool adapters')
  .action(async () => {
    try {
      await initializeAll();

      const registry = getRegistry();
      const adapters = registry.getAllAdapters();

      console.log(`Registered adapters (${adapters.length}):\n`);
      adapters.forEach((adapter) => {
        console.log(`📦 ${adapter.name} (${adapter.adapterId})`);
        console.log(`   Version: ${adapter.version}`);
        console.log(`   Risk level: ${adapter.riskLevel}`);
        console.log(`   Capabilities: ${adapter.capabilities.join(', ')}`);
        console.log();
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Parse and run
program.parse();
