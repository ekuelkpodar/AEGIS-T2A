/**
 * AEGIS-T2A WhatsApp Channel
 *
 * WhatsApp Business API integration for natural language commands.
 */

import { logger } from '../core/logger.js';
import { getGateway } from '../gateway/index.js';
import { getPlanner } from '../planner/index.js';
import { getSimulator } from '../simulation/index.js';
import { getWorkflowEngine } from '../workflow/index.js';
import { getExecutor } from '../executor/index.js';

// =============================================================================
// Types
// =============================================================================

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  text?: { body: string };
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'interactive';
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description: string };
  };
}

interface WhatsAppWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { phone_number_id: string };
        messages?: WhatsAppMessage[];
        statuses?: Array<{ id: string; status: string }>;
      };
      field: string;
    }>;
  }>;
}

interface PendingApproval {
  workflowId: string;
  planId: string;
  userId: string;
  phoneNumber: string;
  createdAt: Date;
}

// =============================================================================
// WhatsApp Client
// =============================================================================

export class WhatsAppClient {
  private phoneNumberId: string;
  private accessToken: string;
  private webhookVerifyToken: string;
  private baseUrl: string;
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private authorizedNumbers: Set<string> = new Set();

  constructor(config: {
    phoneNumberId: string;
    accessToken: string;
    webhookVerifyToken?: string;
    authorizedNumbers?: string[];
  }) {
    this.phoneNumberId = config.phoneNumberId;
    this.accessToken = config.accessToken;
    this.webhookVerifyToken = config.webhookVerifyToken || 'aegis-verify-token';
    this.baseUrl = `https://graph.facebook.com/v18.0/${this.phoneNumberId}`;

    if (config.authorizedNumbers) {
      config.authorizedNumbers.forEach(num => this.authorizedNumbers.add(num));
    }
  }

