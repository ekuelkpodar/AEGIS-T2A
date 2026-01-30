/**
 * AEGIS-T2A Settings Manager
 *
 * Handles settings pages and configuration UI.
 */

const Settings = {
  currentSection: 'general',

  /**
   * Initialize settings
   */
  init() {
    this.bindEvents();
    this.loadSettings();
  },

  /**
   * Bind event handlers
   */
  bindEvents() {
    // Settings navigation
    document.querySelectorAll('.settings-nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const section = item.dataset.section;
        this.showSection(section);
      });
    });

    // Save buttons
    document.querySelectorAll('.settings-save-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const section = e.target.dataset.section || this.currentSection;
        this.saveSection(section);
      });
    });

    // Reset buttons
    document.querySelectorAll('.settings-reset-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const section = e.target.dataset.section || this.currentSection;
        this.resetSection(section);
      });
    });

    // Test connection buttons
    document.querySelectorAll('.test-connection').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const type = e.target.dataset.type;
        const provider = e.target.dataset.provider;
        this.testConnection(type, provider, e.target);
      });
    });

    // Form change handlers - auto-save
    document.querySelectorAll('.settings-form input, .settings-form select, .settings-form textarea').forEach(input => {
      input.addEventListener('change', () => {
        this.markDirty();
      });
    });

    // Theme toggle
    const themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
      themeSelect.addEventListener('change', (e) => {
        this.setTheme(e.target.value);
      });
    }

    // Provider toggle
    document.querySelectorAll('.provider-toggle').forEach(toggle => {
      toggle.addEventListener('change', (e) => {
        this.toggleProvider(e.target.dataset.provider, e.target.checked);
      });
    });

    // Export/Import config
    const exportBtn = document.getElementById('export-config');
    const importBtn = document.getElementById('import-config');
    const importInput = document.getElementById('import-config-input');

    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportConfig());
    }
    if (importBtn) {
      importBtn.addEventListener('click', () => importInput?.click());
    }
    if (importInput) {
      importInput.addEventListener('change', (e) => this.importConfig(e));
    }
  },

  /**
   * Show a settings section
   */
  showSection(section) {
    // Update navigation
    document.querySelectorAll('.settings-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.section === section);
    });

    // Show section content
    document.querySelectorAll('.settings-section').forEach(sec => {
      sec.classList.toggle('active', sec.id === `settings-${section}`);
    });

    this.currentSection = section;
  },

  /**
   * Load all settings into forms
   */
  loadSettings() {
    const config = AegisConfig.get();

    // Load all inputs with data-config attribute
    document.querySelectorAll('[data-config]').forEach(input => {
      const path = input.dataset.config;
      const value = AegisConfig.getValue(path);

      if (value !== undefined) {
        if (input.type === 'checkbox') {
          input.checked = value;
        } else if (input.type === 'radio') {
          input.checked = input.value === value;
        } else {
          input.value = value;
        }
      }
    });

    // Load LLM provider selection
    const llmProvider = config.llm.provider;
    document.querySelectorAll('.llm-provider-option').forEach(option => {
      option.classList.toggle('active', option.dataset.provider === llmProvider);
    });
    this.showProviderConfig(llmProvider);

    // Load theme
    this.setTheme(config.general.theme);

    // Update provider toggles
    ['aws', 'azure', 'gcp', 'onprem'].forEach(provider => {
      const toggle = document.querySelector(`.provider-toggle[data-provider="${provider}"]`);
      if (toggle) {
        toggle.checked = config.cloud[provider]?.enabled || false;
        this.toggleProvider(provider, toggle.checked);
      }
    });

    // Update channel status
    this.updateChannelStatus();
  },

  /**
   * Save a section
   */
  async saveSection(section) {
    const form = document.querySelector(`#settings-${section} .settings-form`);
    if (!form) return;

    // Collect all form values
    form.querySelectorAll('[data-config]').forEach(input => {
      const path = input.dataset.config;
      let value = input.type === 'checkbox' ? input.checked : input.value;
      if (input.type === 'number') value = parseFloat(value) || 0;
      AegisConfig.setValue(path, value);
    });

    // Save to storage
    AegisConfig.save();

    // Sync to server if needed
    try {
      await this.syncToServer(section);
      Toast.success('Settings saved successfully');
    } catch (error) {
      Toast.error(`Failed to sync settings: ${error.message}`);
    }

    this.clearDirty();
  },

  /**
   * Reset a section to defaults
   */
  resetSection(section) {
    if (!confirm('Reset this section to defaults? This cannot be undone.')) return;

    const defaults = AegisConfig.defaults;
    const sectionMap = {
      'general': 'general',
      'llm': 'llm',
      'security': 'security',
      'cloud': 'cloud',
      'channels': 'channels',
      'advanced': 'advanced'
    };

    const configKey = sectionMap[section];
    if (configKey && defaults[configKey]) {
      AegisConfig.update({ [configKey]: defaults[configKey] });
      this.loadSettings();
      Toast.info('Settings reset to defaults');
    }
  },

  /**
   * Sync settings to server
   */
  async syncToServer(section) {
    const config = AegisConfig.get();

    // Only sync certain sections
    if (['llm', 'security', 'advanced'].includes(section)) {
      await AegisAPI.updateServerConfig({
        [section]: config[section]
      });
    }
  },

  /**
   * Show provider-specific config
   */
  showProviderConfig(provider) {
    document.querySelectorAll('.llm-provider-config').forEach(config => {
      config.classList.toggle('active', config.dataset.provider === provider);
    });
  },

  /**
   * Toggle a cloud provider
   */
  toggleProvider(provider, enabled) {
    const configSection = document.querySelector(`.provider-config[data-provider="${provider}"]`);
    if (configSection) {
      configSection.style.display = enabled ? 'block' : 'none';
    }
    AegisConfig.setValue(`cloud.${provider}.enabled`, enabled);
  },

  /**
   * Test connection
   */
  async testConnection(type, provider, button) {
    const originalText = button.textContent;
    button.textContent = 'Testing...';
    button.disabled = true;

    try {
      let result;

      switch (type) {
        case 'llm':
          result = await this.testLLMConnection(provider);
          break;
        case 'cloud':
          result = await this.testCloudConnection(provider);
          break;
        case 'channel':
          result = await this.testChannelConnection(provider);
          break;
        default:
          throw new Error('Unknown connection type');
      }

      if (result.success) {
        Toast.success(`${provider} connection successful!`);
        button.classList.add('success');
      } else {
        Toast.error(`Connection failed: ${result.error || 'Unknown error'}`);
        button.classList.add('error');
      }
    } catch (error) {
      Toast.error(`Test failed: ${error.message}`);
      button.classList.add('error');
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
  async testLLMConnection(provider) {
    const config = AegisConfig.get();
    const providerConfig = config.llm[provider];

    if (provider === 'ollama') {
      try {
        const response = await fetch(`${providerConfig.baseUrl}/api/tags`, {
          signal: AbortSignal.timeout(5000)
        });
        return { success: response.ok };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }

    return AegisAPI.testLLMConnection(provider, providerConfig);
  },

  /**
   * Test cloud connection
   */
  async testCloudConnection(provider) {
    const config = AegisConfig.get();
    return AegisAPI.testCloudConnection(provider, config.cloud[provider]);
  },

  /**
   * Test channel connection
   */
  async testChannelConnection(channel) {
    const config = AegisConfig.get();
    return AegisAPI.testChannelConnection(channel, config.channels[channel]);
  },

  /**
   * Update channel status indicators
   */
  async updateChannelStatus() {
    try {
      const status = await AegisAPI.getChannelStatus();

      Object.entries(status).forEach(([channel, info]) => {
        const indicator = document.querySelector(`.channel-status[data-channel="${channel}"]`);
        if (indicator) {
          indicator.className = `channel-status ${info.connected ? 'connected' : 'disconnected'}`;
          indicator.title = info.connected ? 'Connected' : 'Disconnected';
        }
      });
    } catch (error) {
      console.error('Failed to get channel status:', error);
    }
  },

  /**
   * Set application theme
   */
  setTheme(theme) {
    const root = document.documentElement;

    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      root.setAttribute('data-theme', theme);
    }

    AegisConfig.setValue('general.theme', theme);
  },

  /**
   * Export configuration
   */
  exportConfig() {
    const config = AegisConfig.export();
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `aegis-config-${new Date().toISOString().split('T')[0]}.json`;
    a.click();

    URL.revokeObjectURL(url);
    Toast.success('Configuration exported');
  },

  /**
   * Import configuration
   */
  async importConfig(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const config = JSON.parse(text);

      if (!confirm('Import this configuration? Current settings will be overwritten.')) {
        return;
      }

      AegisConfig.update(config);
      this.loadSettings();
      Toast.success('Configuration imported successfully');
    } catch (error) {
      Toast.error(`Failed to import: ${error.message}`);
    }

    // Reset input
    event.target.value = '';
  },

  /**
   * Mark settings as dirty (changed)
   */
  markDirty() {
    const saveBtn = document.querySelector('.settings-save-btn');
    if (saveBtn) {
      saveBtn.classList.add('dirty');
    }
  },

  /**
   * Clear dirty state
   */
  clearDirty() {
    const saveBtn = document.querySelector('.settings-save-btn');
    if (saveBtn) {
      saveBtn.classList.remove('dirty');
    }
  }
};

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Settings;
}
