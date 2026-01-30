/**
 * AEGIS-T2A Frontend Configuration Manager
 *
 * Handles configuration storage, retrieval, and validation.
 */

const AegisConfig = {
  // Storage keys
  STORAGE_KEY: 'aegis-t2a-config',
  SETUP_COMPLETE_KEY: 'aegis-t2a-setup-complete',

  // Default configuration
  defaults: {
    llm: {
      provider: 'anthropic',
      anthropic: {
        apiKey: '',
        model: 'claude-sonnet-4-20250514'
      },
      openai: {
        apiKey: '',
        model: 'gpt-4-turbo',
        baseUrl: 'https://api.openai.com/v1'
      },
      openrouter: {
        apiKey: '',
        model: 'anthropic/claude-sonnet-4-20250514'
      },
      ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'llama2'
      }
    },
    cloud: {
      providers: [],
      aws: {
        accessKeyId: '',
        secretAccessKey: '',
        region: 'us-east-1',
        enabled: false
      },
      azure: {
        tenantId: '',
        clientId: '',
        clientSecret: '',
        subscriptionId: '',
        enabled: false
      },
      gcp: {
        projectId: '',
        keyFile: '',
        region: 'us-central1',
        enabled: false
      },
      onprem: {
        type: 'ssh',
        ssh: {
          host: '',
          port: 22,
          username: '',
          privateKey: ''
        },
        kubernetes: {
          kubeconfig: '',
          context: ''
        },
        docker: {
          host: 'unix:///var/run/docker.sock',
          tlsVerify: false
        },
        enabled: false
      }
    },
    channels: {
      enabled: ['web'],
      telegram: {
        botToken: '',
        enabled: false
      },
      whatsapp: {
        phoneNumberId: '',
        accessToken: '',
        webhookVerifyToken: '',
        enabled: false
      },
      slack: {
        botToken: '',
        signingSecret: '',
        appToken: '',
        enabled: false
      }
    },
    security: {
      requireApproval: true,
      approvalThreshold: 'medium',
      maxRiskLevel: 'high',
      auditRetentionDays: 90,
      secretsTtlSeconds: 300,
      allowedDomains: [],
      blockedActions: []
    },
    general: {
      theme: 'system',
      language: 'en',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      notificationsEnabled: true
    },
    advanced: {
      apiBaseUrl: window.location.origin,
      debugMode: false,
      workflowMaxRetries: 3,
      simulationTimeout: 30000,
      executionTimeout: 300000
    }
  },

  // Current configuration
  _config: null,

  /**
   * Initialize configuration from storage or defaults
   */
  init() {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    if (stored) {
      try {
        this._config = this.mergeDeep(this.defaults, JSON.parse(stored));
      } catch (e) {
        console.error('Failed to parse stored config:', e);
        this._config = { ...this.defaults };
      }
    } else {
      this._config = { ...this.defaults };
    }
    return this._config;
  },

  /**
   * Get current configuration
   */
  get() {
    if (!this._config) {
      this.init();
    }
    return this._config;
  },

  /**
   * Get a specific config value by path
   */
  getValue(path) {
    const parts = path.split('.');
    let value = this.get();
    for (const part of parts) {
      if (value === undefined || value === null) return undefined;
      value = value[part];
    }
    return value;
  },

  /**
   * Set a specific config value by path
   */
  setValue(path, value) {
    const parts = path.split('.');
    const config = this.get();
    let current = config;

    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }

    current[parts[parts.length - 1]] = value;
    this.save();
    return config;
  },

  /**
   * Update configuration
   */
  update(updates) {
    this._config = this.mergeDeep(this.get(), updates);
    this.save();
    return this._config;
  },

  /**
   * Save configuration to storage
   */
  save() {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._config));
  },

  /**
   * Reset to defaults
   */
  reset() {
    this._config = { ...this.defaults };
    localStorage.removeItem(this.STORAGE_KEY);
    localStorage.removeItem(this.SETUP_COMPLETE_KEY);
  },

  /**
   * Check if setup is complete
   */
  isSetupComplete() {
    return localStorage.getItem(this.SETUP_COMPLETE_KEY) === 'true';
  },

  /**
   * Mark setup as complete
   */
  markSetupComplete() {
    localStorage.setItem(this.SETUP_COMPLETE_KEY, 'true');
  },

  /**
   * Export configuration (without sensitive data)
   */
  export() {
    const config = this.get();
    const sanitized = JSON.parse(JSON.stringify(config));

    // Remove sensitive fields
    if (sanitized.llm?.anthropic) sanitized.llm.anthropic.apiKey = '***';
    if (sanitized.llm?.openai) sanitized.llm.openai.apiKey = '***';
    if (sanitized.llm?.openrouter) sanitized.llm.openrouter.apiKey = '***';
    if (sanitized.cloud?.aws) {
      sanitized.cloud.aws.accessKeyId = '***';
      sanitized.cloud.aws.secretAccessKey = '***';
    }
    if (sanitized.cloud?.azure) {
      sanitized.cloud.azure.clientSecret = '***';
    }
    if (sanitized.cloud?.gcp) {
      sanitized.cloud.gcp.keyFile = '***';
    }
    if (sanitized.cloud?.onprem?.ssh) {
      sanitized.cloud.onprem.ssh.privateKey = '***';
    }
    if (sanitized.channels?.telegram) {
      sanitized.channels.telegram.botToken = '***';
    }
    if (sanitized.channels?.whatsapp) {
      sanitized.channels.whatsapp.accessToken = '***';
    }
    if (sanitized.channels?.slack) {
      sanitized.channels.slack.botToken = '***';
      sanitized.channels.slack.signingSecret = '***';
    }

    return sanitized;
  },

  /**
   * Deep merge helper
   */
  mergeDeep(target, source) {
    const output = { ...target };
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.mergeDeep(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  },

  isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  },

  /**
   * Validate LLM configuration
   */
  validateLLM() {
    const config = this.get();
    const provider = config.llm.provider;

    switch (provider) {
      case 'anthropic':
        return !!config.llm.anthropic.apiKey;
      case 'openai':
        return !!config.llm.openai.apiKey;
      case 'openrouter':
        return !!config.llm.openrouter.apiKey;
      case 'ollama':
        return !!config.llm.ollama.baseUrl;
      default:
        return false;
    }
  },

  /**
   * Get active LLM configuration
   */
  getActiveLLM() {
    const config = this.get();
    const provider = config.llm.provider;
    return {
      provider,
      ...config.llm[provider]
    };
  },

  /**
   * Get enabled cloud providers
   */
  getEnabledCloudProviders() {
    const config = this.get();
    const enabled = [];

    if (config.cloud.aws.enabled) enabled.push('aws');
    if (config.cloud.azure.enabled) enabled.push('azure');
    if (config.cloud.gcp.enabled) enabled.push('gcp');
    if (config.cloud.onprem.enabled) enabled.push('onprem');

    return enabled;
  },

  /**
   * Get enabled channels
   */
  getEnabledChannels() {
    return this.get().channels.enabled || ['web'];
  }
};

// Initialize on load
AegisConfig.init();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AegisConfig;
}
