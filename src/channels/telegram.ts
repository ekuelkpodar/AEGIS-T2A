/**
 * AEGIS-T2A Telegram Channel
 *
 * Telegram bot integration for natural language commands.
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

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface PendingApproval {
  workflowId: string;
  planId: string;
  userId: string;
  chatId: number;
  messageId: number;
  createdAt: Date;
}

// =============================================================================
// Telegram Bot
// =============================================================================

export class TelegramBot {
  private botToken: string;
  private baseUrl: string;
  private offset: number = 0;
  private running: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private authorizedUsers: Set<number> = new Set();

  constructor(config: { botToken: string; authorizedUsers?: number[] }) {
    this.botToken = config.botToken;
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;

    if (config.authorizedUsers) {
      config.authorizedUsers.forEach(id => this.authorizedUsers.add(id));
    }
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.running) return;

    logger.info('Starting Telegram bot...');

    // Verify token
    const me = await this.getMe();
    logger.info({ username: me.username }, 'Telegram bot authenticated');

    // Start polling
    this.running = true;
    this.poll();
  }

  /**
   * Stop the bot
   */
  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
    logger.info('Telegram bot stopped');
  }

  /**
   * Poll for updates
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const updates = await this.getUpdates();

      for (const update of updates) {
        this.offset = update.update_id + 1;
        await this.handleUpdate(update);
      }
    } catch (error) {
      logger.error({ error }, 'Error polling Telegram updates');
    }

    // Schedule next poll
    this.pollInterval = setTimeout(() => this.poll(), 1000);
  }

  /**
   * Handle an update
   */
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    try {
      if (update.message) {
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      logger.error({ error, update }, 'Error handling Telegram update');
    }
  }

  /**
   * Handle a message
   */
  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!message.text || !message.from) return;

    const userId = message.from.id;
    const chatId = message.chat.id;
    const text = message.text.trim();

    // Check authorization
    if (this.authorizedUsers.size > 0 && !this.authorizedUsers.has(userId)) {
      await this.sendMessage(chatId, '⛔ You are not authorized to use this bot.');
      return;
    }

    // Handle commands
    if (text.startsWith('/')) {
      await this.handleCommand(message, text);
      return;
    }

    // Process as intent
    await this.processIntent(message, text);
  }

  /**
   * Handle a command
   */
  private async handleCommand(message: TelegramMessage, command: string): Promise<void> {
    const chatId = message.chat.id;
    const parts = command.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/start':
        await this.sendMessage(
          chatId,
          '👋 Welcome to AEGIS-T2A!\n\n' +
          'I can help you automate tasks across cloud and on-premises systems.\n\n' +
          'Just send me a natural language command, for example:\n' +
          '• "Create an S3 bucket called my-data"\n' +
          '• "List all EC2 instances"\n' +
          '• "Deploy my-app to staging"\n\n' +
          'Commands:\n' +
          '/help - Show this help\n' +
          '/status - Check system status\n' +
          '/cancel <id> - Cancel a workflow'
        );
        break;

      case '/help':
        await this.sendMessage(
          chatId,
          '📖 *AEGIS-T2A Help*\n\n' +
          '*Usage:*\n' +
          'Send any natural language command to execute actions.\n\n' +
          '*Commands:*\n' +
          '/start - Welcome message\n' +
          '/help - This help message\n' +
          '/status - System status\n' +
          '/cancel <id> - Cancel workflow\n\n' +
          '*Examples:*\n' +
          '• Create a new EC2 instance\n' +
          '• Scale my-service to 5 replicas\n' +
          '• Backup database to S3',
          { parse_mode: 'Markdown' }
        );
        break;

      case '/status':
        await this.sendStatus(chatId);
        break;

      case '/cancel':
        if (parts.length < 2) {
          await this.sendMessage(chatId, 'Usage: /cancel <workflow-id>');
          return;
        }
        await this.cancelWorkflow(chatId, parts[1]);
        break;

      default:
        await this.sendMessage(
          chatId,
          'Unknown command. Use /help for available commands.'
        );
    }
  }

  /**
   * Process an intent
   */
  private async processIntent(message: TelegramMessage, text: string): Promise<void> {
    const chatId = message.chat.id;
    const userId = `telegram:${message.from!.id}`;

    // Send processing message
    const processingMsg = await this.sendMessage(
      chatId,
      '⏳ Processing your request...'
    );

    try {
      // Parse intent
      const gateway = getGateway();
      const intentResult = await gateway.processRequest({
        userId,
        text,
        environment: 'production',
      });

      if (!intentResult.success || !intentResult.intent) {
        await this.editMessage(
          chatId,
          processingMsg.message_id,
          `❌ Failed to process intent: ${intentResult.error || 'Unknown error'}`
        );
        return;
      }

      // Generate plan
      const planner = getPlanner();
      const planResult = await planner.generatePlan(intentResult.intent);

      if (!planResult.success || !planResult.plan) {
        await this.editMessage(
          chatId,
          processingMsg.message_id,
          `❌ Failed to generate plan: ${planResult.error || 'Unknown error'}`
        );
        return;
      }

      // Run simulation
      const simulator = getSimulator();
      const simResult = await simulator.simulate(planResult.plan);

      // Show plan summary
      const planSummary = this.formatPlanSummary(planResult.plan, simResult);

      if (planResult.plan.requiresApproval) {
        // Send approval request
        const approvalMsg = await this.editMessage(
          chatId,
          processingMsg.message_id,
          planSummary,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Approve', callback_data: `approve:${planResult.plan.planId}` },
                  { text: '❌ Reject', callback_data: `reject:${planResult.plan.planId}` },
                ],
                [
                  { text: '🔍 Details', callback_data: `details:${planResult.plan.planId}` },
                ],
              ],
            },
          }
        );

        // Create workflow but don't start
        const workflowEngine = getWorkflowEngine();
        const workflow = await workflowEngine.createWorkflow(planResult.plan);

        // Store pending approval
        this.pendingApprovals.set(planResult.plan.planId, {
          workflowId: workflow.workflowId,
          planId: planResult.plan.planId,
          userId,
          chatId,
          messageId: approvalMsg.message_id,
          createdAt: new Date(),
        });
      } else {
        // Execute directly
        await this.editMessage(
          chatId,
          processingMsg.message_id,
          planSummary + '\n\n⏳ Executing...',
          { parse_mode: 'Markdown' }
        );

        await this.executeWorkflow(chatId, processingMsg.message_id, planResult.plan);
      }
    } catch (error) {
      logger.error({ error }, 'Error processing Telegram intent');
      await this.editMessage(
        chatId,
        processingMsg.message_id,
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle callback query (button press)
   */
  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!query.data || !query.message) return;

    const [action, planId] = query.data.split(':');
    const pending = this.pendingApprovals.get(planId);

    if (!pending) {
      await this.answerCallbackQuery(query.id, 'This action has expired.');
      return;
    }

    switch (action) {
      case 'approve':
        await this.answerCallbackQuery(query.id, 'Approved! Executing...');
        await this.approveAndExecute(pending);
        break;

      case 'reject':
        await this.answerCallbackQuery(query.id, 'Rejected.');
        await this.rejectWorkflow(pending);
        break;

      case 'details':
        await this.answerCallbackQuery(query.id);
        await this.showPlanDetails(pending);
        break;

      default:
        await this.answerCallbackQuery(query.id, 'Unknown action.');
    }
  }

  /**
   * Approve and execute workflow
   */
  private async approveAndExecute(pending: PendingApproval): Promise<void> {
    try {
      const workflowEngine = getWorkflowEngine();
      await workflowEngine.approveWorkflow(pending.workflowId, pending.userId);

      // Get plan for execution
      const planner = getPlanner();
      const plan = await planner.getPlan(pending.planId);

      if (!plan) {
        await this.editMessage(
          pending.chatId,
          pending.messageId,
          '❌ Plan not found.'
        );
        return;
      }

      await this.executeWorkflow(pending.chatId, pending.messageId, plan);
    } catch (error) {
      logger.error({ error }, 'Error approving workflow');
      await this.editMessage(
        pending.chatId,
        pending.messageId,
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
      await workflowEngine.rejectWorkflow(
        pending.workflowId,
        pending.userId,
        'Rejected via Telegram'
      );

      await this.editMessage(
        pending.chatId,
        pending.messageId,
        '❌ Workflow rejected.'
      );
    } catch (error) {
      logger.error({ error }, 'Error rejecting workflow');
    } finally {
      this.pendingApprovals.delete(pending.planId);
    }
  }

  /**
   * Execute workflow and report progress
   */
  private async executeWorkflow(
    chatId: number,
    messageId: number,
    plan: any
  ): Promise<void> {
    const workflowEngine = getWorkflowEngine();
    const executor = getExecutor();

    // Set step executor
    workflowEngine.setStepExecutor((step, ctx) => executor.executeStep(step, ctx));

    // Create and start workflow
    const workflow = await workflowEngine.createWorkflow(plan);
    await workflowEngine.startWorkflow(workflow.workflowId, plan);

    // Get final status
    const finalWorkflow = await workflowEngine.getWorkflow(workflow.workflowId);

    if (finalWorkflow?.status === 'completed') {
      await this.editMessage(
        chatId,
        messageId,
        '✅ *Workflow Completed*\n\n' +
        `Steps completed: ${finalWorkflow.completedSteps.length}`,
        { parse_mode: 'Markdown' }
      );
    } else if (finalWorkflow?.status === 'failed') {
      await this.editMessage(
        chatId,
        messageId,
        '❌ *Workflow Failed*\n\n' +
        `Error: ${finalWorkflow.error || 'Unknown error'}`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  /**
   * Show plan details
   */
  private async showPlanDetails(pending: PendingApproval): Promise<void> {
    const planner = getPlanner();
    const plan = await planner.getPlan(pending.planId);

    if (!plan) {
      await this.sendMessage(pending.chatId, 'Plan not found.');
      return;
    }

    const details = plan.steps.map((step: any, i: number) =>
      `${i + 1}. *${step.action}*\n   ${step.description}`
    ).join('\n\n');

    await this.sendMessage(
      pending.chatId,
      `📋 *Plan Details*\n\n${details}`,
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Send status
   */
  private async sendStatus(chatId: number): Promise<void> {
    await this.sendMessage(
      chatId,
      '🟢 *System Status: Online*\n\n' +
      'All components operational.',
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Cancel workflow
   */
  private async cancelWorkflow(chatId: number, workflowId: string): Promise<void> {
    try {
      const workflowEngine = getWorkflowEngine();
      await workflowEngine.cancelWorkflow(workflowId);
      await this.sendMessage(chatId, `✅ Workflow ${workflowId} cancelled.`);
    } catch (error) {
      await this.sendMessage(
        chatId,
        `❌ Failed to cancel: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Format plan summary for Telegram
   */
  private formatPlanSummary(plan: any, simulation: any): string {
    const riskEmoji: Record<string, string> = {
      low: '🟢',
      medium: '🟡',
      high: '🟠',
      critical: '🔴',
    };

    return (
      `📋 *Plan Generated*\n\n` +
      `*Risk Level:* ${riskEmoji[plan.riskLevel] || '⚪'} ${plan.riskLevel}\n` +
      `*Steps:* ${plan.steps.length}\n` +
      `*Estimated Cost:* $${plan.totalEstimatedCost?.toFixed(2) || '0.00'}\n` +
      `*Simulation Score:* ${simulation.riskScore}/100\n` +
      (plan.requiresApproval ? '\n⚠️ *Requires approval*' : '')
    );
  }

  // ===========================================================================
  // Telegram API Methods
  // ===========================================================================

  private async request(method: string, params: Record<string, any> = {}): Promise<any> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }

    return data.result;
  }

  private async getMe(): Promise<TelegramUser> {
    return this.request('getMe');
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    return this.request('getUpdates', {
      offset: this.offset,
      timeout: 30,
    });
  }

  private async sendMessage(
    chatId: number,
    text: string,
    options: Record<string, any> = {}
  ): Promise<TelegramMessage> {
    return this.request('sendMessage', {
      chat_id: chatId,
      text,
      ...options,
    });
  }

  private async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    options: Record<string, any> = {}
  ): Promise<TelegramMessage> {
    return this.request('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options,
    });
  }

  private async answerCallbackQuery(
    callbackQueryId: string,
    text?: string
  ): Promise<boolean> {
    return this.request('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }
}

// =============================================================================
// Factory
// =============================================================================

let telegramBot: TelegramBot | null = null;

export function initializeTelegramBot(config?: {
  botToken: string;
  authorizedUsers?: number[];
}): TelegramBot {
  const botToken = config?.botToken || process.env['TELEGRAM_BOT_TOKEN'];

  if (!botToken) {
    throw new Error('Telegram bot token not configured');
  }

  const authorizedUsers = config?.authorizedUsers ||
    process.env['TELEGRAM_AUTHORIZED_USERS']?.split(',').map(Number);

  telegramBot = new TelegramBot({
    botToken,
    authorizedUsers,
  });

  return telegramBot;
}

export function getTelegramBot(): TelegramBot | null {
  return telegramBot;
}
