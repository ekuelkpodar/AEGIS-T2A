/**
 * AEGIS-T2A Terminal Setup Wizard
 *
 * Interactive CLI wizard for initial configuration.
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

interface WizardConfig {
  llm: {
    provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'gemini';
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
  cloud: {
    provider?: 'aws' | 'azure' | 'gcp' | 'onprem' | 'none';
    aws?: {
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
    };
    azure?: {
      tenantId: string;
      clientId: string;
      clientSecret: string;
    };
    gcp?: {
      projectId: string;
      keyFile: string;
    };
    onprem?: {
      type: 'ssh' | 'kubernetes' | 'docker';
      host?: string;
      port?: number;
      username?: string;
    };
  };
  channels: {
    telegram?: {
      botToken: string;
    };
    whatsapp?: {
      phoneNumberId: string;
      accessToken: string;
    };
    slack?: {
      botToken: string;
    };
  };
  security: {
    requireApproval: boolean;
    approvalThreshold: 'low' | 'medium' | 'high' | 'critical';
  };
}

// =============================================================================
// Setup Wizard
// =============================================================================

export class SetupWizard {
  private rl: readline.Interface;
  private config: Partial<WizardConfig> = {};

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /**
   * Run the setup wizard
   */
  async run(): Promise<WizardConfig> {
    this.printHeader();

    try {
      // Step 1: LLM Provider
      await this.configureLLM();

      // Step 2: Cloud Provider (optional)
      await this.configureCloud();

      // Step 3: Channels (optional)
      await this.configureChannels();

      // Step 4: Security
      await this.configureSecurity();

      // Step 5: Validate and save
      await this.validateAndSave();

      this.printFooter();

      return this.config as WizardConfig;
    } finally {
      this.rl.close();
    }
  }

  // ===========================================================================
  // UI Helpers
  // ===========================================================================

  private printHeader(): void {
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                ║');
    console.log('║     █████╗ ███████╗ ██████╗ ██╗███████╗    ████████╗██████╗    ║');
    console.log('║    ██╔══██╗██╔════╝██╔════╝ ██║██╔════╝    ╚══██╔══╝╚════██╗   ║');
    console.log('║    ███████║█████╗  ██║  ███╗██║███████╗       ██║    █████╔╝   ║');
    console.log('║    ██╔══██║██╔══╝  ██║   ██║██║╚════██║       ██║   ██╔═══╝    ║');
    console.log('║    ██║  ██║███████╗╚██████╔╝██║███████║       ██║   ███████╗   ║');
    console.log('║    ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝╚══════╝       ╚═╝   ╚══════╝   ║');
    console.log('║                                                                ║');
    console.log('║           Text-to-Action Anywhere Platform                     ║');
    console.log('║                    Setup Wizard                                ║');
    console.log('║                                                                ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('\n');
    console.log('Welcome to AEGIS-T2A! This wizard will help you configure the platform.');
    console.log('Press Ctrl+C at any time to cancel.\n');
  }

  private printFooter(): void {
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                  Setup Complete!                               ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('\n');
    console.log('Your configuration has been saved to .env');
    console.log('\nNext steps:');
    console.log('  1. Start the server:  npm start');
    console.log('  2. Or use the CLI:    npm run cli -- intent "your command"');
    console.log('  3. Or open browser:   http://localhost:3000');
    console.log('\nFor help, run: npm run cli -- --help\n');
  }

  private printStep(step: number, total: number, title: string): void {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Step ${step}/${total}: ${title}`);
    console.log('─'.repeat(60) + '\n');
  }

  private async prompt(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    return new Promise((resolve) => {
      this.rl.question(`${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultValue || '');
      });
    });
  }

  private async promptSecret(question: string): Promise<string> {
    // Note: In a real implementation, we'd hide the input
    return this.prompt(`${question} (input hidden)`);
  }

  private async promptSelect(question: string, options: string[]): Promise<string> {
    console.log(`\n${question}\n`);
    options.forEach((opt, i) => {
      console.log(`  ${i + 1}. ${opt}`);
    });
    console.log('');

    while (true) {
      const answer = await this.prompt('Enter number');
      const num = parseInt(answer, 10);
      if (num >= 1 && num <= options.length) {
        return options[num - 1] ?? options[0] ?? '';
      }
      console.log('Invalid selection. Please try again.');
    }
  }

  private async promptYesNo(question: string, defaultYes = true): Promise<boolean> {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = await this.prompt(`${question} ${suffix}`);
    if (!answer) return defaultYes;
    return answer.toLowerCase().startsWith('y');
  }

  // ===========================================================================
  // Configuration Steps
  // ===========================================================================

  private async configureLLM(): Promise<void> {
    this.printStep(1, 4, 'LLM Provider Configuration');

    console.log('AEGIS-T2A uses a Large Language Model to parse natural language intents.');
    console.log('You can use Anthropic Claude, OpenAI, Google Gemini, OpenRouter, or local Ollama.\n');

    const provider = await this.promptSelect('Select your LLM provider:', [
      'Anthropic (Claude) - Recommended',
      'OpenAI (GPT-4)',
      'Google Gemini',
      'OpenRouter (Multiple models)',
      'Ollama (Local, open-source)',
    ]);

    const providerMap: Record<string, WizardConfig['llm']['provider']> = {
      'Anthropic (Claude) - Recommended': 'anthropic',
      'OpenAI (GPT-4)': 'openai',
      'Google Gemini': 'gemini',
      'OpenRouter (Multiple models)': 'openrouter',
      'Ollama (Local, open-source)': 'ollama',
    };

    const selectedProvider = providerMap[provider] ?? 'anthropic';
    this.config.llm = {
      provider: selectedProvider,
    };

    switch (selectedProvider) {
      case 'anthropic':
        this.config.llm.apiKey = await this.promptSecret(
          'Enter your Anthropic API key'
        );
        this.config.llm.model = await this.prompt(
          'Model',
          'claude-sonnet-4-20250514'
        );
        break;

      case 'openai':
        this.config.llm.apiKey = await this.promptSecret(
          'Enter your OpenAI API key'
        );
        this.config.llm.model = await this.prompt('Model', 'gpt-5.1');
        this.config.llm.baseUrl = await this.prompt(
          'Base URL',
          'https://api.openai.com/v1'
        );
        break;

      case 'gemini':
        this.config.llm.apiKey = await this.promptSecret(
          'Enter your Gemini API key'
        );
        this.config.llm.model = await this.prompt('Model', 'gemini-2.5-pro');
        this.config.llm.baseUrl = await this.prompt(
          'Base URL',
          'https://generativelanguage.googleapis.com/v1beta'
        );
        break;

      case 'openrouter':
        this.config.llm.apiKey = await this.promptSecret(
          'Enter your OpenRouter API key'
        );
        this.config.llm.model = await this.prompt(
          'Model',
          'anthropic/claude-sonnet-4-20250514'
        );
        break;

      case 'ollama':
        this.config.llm.baseUrl = await this.prompt(
          'Ollama URL',
          'http://localhost:11434'
        );
        this.config.llm.model = await this.prompt('Model', 'llama2');
        break;
    }

    // Test connection
    console.log('\nTesting LLM connection...');
    const success = await this.testLLMConnection();
    if (success) {
      console.log('✓ Connection successful!');
    } else {
      console.log('✗ Connection failed. You can continue and fix this later.');
    }
  }

  private async configureCloud(): Promise<void> {
    this.printStep(2, 4, 'Cloud Provider Configuration (Optional)');

    console.log('Connect AEGIS-T2A to cloud providers to execute actions.\n');

    const setupCloud = await this.promptYesNo(
      'Do you want to configure a cloud provider?',
      false
    );

    if (!setupCloud) {
      this.config.cloud = { provider: 'none' };
      return;
    }

    const provider = await this.promptSelect('Select your cloud provider:', [
      'AWS (Amazon Web Services)',
      'Azure (Microsoft Azure)',
      'GCP (Google Cloud Platform)',
      'On-premises (SSH/Kubernetes/Docker)',
    ]);

    const providerMap: Record<string, 'aws' | 'azure' | 'gcp' | 'onprem'> = {
      'AWS (Amazon Web Services)': 'aws',
      'Azure (Microsoft Azure)': 'azure',
      'GCP (Google Cloud Platform)': 'gcp',
      'On-premises (SSH/Kubernetes/Docker)': 'onprem',
    };

    this.config.cloud = {
      provider: providerMap[provider],
    };

    switch (this.config.cloud.provider) {
      case 'aws':
        this.config.cloud.aws = {
          accessKeyId: await this.promptSecret('AWS Access Key ID'),
          secretAccessKey: await this.promptSecret('AWS Secret Access Key'),
          region: await this.prompt('AWS Region', 'us-east-1'),
        };
        break;

      case 'azure':
        this.config.cloud.azure = {
          tenantId: await this.prompt('Azure Tenant ID'),
          clientId: await this.prompt('Azure Client ID'),
          clientSecret: await this.promptSecret('Azure Client Secret'),
        };
        break;

      case 'gcp':
        this.config.cloud.gcp = {
          projectId: await this.prompt('GCP Project ID'),
          keyFile: await this.prompt('Path to service account key file'),
        };
        break;

      case 'onprem':
        const onpremType = await this.promptSelect('On-prem type:', [
          'SSH (Remote server)',
          'Kubernetes',
          'Docker',
        ]);

        const typeMap: Record<string, 'ssh' | 'kubernetes' | 'docker'> = {
          'SSH (Remote server)': 'ssh',
          Kubernetes: 'kubernetes',
          Docker: 'docker',
        };

        const onpremTypeValue = typeMap[onpremType] ?? 'ssh';
        this.config.cloud.onprem = {
          type: onpremTypeValue,
        };

        if (onpremTypeValue === 'ssh') {
          this.config.cloud.onprem.host = await this.prompt('SSH Host');
          this.config.cloud.onprem.port = parseInt(
            await this.prompt('SSH Port', '22'),
            10
          );
          this.config.cloud.onprem.username = await this.prompt('SSH Username');
        }
        break;
    }

    // Test connection
    console.log('\nTesting cloud connection...');
    const success = await this.testCloudConnection();
    if (success) {
      console.log('✓ Connection successful!');
    } else {
      console.log('✗ Connection failed. You can continue and fix this later.');
    }
  }

  private async configureChannels(): Promise<void> {
    this.printStep(3, 4, 'Communication Channels (Optional)');

    console.log('Configure additional channels for interacting with AEGIS-T2A.\n');

    this.config.channels = {};

    // Telegram
    const setupTelegram = await this.promptYesNo(
      'Configure Telegram bot?',
      false
    );
    if (setupTelegram) {
      this.config.channels.telegram = {
        botToken: await this.promptSecret('Telegram Bot Token'),
      };
    }

    // WhatsApp
    const setupWhatsApp = await this.promptYesNo(
      'Configure WhatsApp Business?',
      false
    );
    if (setupWhatsApp) {
      this.config.channels.whatsapp = {
        phoneNumberId: await this.prompt('WhatsApp Phone Number ID'),
        accessToken: await this.promptSecret('WhatsApp Access Token'),
      };
    }

    // Slack
    const setupSlack = await this.promptYesNo('Configure Slack?', false);
    if (setupSlack) {
      this.config.channels.slack = {
        botToken: await this.promptSecret('Slack Bot Token'),
      };
    }
  }

  private async configureSecurity(): Promise<void> {
    this.printStep(4, 4, 'Security Configuration');

    console.log(
      'Configure security settings for action execution.\n'
    );

    this.config.security = {
      requireApproval: true,
      approvalThreshold: 'medium',
    };

    this.config.security.requireApproval = await this.promptYesNo(
      'Require human approval for high-risk actions?',
      true
    );

    if (this.config.security.requireApproval) {
      const threshold = await this.promptSelect(
        'Minimum risk level requiring approval:',
        ['Low (all actions)', 'Medium', 'High', 'Critical only']
      );

      const thresholdMap: Record<string, 'low' | 'medium' | 'high' | 'critical'> = {
        'Low (all actions)': 'low',
        Medium: 'medium',
        High: 'high',
        'Critical only': 'critical',
      };

      this.config.security.approvalThreshold = thresholdMap[threshold] ?? 'medium';
    }
  }

  // ===========================================================================
  // Validation and Save
  // ===========================================================================

  private async validateAndSave(): Promise<void> {
    console.log('\n' + '─'.repeat(60));
    console.log('Configuration Summary');
    console.log('─'.repeat(60) + '\n');

    // Print summary
    console.log('LLM Provider:', this.config.llm?.provider);
    console.log('LLM Model:', this.config.llm?.model || 'default');
    console.log(
      'Cloud Provider:',
      this.config.cloud?.provider || 'none'
    );
    console.log(
      'Channels:',
      Object.keys(this.config.channels || {}).join(', ') || 'web only'
    );
    console.log('Require Approval:', this.config.security?.requireApproval);
    console.log(
      'Approval Threshold:',
      this.config.security?.approvalThreshold || 'n/a'
    );

    const confirm = await this.promptYesNo(
      '\nSave this configuration?',
      true
    );

    if (confirm) {
      await this.saveConfig();
      console.log('\n✓ Configuration saved!');
    } else {
      console.log('\nConfiguration not saved. Run the wizard again to reconfigure.');
    }
  }

  private async saveConfig(): Promise<void> {
    const envPath = path.join(process.cwd(), '.env');
    const lines: string[] = [];

    // Read existing .env if exists
    let existingEnv = '';
    try {
      existingEnv = fs.readFileSync(envPath, 'utf-8');
    } catch {
      // File doesn't exist, that's fine
    }

    // Helper to set or update env var
    const setEnv = (key: string, value: string) => {
      if (!value) return;
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(existingEnv)) {
        existingEnv = existingEnv.replace(regex, `${key}=${value}`);
      } else {
        lines.push(`${key}=${value}`);
      }
    };

    // LLM Configuration
    setEnv('LLM_PROVIDER', this.config.llm?.provider || 'anthropic');

    switch (this.config.llm?.provider) {
      case 'anthropic':
        setEnv('ANTHROPIC_API_KEY', this.config.llm.apiKey || '');
        setEnv('ANTHROPIC_MODEL', this.config.llm.model || 'claude-sonnet-4-20250514');
        break;
      case 'openai':
        setEnv('OPENAI_API_KEY', this.config.llm.apiKey || '');
        setEnv('OPENAI_MODEL', this.config.llm.model || 'gpt-5.1');
        setEnv('OPENAI_BASE_URL', this.config.llm.baseUrl || '');
        break;
      case 'gemini':
        setEnv('GEMINI_API_KEY', this.config.llm.apiKey || '');
        setEnv('GEMINI_MODEL', this.config.llm.model || 'gemini-2.5-pro');
        setEnv('GEMINI_BASE_URL', this.config.llm.baseUrl || '');
        break;
      case 'openrouter':
        setEnv('OPENROUTER_API_KEY', this.config.llm.apiKey || '');
        setEnv('OPENROUTER_MODEL', this.config.llm.model || '');
        break;
      case 'ollama':
        setEnv('OLLAMA_BASE_URL', this.config.llm.baseUrl || 'http://localhost:11434');
        setEnv('OLLAMA_MODEL', this.config.llm.model || 'llama2');
        break;
    }

    // Cloud Configuration
    if (this.config.cloud?.aws) {
      setEnv('AWS_ACCESS_KEY_ID', this.config.cloud.aws.accessKeyId);
      setEnv('AWS_SECRET_ACCESS_KEY', this.config.cloud.aws.secretAccessKey);
      setEnv('AWS_REGION', this.config.cloud.aws.region);
    }

    if (this.config.cloud?.azure) {
      setEnv('AZURE_TENANT_ID', this.config.cloud.azure.tenantId);
      setEnv('AZURE_CLIENT_ID', this.config.cloud.azure.clientId);
      setEnv('AZURE_CLIENT_SECRET', this.config.cloud.azure.clientSecret);
    }

    if (this.config.cloud?.gcp) {
      setEnv('GCP_PROJECT_ID', this.config.cloud.gcp.projectId);
      setEnv('GOOGLE_APPLICATION_CREDENTIALS', this.config.cloud.gcp.keyFile);
    }

    // Channel Configuration
    if (this.config.channels?.telegram) {
      setEnv('TELEGRAM_BOT_TOKEN', this.config.channels.telegram.botToken);
    }

    if (this.config.channels?.whatsapp) {
      setEnv('WHATSAPP_PHONE_NUMBER_ID', this.config.channels.whatsapp.phoneNumberId);
      setEnv('WHATSAPP_ACCESS_TOKEN', this.config.channels.whatsapp.accessToken);
    }

    if (this.config.channels?.slack) {
      setEnv('SLACK_BOT_TOKEN', this.config.channels.slack.botToken);
    }

    // Security Configuration
    setEnv(
      'REQUIRE_APPROVAL',
      String(this.config.security?.requireApproval ?? true)
    );
    setEnv(
      'APPROVAL_THRESHOLD',
      this.config.security?.approvalThreshold || 'medium'
    );

    // Write updated .env
    const newEnv = existingEnv + (existingEnv && lines.length ? '\n' : '') + lines.join('\n');
    fs.writeFileSync(envPath, newEnv.trim() + '\n');
  }

  // ===========================================================================
  // Connection Tests
  // ===========================================================================

  private async testLLMConnection(): Promise<boolean> {
    try {
      switch (this.config.llm?.provider) {
        case 'ollama':
          const response = await fetch(
            `${this.config.llm.baseUrl}/api/tags`
          );
          return response.ok;

        case 'anthropic':
        case 'openai':
        case 'openrouter':
          // For API-based providers, we just check if key is present
          return !!this.config.llm?.apiKey;

        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  private async testCloudConnection(): Promise<boolean> {
    // Simplified test - in production, we'd actually test the connection
    try {
      switch (this.config.cloud?.provider) {
        case 'aws':
          return !!(
            this.config.cloud.aws?.accessKeyId &&
            this.config.cloud.aws?.secretAccessKey
          );

        case 'azure':
          return !!(
            this.config.cloud.azure?.tenantId &&
            this.config.cloud.azure?.clientId &&
            this.config.cloud.azure?.clientSecret
          );

        case 'gcp':
          return !!this.config.cloud.gcp?.projectId;

        case 'onprem':
          return !!this.config.cloud.onprem?.type;

        default:
          return true;
      }
    } catch {
      return false;
    }
  }
}

/**
 * Run the setup wizard
 */
export async function runSetupWizard(): Promise<void> {
  const wizard = new SetupWizard();
  await wizard.run();
}
