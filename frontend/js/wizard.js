/**
 * AEGIS-T2A Setup Wizard
 *
 * Guides users through initial configuration.
 */

const SetupWizard = {
  currentStep: 1,
  totalSteps: 5,
  validationResults: {},

  /**
   * Initialize the wizard
   */
  init() {
    this.bindEvents();
    this.showStep(1);
    this.updateProgress();
  },

  /**
   * Bind event handlers
   */
  bindEvents() {
    // Navigation buttons
    document.querySelectorAll('.wizard-nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        if (action === 'next') this.nextStep();
        else if (action === 'prev') this.prevStep();
        else if (action === 'skip') this.skipStep();
      });
    });

    // Provider selection cards
    document.querySelectorAll('.provider-card').forEach(card => {
      card.addEventListener('click', () => {
        this.selectProvider(card);
      });
    });

    // Cloud provider toggles
    document.querySelectorAll('.cloud-toggle').forEach(toggle => {
      toggle.addEventListener('change', (e) => {
        this.toggleCloudProvider(e.target);
      });
    });

    // Channel checkboxes
    document.querySelectorAll('.channel-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        this.updateChannelConfig();
      });
    });

    // Form inputs - save on change
    document.querySelectorAll('.wizard-step input, .wizard-step select').forEach(input => {
      input.addEventListener('change', () => {
        this.saveCurrentStepConfig();
      });
    });

    // Test connection buttons
    document.querySelectorAll('.test-connection-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const provider = e.target.dataset.provider;
        const type = e.target.dataset.type;
        this.testConnection(type, provider, e.target);
      });
    });

    // Finish button
    const finishBtn = document.getElementById('finish-setup-btn');
    if (finishBtn) {
      finishBtn.addEventListener('click', () => {
        this.completeSetup();
      });
    }
  },

  /**
   * Show a specific step
   */
  showStep(stepNum) {
    // Hide all steps
    document.querySelectorAll('.wizard-step').forEach(step => {
      step.classList.remove('active');
    });

    // Show target step
    const targetStep = document.querySelector(`.wizard-step[data-step="${stepNum}"]`);
    if (targetStep) {
      targetStep.classList.add('active');
      this.currentStep = stepNum;
      this.updateProgress();
      this.updateNavButtons();

      // Run validation if on validation step
      if (stepNum === 4) {
        this.runValidation();
      }
    }
  },

  /**
   * Go to next step
   */
  async nextStep() {
    // Validate current step
    const isValid = await this.validateCurrentStep();
    if (!isValid) return;

    // Save current step config
    this.saveCurrentStepConfig();

    // Move to next step
    if (this.currentStep < this.totalSteps) {
      this.showStep(this.currentStep + 1);
    }
  },

  /**
   * Go to previous step
   */
  prevStep() {
    if (this.currentStep > 1) {
      this.showStep(this.currentStep - 1);
    }
  },

  /**
   * Skip current step
   */
  skipStep() {
    if (this.currentStep < this.totalSteps) {
      this.showStep(this.currentStep + 1);
    }
  },

  /**
   * Update progress indicator
   */
  updateProgress() {
    const progressFill = document.querySelector('.wizard-progress-fill');
    const progressText = document.querySelector('.wizard-progress-text');

    if (progressFill) {
      const percentage = ((this.currentStep - 1) / (this.totalSteps - 1)) * 100;
      progressFill.style.width = `${percentage}%`;
    }

    if (progressText) {
      progressText.textContent = `Step ${this.currentStep} of ${this.totalSteps}`;
    }

    // Update step indicators
    document.querySelectorAll('.wizard-step-indicator').forEach((indicator, index) => {
      indicator.classList.remove('active', 'completed');
      if (index + 1 === this.currentStep) {
        indicator.classList.add('active');
      } else if (index + 1 < this.currentStep) {
        indicator.classList.add('completed');
      }
    });
  },

  /**
   * Update navigation buttons
   */
  updateNavButtons() {
    const prevBtn = document.querySelector('.wizard-nav-btn[data-action="prev"]');
    const nextBtn = document.querySelector('.wizard-nav-btn[data-action="next"]');
    const skipBtn = document.querySelector('.wizard-nav-btn[data-action="skip"]');
    const finishBtn = document.getElementById('finish-setup-btn');

    if (prevBtn) {
      prevBtn.style.display = this.currentStep === 1 ? 'none' : 'inline-block';
    }

    if (nextBtn) {
      nextBtn.style.display = this.currentStep === this.totalSteps ? 'none' : 'inline-block';
      nextBtn.textContent = this.currentStep === this.totalSteps - 1 ? 'Finish' : 'Next';
    }

    if (skipBtn) {
      // Only show skip on optional steps (2 and 3)
      skipBtn.style.display = (this.currentStep === 2 || this.currentStep === 3) ? 'inline-block' : 'none';
    }

    if (finishBtn) {
      finishBtn.style.display = this.currentStep === this.totalSteps ? 'inline-block' : 'none';
    }
  },

  /**
   * Select LLM provider
   */
  selectProvider(card) {
    const provider = card.dataset.provider;

    // Update selection visual
    document.querySelectorAll('.provider-card').forEach(c => {
      c.classList.remove('selected');
    });
    card.classList.add('selected');

    // Show corresponding config form
    document.querySelectorAll('.provider-config').forEach(config => {
      config.classList.remove('active');
    });
    const configForm = document.getElementById(`${provider}-config`);
    if (configForm) {
      configForm.classList.add('active');
    }

    // Save selection
    AegisConfig.setValue('llm.provider', provider);
  },

  /**
   * Toggle cloud provider
   */
  toggleCloudProvider(toggle) {
    const provider = toggle.dataset.provider;
    const configSection = document.getElementById(`${provider}-cloud-config`);

    if (configSection) {
      configSection.style.display = toggle.checked ? 'block' : 'none';
    }

    AegisConfig.setValue(`cloud.${provider}.enabled`, toggle.checked);
  },

  /**
   * Update channel configuration
   */
  updateChannelConfig() {
    const enabledChannels = [];
    document.querySelectorAll('.channel-checkbox:checked').forEach(checkbox => {
      enabledChannels.push(checkbox.value);

      // Show channel config
      const configSection = document.getElementById(`${checkbox.value}-channel-config`);
      if (configSection) {
        configSection.style.display = 'block';
      }
    });

    document.querySelectorAll('.channel-checkbox:not(:checked)').forEach(checkbox => {
      const configSection = document.getElementById(`${checkbox.value}-channel-config`);
      if (configSection) {
        configSection.style.display = 'none';
      }
    });

    AegisConfig.setValue('channels.enabled', enabledChannels);
  },

  /**
   * Save current step configuration
   */
  saveCurrentStepConfig() {
    const step = document.querySelector(`.wizard-step[data-step="${this.currentStep}"]`);
    if (!step) return;

    step.querySelectorAll('input, select, textarea').forEach(input => {
      const configPath = input.dataset.config;
      if (configPath) {
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (input.type === 'number') value = parseFloat(value);
        AegisConfig.setValue(configPath, value);
      }
    });
  },

  /**
   * Validate current step
   */
  async validateCurrentStep() {
    const step = document.querySelector(`.wizard-step[data-step="${this.currentStep}"]`);
    if (!step) return true;

    // Clear previous errors
    step.querySelectorAll('.input-error').forEach(el => {
      el.classList.remove('input-error');
    });
    step.querySelectorAll('.error-message').forEach(el => {
      el.remove();
    });

    let isValid = true;

    // Step 1: LLM Provider
    if (this.currentStep === 1) {
      const provider = AegisConfig.getValue('llm.provider');
      if (!provider) {
        this.showError(step, 'Please select an LLM provider');
        isValid = false;
      } else {
        // Check if API key is provided for the selected provider
        if (provider !== 'ollama') {
          const apiKey = AegisConfig.getValue(`llm.${provider}.apiKey`);
          if (!apiKey) {
            const input = step.querySelector(`[data-config="llm.${provider}.apiKey"]`);
            if (input) {
              this.showInputError(input, 'API key is required');
              isValid = false;
            }
          }
        }
      }
    }

    return isValid;
  },

  /**
   * Show general error message
   */
  showError(container, message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message wizard-error';
    errorDiv.textContent = message;
    container.insertBefore(errorDiv, container.firstChild);
  },

  /**
   * Show input-specific error
   */
  showInputError(input, message) {
    input.classList.add('input-error');
    const errorSpan = document.createElement('span');
    errorSpan.className = 'error-message';
    errorSpan.textContent = message;
    input.parentNode.appendChild(errorSpan);
  },

  /**
   * Test connection to a provider
   */
  async testConnection(type, provider, button) {
    const originalText = button.textContent;
    button.textContent = 'Testing...';
    button.disabled = true;

    try {
      let result;
      const config = AegisConfig.get();

      switch (type) {
        case 'llm':
          result = await this.testLLMConnection(provider, config.llm[provider]);
          break;
        case 'cloud':
          result = await this.testCloudConnection(provider, config.cloud[provider]);
          break;
        case 'channel':
          result = await this.testChannelConnection(provider, config.channels[provider]);
          break;
      }

      if (result.success) {
        Toast.success(`${provider} connection successful!`);
        button.classList.add('success');
        this.validationResults[`${type}-${provider}`] = true;
      } else {
        Toast.error(`Connection failed: ${result.error}`);
        button.classList.add('error');
        this.validationResults[`${type}-${provider}`] = false;
      }
    } catch (error) {
      Toast.error(`Connection test failed: ${error.message}`);
      button.classList.add('error');
      this.validationResults[`${type}-${provider}`] = false;
    } finally {
      button.textContent = originalText;
      button.disabled = false;

      setTimeout(() => {
        button.classList.remove('success', 'error');
      }, 3000);
    }
  },

  /**
   * Test LLM connection
   */
  async testLLMConnection(provider, config) {
    try {
      // Use the new API endpoint
      const response = await AegisAPI.testLLMConnection(
        provider,
        config.apiKey,
        config.model,
        config.baseUrl
      );
      return response;
    } catch (error) {
      // Fallback: test directly for Ollama
      if (provider === 'ollama') {
        try {
          const response = await fetch(`${config.baseUrl || 'http://localhost:11434'}/api/tags`);
          if (response.ok) {
            return { success: true, message: 'Ollama is running' };
          }
        } catch (e) {
          // Fall through to error
        }
      }
      return { success: false, error: error.message };
    }
  },

  /**
   * Load Ollama models
   */
  async loadOllamaModels(baseUrl) {
    try {
      const response = await AegisAPI.getOllamaModels(baseUrl);
      return response.models || [];
    } catch (error) {
      // Fallback: fetch directly
      try {
        const response = await fetch(`${baseUrl || 'http://localhost:11434'}/api/tags`);
        if (response.ok) {
          const data = await response.json();
          return (data.models || []).map(m => m.name);
        }
      } catch (e) {
        // Ignore
      }
      return [];
    }
  },

  /**
   * Test cloud connection
   */
  async testCloudConnection(provider, config) {
    try {
      const response = await AegisAPI.testCloudConnection(provider, config);
      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Test channel connection
   */
  async testChannelConnection(channel, config) {
    try {
      const response = await AegisAPI.testChannelConnection(channel, config);
      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  /**
   * Run full validation on step 4
   */
  async runValidation() {
    const validationList = document.getElementById('validation-results');
    if (!validationList) return;

    validationList.innerHTML = '<li class="validating">Running validation checks...</li>';

    const results = [];
    const config = AegisConfig.get();

    // Validate LLM
    results.push(await this.validateLLMConfig(config));

    // Validate enabled cloud providers
    if (config.cloud.aws.enabled) {
      results.push(await this.validateCloudConfig('aws', config.cloud.aws));
    }
    if (config.cloud.azure.enabled) {
      results.push(await this.validateCloudConfig('azure', config.cloud.azure));
    }
    if (config.cloud.gcp.enabled) {
      results.push(await this.validateCloudConfig('gcp', config.cloud.gcp));
    }
    if (config.cloud.onprem.enabled) {
      results.push(await this.validateCloudConfig('onprem', config.cloud.onprem));
    }

    // Validate enabled channels
    const channels = config.channels.enabled || ['web'];
    for (const channel of channels) {
      if (channel !== 'web' && channel !== 'terminal') {
        results.push(await this.validateChannelConfig(channel, config.channels[channel]));
      }
    }

    // Render results
    validationList.innerHTML = results.map(r => `
      <li class="${r.success ? 'success' : 'error'}">
        <span class="validation-icon">${r.success ? '✓' : '✗'}</span>
        <span class="validation-name">${r.name}</span>
        <span class="validation-status">${r.message}</span>
      </li>
    `).join('');

    // Update overall status
    const allPassed = results.every(r => r.success);
    const statusEl = document.getElementById('validation-status');
    if (statusEl) {
      statusEl.className = allPassed ? 'validation-passed' : 'validation-failed';
      statusEl.textContent = allPassed
        ? 'All validations passed!'
        : 'Some validations failed. You can still proceed, but some features may not work.';
    }
  },

  /**
   * Validate LLM configuration
   */
  async validateLLMConfig(config) {
    const provider = config.llm.provider;
    const providerConfig = config.llm[provider];

    try {
      if (provider === 'ollama') {
        // Check if Ollama is running
        const response = await fetch(`${providerConfig.baseUrl}/api/tags`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        });

        if (response.ok) {
          return { name: `LLM (${provider})`, success: true, message: 'Connected' };
        }
      } else {
        // Check if API key is present
        if (providerConfig.apiKey) {
          return { name: `LLM (${provider})`, success: true, message: 'API key configured' };
        }
      }
      return { name: `LLM (${provider})`, success: false, message: 'Not configured' };
    } catch (error) {
      return { name: `LLM (${provider})`, success: false, message: error.message };
    }
  },

  /**
   * Validate cloud configuration
   */
  async validateCloudConfig(provider, config) {
    const providerNames = {
      aws: 'AWS',
      azure: 'Azure',
      gcp: 'Google Cloud',
      onprem: 'On-Premises'
    };

    try {
      // Check required fields
      switch (provider) {
        case 'aws':
          if (!config.accessKeyId || !config.secretAccessKey) {
            return { name: providerNames[provider], success: false, message: 'Missing credentials' };
          }
          break;
        case 'azure':
          if (!config.tenantId || !config.clientId || !config.clientSecret) {
            return { name: providerNames[provider], success: false, message: 'Missing credentials' };
          }
          break;
        case 'gcp':
          if (!config.projectId) {
            return { name: providerNames[provider], success: false, message: 'Missing project ID' };
          }
          break;
        case 'onprem':
          if (config.type === 'ssh' && (!config.ssh.host || !config.ssh.username)) {
            return { name: providerNames[provider], success: false, message: 'Missing SSH config' };
          }
          break;
      }
      return { name: providerNames[provider], success: true, message: 'Configured' };
    } catch (error) {
      return { name: providerNames[provider], success: false, message: error.message };
    }
  },

  /**
   * Validate channel configuration
   */
  async validateChannelConfig(channel, config) {
    const channelNames = {
      telegram: 'Telegram',
      whatsapp: 'WhatsApp',
      slack: 'Slack'
    };

    try {
      switch (channel) {
        case 'telegram':
          if (!config || !config.botToken) {
            return { name: channelNames[channel], success: false, message: 'Missing bot token' };
          }
          break;
        case 'whatsapp':
          if (!config || !config.accessToken) {
            return { name: channelNames[channel], success: false, message: 'Missing access token' };
          }
          break;
        case 'slack':
          if (!config || !config.botToken) {
            return { name: channelNames[channel], success: false, message: 'Missing bot token' };
          }
          break;
      }
      return { name: channelNames[channel], success: true, message: 'Configured' };
    } catch (error) {
      return { name: channelNames[channel], success: false, message: error.message };
    }
  },

  /**
   * Complete setup and launch app
   */
  completeSetup() {
    // Save final configuration
    this.saveCurrentStepConfig();

    // Mark setup as complete
    AegisConfig.markSetupComplete();

    // Hide wizard and show app
    document.getElementById('setup-wizard').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    // Initialize main application
    if (typeof AegisApp !== 'undefined') {
      AegisApp.init();
    }

    Toast.success('Setup complete! Welcome to AEGIS-T2A.');
  },

  /**
   * Load saved configuration into form fields
   */
  loadSavedConfig() {
    const config = AegisConfig.get();

    // Load all form fields
    document.querySelectorAll('[data-config]').forEach(input => {
      const path = input.dataset.config;
      const value = AegisConfig.getValue(path);

      if (value !== undefined) {
        if (input.type === 'checkbox') {
          input.checked = value;
        } else {
          input.value = value;
        }
      }
    });

    // Select saved provider
    const provider = config.llm.provider;
    if (provider) {
      const providerCard = document.querySelector(`.provider-card[data-provider="${provider}"]`);
      if (providerCard) {
        this.selectProvider(providerCard);
      }
    }

    // Enable saved cloud providers
    ['aws', 'azure', 'gcp', 'onprem'].forEach(p => {
      if (config.cloud[p].enabled) {
        const toggle = document.querySelector(`.cloud-toggle[data-provider="${p}"]`);
        if (toggle) {
          toggle.checked = true;
          this.toggleCloudProvider(toggle);
        }
      }
    });

    // Enable saved channels
    (config.channels.enabled || []).forEach(channel => {
      const checkbox = document.querySelector(`.channel-checkbox[value="${channel}"]`);
      if (checkbox) {
        checkbox.checked = true;
      }
    });
    this.updateChannelConfig();
  }
};

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SetupWizard;
}
