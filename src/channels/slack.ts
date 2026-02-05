/**
 * AEGIS-T2A Slack Channel
 *
 * Slack bot integration for natural language commands.
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

interface SlackEvent {
  type: string;
  user?: string;
  channel?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
}

interface SlackEventPayload {
  type: string;
  token?: string;
  challenge?: string;
  team_id?: string;
  event?: SlackEvent;
}

interface SlackInteraction {
  type: 'block_actions' | 'message_action' | 'shortcut';
  user: { id: string; username: string };
  channel?: { id: string };
  message?: { ts: string };
  actions?: Array<{
    action_id: string;
    value: string;
    type: string;
  }>;
  response_url?: string;
  trigger_id?: string;
}

interface PendingApproval {
  workflowId: string;
  planId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  responseUrl: string;
  createdAt: Date;
}

// =============================================================================
// Slack Bot
// =============================================================================

export class SlackBot {
  private botToken: string;
  private baseUrl = 'https://slack.com/api';
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private authorizedUsers: Set<string> = new Set();
  private authorizedChannels: Set<string> = new Set();

  constructor(config: {
    botToken: string;
    signingSecret?: string;
    appToken?: string;
    authorizedUsers?: string[];
    authorizedChannels?: string[];
  }) {
    this.botToken = config.botToken;
    // signingSecret and appToken are used for Slack Events API signature verification
    // They're stored in config but we use simple webhook-based interaction for now

    if (config.authorizedUsers) {
      config.authorizedUsers.forEach(id => this.authorizedUsers.add(id));
    }
    if (config.authorizedChannels) {
      config.authorizedChannels.forEach(id => this.authorizedChannels.add(id));
    }
  }

  /**
   * Handle URL verification challenge
   */
  handleChallenge(payload: SlackEventPayload): string | null {
    if (payload.type === 'url_verification' && payload.challenge) {
      return payload.challenge;
    }
    return null;
  }

  /**
   * Handle incoming event
   */
  async handleEvent(payload: SlackEventPayload): Promise<void> {
    // Handle URL verification
    if (payload.type === 'url_verification') {
      return;
    }

    if (payload.type !== 'event_callback' || !payload.event) {
      return;
    }

    const event = payload.event;

    // Ignore bot messages
    if (event.bot_id) return;

    // Handle app mentions and direct messages
    if (event.type === 'app_mention' || event.type === 'message') {
      await this.handleMessage(event);
    }
  }

  /**
   * Handle message event
   */
  private async handleMessage(event: SlackEvent): Promise<void> {
    if (!event.text || !event.user || !event.channel) return;

    const userId = event.user;
    const channelId = event.channel;
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    const threadTs = event.thread_ts || event.ts;

    // Check authorization
    if (this.authorizedUsers.size > 0 && !this.authorizedUsers.has(userId)) {
      await this.postMessage(channelId, '⛔ You are not authorized to use this bot.', threadTs);
      return;
    }

    if (this.authorizedChannels.size > 0 && !this.authorizedChannels.has(channelId)) {
      await this.postMessage(channelId, '⛔ This channel is not authorized for AEGIS-T2A.', threadTs);
      return;
    }

    // Handle commands
    if (text.toLowerCase().startsWith('help')) {
      await this.sendHelp(channelId, threadTs);
      return;
    }

    if (text.toLowerCase().startsWith('status')) {
      await this.sendStatus(channelId, threadTs);
      return;
    }

    // Process as intent
    await this.processIntent(channelId, `slack:${userId}`, text, threadTs);
  }

  /**
   * Handle interaction (button clicks)
   */
  async handleInteraction(interaction: SlackInteraction): Promise<void> {
    if (interaction.type !== 'block_actions' || !interaction.actions?.length) {
      return;
    }

    const action = interaction.actions[0];
    if (!action) return;
    const [actionType, planId] = action.action_id.split(':');
    const pending = planId ? this.pendingApprovals.get(planId) : undefined;

    if (!pending) {
      if (interaction.response_url) {
        await this.respondToInteraction(interaction.response_url, {
          text: 'This action has expired.',
          replace_original: false,
        });
      }
      return;
    }

    const userId = `slack:${interaction.user.id}`;

    switch (actionType) {
      case 'approve':
        await this.approveAndExecute(pending, userId, interaction.response_url);
        break;

      case 'reject':
        await this.rejectWorkflow(pending, userId, interaction.response_url);
        break;

      case 'details':
        await this.showPlanDetails(pending, interaction.response_url);
        break;
    }
  }

  /**
   * Process intent
   */
  private async processIntent(
    channelId: string,
    userId: string,
    text: string,
    threadTs?: string
  ): Promise<void> {
    // Send processing message
    const processingMsg = await this.postMessage(channelId, '⏳ Processing your request...', threadTs);

    try {
      // Parse intent
      const gateway = getGateway();
      const intentResult = await gateway.processRequest({
        userId,
        text,
        environment: 'production',
      });

      if (!intentResult.success || !intentResult.intent) {
        await this.updateMessage(
          channelId,
          processingMsg.ts,
          `❌ Failed to process: ${intentResult.error || 'Unknown error'}`
        );
        return;
      }

      // Generate plan
      const planner = getPlanner();
      const planResult = await planner.generatePlan(intentResult.intent);

      if (!planResult.success || !planResult.plan) {
        await this.updateMessage(
          channelId,
          processingMsg.ts,
          `❌ Failed to plan: ${planResult.error || 'Unknown error'}`
        );
        return;
      }

      // Run simulation
      const simulator = getSimulator();
      const simResult = await simulator.simulate(planResult.plan);

      // Format plan summary
      const blocks = this.formatPlanBlocks(planResult.plan, simResult);

      if (planResult.plan.approvalRequired) {
        // Add approval buttons
        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Approve', emoji: true },
              style: 'primary',
              action_id: `approve:${planResult.plan.planId}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Reject', emoji: true },
              style: 'danger',
              action_id: `reject:${planResult.plan.planId}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '🔍 Details', emoji: true },
              action_id: `details:${planResult.plan.planId}`,
            },
          ],
        });

        await this.updateMessage(channelId, processingMsg.ts, undefined, blocks);

        // Create workflow
        const workflowEngine = getWorkflowEngine();
        const workflow = await workflowEngine.createWorkflow(planResult.plan);

        // Store pending approval
        this.pendingApprovals.set(planResult.plan.planId, {
          workflowId: workflow.workflowId,
          planId: planResult.plan.planId,
          userId,
          channelId,
          messageTs: processingMsg.ts,
          responseUrl: '',
          createdAt: new Date(),
        });
      } else {
        await this.updateMessage(channelId, processingMsg.ts, undefined, blocks);
        await this.postMessage(channelId, '⏳ Executing...', threadTs);
        await this.executeWorkflow(channelId, threadTs, planResult.plan);
      }
    } catch (error) {
      logger.error({ error }, 'Error processing Slack intent');
      await this.updateMessage(
        channelId,
        processingMsg.ts,
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Approve and execute workflow
   */
  private async approveAndExecute(
    pending: PendingApproval,
    userId: string,
    _responseUrl?: string
  ): Promise<void> {
    try {
      const workflowEngine = getWorkflowEngine();
      await workflowEngine.approveWorkflow(pending.workflowId, userId);

      const planner = getPlanner();
      const plan = await planner.getPlan(pending.planId);

      if (!plan) {
        await this.postMessage(pending.channelId, '❌ Plan not found.');
        return;
      }

      await this.updateMessage(pending.channelId, pending.messageTs, '✅ Approved! Executing...');
      await this.executeWorkflow(pending.channelId, undefined, plan);
    } catch (error) {
      logger.error({ error }, 'Error approving Slack workflow');
      await this.postMessage(
        pending.channelId,
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      this.pendingApprovals.delete(pending.planId);
    }
  }

  /**
   * Reject workflow
   */
  private async rejectWorkflow(
    pending: PendingApproval,
    userId: string,
    _responseUrl?: string
  ): Promise<void> {
    try {
      const workflowEngine = getWorkflowEngine();
      await workflowEngine.rejectWorkflow(pending.workflowId, userId, 'Rejected via Slack');

      await this.updateMessage(pending.channelId, pending.messageTs, '❌ Workflow rejected.');
    } catch (error) {
      logger.error({ error }, 'Error rejecting Slack workflow');
    } finally {
      this.pendingApprovals.delete(pending.planId);
    }
  }

  /**
   * Show plan details
   */
  private async showPlanDetails(pending: PendingApproval, _responseUrl?: string): Promise<void> {
    const planner = getPlanner();
    const plan = await planner.getPlan(pending.planId);

    if (!plan) {
      await this.postMessage(pending.channelId, 'Plan not found.');
      return;
    }

    const details = plan.steps
      .map((step: any, i: number) => `${i + 1}. *${step.action}*: ${step.description}`)
      .join('\n');

    await this.postMessage(pending.channelId, `📋 *Plan Details*\n\n${details}`);
  }

  /**
   * Execute workflow
   */
  private async executeWorkflow(
    channelId: string,
    threadTs: string | undefined,
    plan: any
  ): Promise<void> {
    const workflowEngine = getWorkflowEngine();
    const executor = getExecutor();

    workflowEngine.setStepExecutor((step, ctx) => executor.executeStep(step, ctx));

    const workflow = await workflowEngine.createWorkflow(plan);
    await workflowEngine.startWorkflow(workflow.workflowId, plan);

    const finalWorkflow = await workflowEngine.getWorkflow(workflow.workflowId);

    if (finalWorkflow?.status === 'completed') {
      await this.postMessage(
        channelId,
        `✅ *Workflow Completed*\nSteps completed: ${finalWorkflow.completedSteps.length}`,
        threadTs
      );
    } else if (finalWorkflow?.status === 'failed') {
      await this.postMessage(
        channelId,
        `❌ *Workflow Failed*\nError: ${finalWorkflow.error || 'Unknown error'}`,
        threadTs
      );
    }
  }

  /**
   * Format plan blocks
   */
  private formatPlanBlocks(plan: any, simulation: any): any[] {
    const riskEmoji: Record<string, string> = {
      low: '🟢',
      medium: '🟡',
      high: '🟠',
      critical: '🔴',
    };

    return [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📋 Plan Generated', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Risk Level:*\n${riskEmoji[plan.riskLevel] || '⚪'} ${plan.riskLevel}` },
          { type: 'mrkdwn', text: `*Steps:*\n${plan.steps.length}` },
          { type: 'mrkdwn', text: `*Simulation Score:*\n${simulation.riskScore}/100` },
          { type: 'mrkdwn', text: `*Requires Approval:*\n${plan.requiresApproval ? 'Yes' : 'No'}` },
        ],
      },
      { type: 'divider' },
    ];
  }

  /**
   * Send help message
   */
  private async sendHelp(channelId: string, threadTs?: string): Promise<void> {
    await this.postMessage(
      channelId,
      '👋 *AEGIS-T2A Help*\n\n' +
      'Mention me with any natural language command to automate tasks.\n\n' +
      '*Examples:*\n' +
      '• @aegis Create an S3 bucket called my-data\n' +
      '• @aegis List all EC2 instances\n' +
      '• @aegis Deploy my-app to staging\n\n' +
      '*Commands:*\n' +
      '• `help` - Show this help\n' +
      '• `status` - System status',
      threadTs
    );
  }

  /**
   * Send status message
   */
  private async sendStatus(channelId: string, threadTs?: string): Promise<void> {
    await this.postMessage(
      channelId,
      '🟢 *System Status: Online*\n\nAll components operational.',
      threadTs
    );
  }

  // ===========================================================================
  // Slack API Methods
  // ===========================================================================

  private async request(method: string, params: Record<string, any>): Promise<any> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.botToken}`,
      },
      body: JSON.stringify(params),
    });

    const data = await response.json() as { ok: boolean; error?: string };

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  private async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
    blocks?: any[]
  ): Promise<{ ts: string }> {
    const params: Record<string, any> = { channel, text };
    if (threadTs) params.thread_ts = threadTs;
    if (blocks) params.blocks = blocks;

    return this.request('chat.postMessage', params);
  }

  private async updateMessage(
    channel: string,
    ts: string,
    text?: string,
    blocks?: any[]
  ): Promise<void> {
    const params: Record<string, any> = { channel, ts };
    if (text) params.text = text;
    if (blocks) params.blocks = blocks;

    await this.request('chat.update', params);
  }

  private async respondToInteraction(
    responseUrl: string,
    payload: Record<string, any>
  ): Promise<void> {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}

// =============================================================================
// Factory
// =============================================================================

let slackBot: SlackBot | null = null;

export function initializeSlackBot(config?: {
  botToken: string;
  signingSecret?: string;
  appToken?: string;
  authorizedUsers?: string[];
  authorizedChannels?: string[];
}): SlackBot {
  const botToken = config?.botToken || process.env['SLACK_BOT_TOKEN'];

  if (!botToken) {
    throw new Error('Slack bot token not configured');
  }

  slackBot = new SlackBot({
    botToken,
    signingSecret: config?.signingSecret || process.env['SLACK_SIGNING_SECRET'],
    appToken: config?.appToken || process.env['SLACK_APP_TOKEN'],
    authorizedUsers: config?.authorizedUsers ||
      process.env['SLACK_AUTHORIZED_USERS']?.split(','),
    authorizedChannels: config?.authorizedChannels ||
      process.env['SLACK_AUTHORIZED_CHANNELS']?.split(','),
  });

  return slackBot;
}

export function getSlackBot(): SlackBot | null {
  return slackBot;
}