  /**
   * Verify webhook challenge
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === this.webhookVerifyToken) {
      logger.info('WhatsApp webhook verified');
      return challenge;
    }
    return null;
  }

  /**
   * Handle incoming webhook
   */
  async handleWebhook(payload: WhatsAppWebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') return;

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const messages = change.value.messages || [];
        for (const message of messages) {
          await this.handleMessage(message);
        }
      }
    }
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(message: WhatsAppMessage): Promise<void> {
    const phoneNumber = message.from;
    const userId = `whatsapp:${phoneNumber}`;

    // Check authorization
    if (this.authorizedNumbers.size > 0 && !this.authorizedNumbers.has(phoneNumber)) {
      await this.sendText(phoneNumber, '⛔ You are not authorized to use this service.');
      return;
    }

    try {
      // Handle text messages
      if (message.type === 'text' && message.text) {
        const text = message.text.body.trim();

        // Handle commands
        if (text.toLowerCase().startsWith('/')) {
          await this.handleCommand(phoneNumber, text);
          return;
        }

        // Process as intent
        await this.processIntent(phoneNumber, userId, text);
      }

      // Handle interactive responses (button clicks)
      if (message.type === 'interactive' && message.interactive) {
        await this.handleInteractive(phoneNumber, userId, message.interactive);
      }
    } catch (error) {
      logger.error({ error, message }, 'Error handling WhatsApp message');
      await this.sendText(
        phoneNumber,
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle command
   */
  private async handleCommand(phoneNumber: string, command: string): Promise<void> {
    const parts = command.split(' ');
    const cmd = (parts[0] ?? '').toLowerCase();

    switch (cmd) {
      case '/start':
      case '/help':
        await this.sendText(
          phoneNumber,
          '👋 *Welcome to AEGIS-T2A!*\n\n' +
          'I can help you automate tasks across cloud and on-premises systems.\n\n' +
          '*Just send me a command like:*\n' +
          '• Create an S3 bucket called my-data\n' +
          '• List all EC2 instances\n' +
          '• Deploy my-app to staging\n\n' +
          '*Commands:*\n' +
          '/help - Show this help\n' +
          '/status - System status\n' +
          '/cancel <id> - Cancel workflow'
        );
        break;

      case '/status':
        await this.sendText(phoneNumber, '🟢 *System Status: Online*\n\nAll components operational.');
        break;

      case '/cancel':
        if (parts.length < 2 || !parts[1]) {
          await this.sendText(phoneNumber, 'Usage: /cancel <workflow-id>');
          return;
        }
        await this.cancelWorkflow(phoneNumber, parts[1]);
        break;

      default:
        await this.sendText(phoneNumber, 'Unknown command. Send /help for available commands.');
    }
  }

  /**
   * Process intent
   */
  private async processIntent(phoneNumber: string, userId: string, text: string): Promise<void> {
    await this.sendText(phoneNumber, '⏳ Processing your request...');

    try {
      // Parse intent
      const gateway = getGateway();
      const intentResult = await gateway.processRequest({
        userId,
        text,
        environment: 'production',
      });

      if (!intentResult.success || !intentResult.intent) {
        await this.sendText(
          phoneNumber,
          `❌ Failed to process: ${intentResult.error || 'Unknown error'}`
        );
        return;
      }

      // Generate plan
      const planner = getPlanner();
      const planResult = await planner.generatePlan(intentResult.intent);

      if (!planResult.success || !planResult.plan) {
        await this.sendText(
          phoneNumber,
          `❌ Failed to plan: ${planResult.error || 'Unknown error'}`
        );
        return;
      }

      // Run simulation
      const simulator = getSimulator();
      const simResult = await simulator.simulate(planResult.plan);

      // Format plan summary
      const riskEmoji: Record<string, string> = {
        low: '🟢',
        medium: '🟡',
        high: '🟠',
        critical: '🔴',
      };

      const summary =
        `📋 *Plan Generated*\n\n` +
        `*Risk:* ${riskEmoji[planResult.plan.riskLevel] || '⚪'} ${planResult.plan.riskLevel}\n` +
        `*Steps:* ${planResult.plan.steps.length}\n` +
        `*Simulation Score:* ${simResult.riskScore}/100`;

      if (planResult.plan.approvalRequired) {
        // Send approval request with buttons
        await this.sendInteractiveButtons(
          phoneNumber,
          summary + '\n\n⚠️ *Requires approval*',
          [
            { id: `approve:${planResult.plan.planId}`, title: '✅ Approve' },
            { id: `reject:${planResult.plan.planId}`, title: '❌ Reject' },
          ]
        );

        // Create workflow
        const workflowEngine = getWorkflowEngine();
        const workflow = await workflowEngine.createWorkflow(planResult.plan);

        // Store pending approval
        this.pendingApprovals.set(planResult.plan.planId, {
          workflowId: workflow.workflowId,
          planId: planResult.plan.planId,
          userId,
          phoneNumber,
          createdAt: new Date(),
        });
      } else {
        await this.sendText(phoneNumber, summary + '\n\n⏳ Executing...');
        await this.executeWorkflow(phoneNumber, planResult.plan);
      }
    } catch (error) {
      logger.error({ error }, 'Error processing WhatsApp intent');
      throw error;
    }
  }

  /**
   * Handle interactive response
   */
  private async handleInteractive(
    phoneNumber: string,
    _userId: string,
    interactive: WhatsAppMessage['interactive']
  ): Promise<void> {
    if (!interactive) return;

    let buttonId: string | undefined;

    if (interactive.type === 'button_reply' && interactive.button_reply) {
      buttonId = interactive.button_reply.id;
    } else if (interactive.type === 'list_reply' && interactive.list_reply) {
      buttonId = interactive.list_reply.id;
    }

    if (!buttonId) return;

    const [action, planId] = buttonId.split(':');
    const pending = planId ? this.pendingApprovals.get(planId) : undefined;

    if (!pending) {
      await this.sendText(phoneNumber, 'This action has expired.');
      return;
    }

    switch (action) {
      case 'approve':
        await this.approveAndExecute(pending);
        break;

      case 'reject':
        await this.rejectWorkflow(pending);
        break;
    }
  }

  /**
   * Approve and execute workflow
   */
  private async approveAndExecute(pending: PendingApproval): Promise<void> {
    try {
      const workflowEngine = getWorkflowEngine();
      await workflowEngine.approveWorkflow(pending.workflowId, pending.userId);

      const planner = getPlanner();
      const plan = await planner.getPlan(pending.planId);

      if (!plan) {
        await this.sendText(pending.phoneNumber, '❌ Plan not found.');
        return;
      }

      await this.sendText(pending.phoneNumber, '✅ Approved! Executing...');
      await this.executeWorkflow(pending.phoneNumber, plan);
    } catch (error) {
      logger.error({ error }, 'Error approving WhatsApp workflow');
      await this.sendText(
        pending.phoneNumber,
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      this.pendingApprovals.delete(pending.planId);
    }
  }

  /**
   * Reject workflow
   */
  private async rejectWorkflow(pending: PendingApproval): Promise<void> {
    try {
      const workflowEngine = getWorkflowEngine();
      await workflowEngine.rejectWorkflow(pending.workflowId, pending.userId, 'Rejected via WhatsApp');
      await this.sendText(pending.phoneNumber, '❌ Workflow rejected.');
    } catch (error) {
      logger.error({ error }, 'Error rejecting WhatsApp workflow');
    } finally {
      this.pendingApprovals.delete(pending.planId);
    }
  }

  /**
   * Execute workflow
   */
  private async executeWorkflow(phoneNumber: string, plan: any): Promise<void> {
    const workflowEngine = getWorkflowEngine();
    const executor = getExecutor();

    workflowEngine.setStepExecutor((step, ctx) => executor.executeStep(step, ctx));

    const workflow = await workflowEngine.createWorkflow(plan);
    await workflowEngine.startWorkflow(workflow.workflowId, plan);

    const finalWorkflow = await workflowEngine.getWorkflow(workflow.workflowId);

    if (finalWorkflow?.status === 'completed') {
      await this.sendText(
        phoneNumber,
        `✅ *Workflow Completed*\n\nSteps completed: ${finalWorkflow.completedSteps.length}`
      );
    } else if (finalWorkflow?.status === 'failed') {
      await this.sendText(
        phoneNumber,
        `❌ *Workflow Failed*\n\nError: ${finalWorkflow.error || 'Unknown error'}`
      );
    }
  }

  /**
   * Cancel workflow
   */
  private async cancelWorkflow(phoneNumber: string, workflowId: string): Promise<void> {
    try {
      const workflowEngine = getWorkflowEngine();
      await workflowEngine.cancelWorkflow(workflowId);
      await this.sendText(phoneNumber, `✅ Workflow ${workflowId} cancelled.`);
    } catch (error) {
      await this.sendText(
        phoneNumber,
        `❌ Failed to cancel: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // ===========================================================================
  // WhatsApp API Methods
  // ===========================================================================

  private async request(endpoint: string, body: any): Promise<any> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`WhatsApp API error: ${JSON.stringify(error)}`);
    }

    return response.json();
  }

  private async sendText(to: string, text: string): Promise<void> {
    await this.request('/messages', {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    });
  }

  private async sendInteractiveButtons(
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<void> {
    await this.request('/messages', {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map(btn => ({
            type: 'reply',
            reply: { id: btn.id, title: btn.title },
          })),
        },
      },
    });
  }
}

// =============================================================================
// Factory
// =============================================================================

let whatsappClient: WhatsAppClient | null = null;

export function initializeWhatsAppClient(config?: {
  phoneNumberId: string;
  accessToken: string;
  webhookVerifyToken?: string;
  authorizedNumbers?: string[];
}): WhatsAppClient {
  const phoneNumberId = config?.phoneNumberId || process.env['WHATSAPP_PHONE_NUMBER_ID'];
  const accessToken = config?.accessToken || process.env['WHATSAPP_ACCESS_TOKEN'];

  if (!phoneNumberId || !accessToken) {
    throw new Error('WhatsApp credentials not configured');
  }

  whatsappClient = new WhatsAppClient({
    phoneNumberId,
    accessToken,
    webhookVerifyToken: config?.webhookVerifyToken || process.env['WHATSAPP_VERIFY_TOKEN'],
    authorizedNumbers: config?.authorizedNumbers ||
      process.env['WHATSAPP_AUTHORIZED_NUMBERS']?.split(','),
  });

  return whatsappClient;
}

export function getWhatsAppClient(): WhatsAppClient | null {
  return whatsappClient;
}
