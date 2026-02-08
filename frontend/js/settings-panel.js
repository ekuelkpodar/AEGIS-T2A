/**
 * Settings Panel - Comprehensive Configuration UI
 *
 * Allows users to customize all aspects of AEGIS-T2A including:
 * - Model selection (Claude, GPT, Ollama, OpenRouter, etc.)
 * - Provider configuration
 * - Feature toggles
 * - Security settings
 * - Performance tuning
 */

const SettingsPanel = {
  currentSettings: null,
  availableModels: {
    anthropic: [
      'claude-opus-4-20250514',       // Claude Opus 4
      'claude-sonnet-4-20250514',     // Claude Sonnet 4
      'claude-3-7-sonnet-20250219',   // Claude Sonnet 3.7
      'claude-3-5-sonnet-20241022',   // Claude Sonnet 3.5
      'claude-3-5-haiku-20241022'     // Claude Haiku 3.5
    ],
    openai: [
      'gpt-5.1',
      'gpt-5.1-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'o3-mini'
    ],
    ollama: [],  // Populated dynamically from Ollama API
    openrouter: [
      'anthropic/claude-opus-4-20250514',
      'anthropic/claude-sonnet-4-20250514',
      'openai/gpt-5.1',
      'openai/gpt-4.1',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-r1',
      'meta-llama/llama-3-70b-instruct',
      'mistralai/mixtral-8x22b'
    ],
    gemini: [
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite'
    ],
  },

  modelCache: {},
  saveDebounceTimer: null,
  validationStates: {},
  modelPresets: {
    fast: {
      temperature: 0.3,
      maxTokens: 2048,
      models: {
        anthropic: 'claude-3-5-haiku-20241022',
        openai: 'gpt-4o-mini',
        gemini: 'gemini-2.5-flash-lite',
        openrouter: 'google/gemini-2.5-flash',
        ollama: 'llama3.2',
      },
    },
    balanced: {
      temperature: 0.7,
      maxTokens: 4096,
      models: {
        anthropic: 'claude-sonnet-4-20250514',
        openai: 'gpt-4.1',
        gemini: 'gemini-2.5-pro',
        openrouter: 'anthropic/claude-sonnet-4-20250514',
        ollama: 'llama3.2',
      },
    },
    quality: {
      temperature: 0.2,
      maxTokens: 8192,
      models: {
        anthropic: 'claude-opus-4-20250514',
        openai: 'gpt-5.1',
        gemini: 'gemini-3-pro-preview',
        openrouter: 'openai/gpt-5.1',
        ollama: 'llama3-70b',
      },
    },
  },

  init() {
    this.loadCurrentSettings();
    this.createSettingsPanel();
    this.bindEvents();
    this.fetchDynamicModels();
  },

  /**
   * Dynamically fetch available models from Ollama API
   */
  async fetchDynamicModels() {
    try {
      const endpoint = this.currentSettings?.llm?.endpoint || 'http://localhost:11434';
      const response = await fetch(`${endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        const data = await response.json();
        if (data.models && Array.isArray(data.models)) {
          this.availableModels.ollama = data.models.map(m => m.name);
          this.modelCache.ollama = {
            models: data.models,
            timestamp: Date.now()
          };
          console.log('[SettingsPanel] Fetched', this.availableModels.ollama.length, 'Ollama models');

          // Update dropdown if Ollama is currently selected
          const providerSelect = document.getElementById('setting-llm-provider');
          if (providerSelect && providerSelect.value === 'ollama') {
            this.updateModelDropdown('ollama');
          }

          this.showValidationIndicator('ollama-connection', 'success', `Connected - ${data.models.length} models available`);
        }
      } else {
        throw new Error('Ollama not reachable');
      }
    } catch (error) {
      console.warn('[SettingsPanel] Could not fetch Ollama models:', error);
      // Fallback to latest models (February 2026)
      this.availableModels.ollama = [
        // Latest flagship models
        'llama3-70b',
        'llama3-8b',
        'qwen3-coder-next',
        'qwen3-next',
        'qwen3-vl',
        'deepseek-v3',
        'deepseek-r1',
        // Latest specialized models
        'glm-4.7-flash',
        'glm-ocr',
        'kimi-k2.5',
        'lfm2.5-thinking',
        'rnj-1',
        // Popular stable models
        'qwen2.5',
        'qwen2.5-vl',
        'mistral',
        'mixtral',
        'ministral-3',
        'translategemma',
        'codellama',
        'phi3',
        'gemma2',
        'neural-chat',
        // Legacy
        'llama3.2',
        'llama3.1'
      ];
      this.showValidationIndicator('ollama-connection', 'warning', 'Using cached models - Ollama not running');
    }
  },

  /**
   * Show validation indicator with icon and message
   */
  showValidationIndicator(id, state, message) {
    this.validationStates[id] = { state, message, timestamp: Date.now() };

    // Update UI if element exists
    const indicator = document.getElementById(`validation-${id}`);
    if (indicator) {
      indicator.style.display = 'flex';
      indicator.className = `validation-indicator ${state}`;
      indicator.innerHTML = `
        <i class="fas fa-${state === 'success' ? 'check-circle' : state === 'error' ? 'times-circle' : 'exclamation-triangle'}"></i>
        <span>${message}</span>
      `;
    }
  },

  /**
   * Check model availability for current provider
   */
  async checkModelAvailability(provider, model) {
    const badge = document.getElementById('model-availability-badge');
    if (!badge) return;

    badge.style.display = 'inline-flex';
    badge.className = 'model-availability checking';
    badge.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';

    try {
      // For Ollama, check against fetched models
      if (provider === 'ollama') {
        const isAvailable = this.availableModels.ollama.includes(model);
        badge.className = `model-availability ${isAvailable ? 'available' : 'unavailable'}`;
        badge.innerHTML = `<i class="fas fa-${isAvailable ? 'check' : 'times'}"></i> ${isAvailable ? 'Available' : 'Not Installed'}`;

        if (!isAvailable) {
          this.showValidationIndicator('model-availability', 'warning',
            `Model "${model}" not found. Install it with: ollama pull ${model}`);
        } else {
          const validationDiv = document.getElementById('validation-model-availability');
          if (validationDiv) validationDiv.style.display = 'none';
        }
      } else {
        // For cloud providers, assume available
        badge.className = 'model-availability available';
        badge.innerHTML = '<i class="fas fa-check"></i> Available';
        const validationDiv = document.getElementById('validation-model-availability');
        if (validationDiv) validationDiv.style.display = 'none';
      }
    } catch (error) {
      badge.className = 'model-availability unavailable';
      badge.innerHTML = '<i class="fas fa-times"></i> Unknown';
    }
  },

  /**
   * Validate API key format and optionally test connection
   */
  async validateApiKey(provider, apiKey) {
    if (!apiKey || apiKey.trim() === '') {
      this.showValidationIndicator('api-key', 'warning', 'API key is required for this provider');
      return false;
    }

    // Basic format validation
    const validationRules = {
      anthropic: /^sk-ant-[a-zA-Z0-9\-_]{40,}$/,
      openai: /^sk-[a-zA-Z0-9]{48,}$/,
      openrouter: /^sk-or-v1-[a-zA-Z0-9]{64,}$/,
      gemini: /^AIza[0-9A-Za-z\-_]{30,}$/
    };

    const pattern = validationRules[provider];
    if (pattern && !pattern.test(apiKey)) {
      this.showValidationIndicator('api-key', 'warning', 'API key format looks incorrect');
      return false;
    }

    this.showValidationIndicator('api-key', 'success', 'API key format is valid');
    return true;
  },

  /**
   * Auto-save settings with debounce
   */
  autoSaveSettings() {
    clearTimeout(this.saveDebounceTimer);

    const saveIndicator = document.getElementById('auto-save-indicator');
    if (saveIndicator) {
      saveIndicator.textContent = 'Saving...';
      saveIndicator.className = 'auto-save-indicator saving';
    }

    this.saveDebounceTimer = setTimeout(() => {
      this.saveSettings(true); // true = silent auto-save
    }, 1000);
  },

  async loadCurrentSettings() {
    try {
      const response = await fetch('/api/settings');
      if (response.ok) {
        this.currentSettings = await response.json();
      } else {
        this.currentSettings = this.getDefaultSettings();
      }
    } catch (error) {
      console.warn('Failed to load settings, using defaults:', error);
      this.currentSettings = this.getDefaultSettings();
    }
  },

  getDefaultSettings() {
    return {
      llm: {
        provider: 'ollama',
        model: 'llama3.2',
        apiKey: '',
        endpoint: 'http://localhost:11434',
        temperature: 0.7,
        maxTokens: 4096,
      },
      security: {
        requireApproval: true,
        promptInjectionDetection: true,
        rateLimiting: true,
        maxRequestsPerMinute: 60,
      },
      features: {
        shadowExecution: true,
        blastRadiusAnalysis: true,
        confidenceScoring: true,
        policyEngine: true,
        auditLogging: true,
        identityManagement: true,
      },
      performance: {
        cacheEnabled: true,
        cacheTTL: 3600,
        parallelExecution: true,
        maxConcurrent: 5,
      },
      ui: {
        theme: 'dark',
        autoRefresh: true,
        refreshInterval: 5000,
        notifications: true,
      },
    };
  },

  createSettingsPanel() {
    const settingsHTML = `
      <div id="settings-panel" class="settings-panel hidden">
        <div class="settings-overlay" id="settings-overlay"></div>
        <div class="settings-container">
          <div class="settings-header">
            <h2>
              <i class="fas fa-cog"></i> Settings & Configuration
              <span id="auto-save-indicator" class="auto-save-indicator"></span>
            </h2>
            <button class="settings-close" id="settings-close">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <div class="settings-content">
            <div class="settings-sidebar">
              <div class="settings-nav">
                <button class="settings-nav-item active" data-tab="models">
                  <i class="fas fa-brain"></i> AI Models
                </button>
                <button class="settings-nav-item" data-tab="security">
                  <i class="fas fa-shield-alt"></i> Security
                </button>
                <button class="settings-nav-item" data-tab="features">
                  <i class="fas fa-puzzle-piece"></i> Features
                </button>
                <button class="settings-nav-item" data-tab="performance">
                  <i class="fas fa-tachometer-alt"></i> Performance
                </button>
                <button class="settings-nav-item" data-tab="ui">
                  <i class="fas fa-palette"></i> UI/UX
                </button>
                <button class="settings-nav-item" data-tab="advanced">
                  <i class="fas fa-wrench"></i> Advanced
                </button>
              </div>
            </div>

            <div class="settings-main">
              <!-- AI Models Tab -->
              <div class="settings-tab active" data-tab-content="models">
                <h3>AI Model Configuration</h3>
                <p class="tab-description">Configure your AI provider and models for intent parsing and execution planning.</p>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Provider</span>
                    <select id="setting-llm-provider" class="setting-select">
                      <option value="anthropic">Anthropic Claude</option>
                      <option value="openai">OpenAI GPT</option>
                      <option value="gemini">Google Gemini</option>
                      <option value="ollama" selected>Ollama (Local)</option>
                      <option value="openrouter">OpenRouter</option>
                    </select>
                  </label>
                  <div id="validation-provider-selection" class="validation-indicator" style="display: none;"></div>
                </div>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Quick Presets</span>
                    <div class="preset-buttons" role="group" aria-label="Model presets">
                      <button type="button" class="preset-button" data-preset="fast">Fast</button>
                      <button type="button" class="preset-button active" data-preset="balanced">Balanced</button>
                      <button type="button" class="preset-button" data-preset="quality">Quality</button>
                    </div>
                    <small>Applies model + temperature + max tokens for the current provider.</small>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Model <span class="model-availability checking" id="model-availability-badge" style="display: none;">
                      <i class="fas fa-spinner fa-spin"></i> Checking...
                    </span></span>
                    <select id="setting-llm-model" class="setting-select">
                      <!-- Populated dynamically -->
                    </select>
                  </label>
                  <div id="validation-model-availability" class="validation-indicator" style="display: none;"></div>
                </div>

                <div class="setting-group" id="api-key-group">
                  <label class="setting-label">
                    <span>API Key</span>
                    <input type="password" id="setting-api-key" class="setting-input" placeholder="Enter your API key">
                    <small>Your API key is stored locally and encrypted</small>
                  </label>
                  <div id="validation-api-key" class="validation-indicator" style="display: none;"></div>
                </div>

                <div class="setting-group" id="endpoint-group">
                  <label class="setting-label">
                    <span>Endpoint URL</span>
                    <input type="text" id="setting-endpoint" class="setting-input" placeholder="http://localhost:11434">
                    <small>For Ollama or custom endpoints</small>
                  </label>
                  <div id="validation-ollama-connection" class="validation-indicator" style="display: none;"></div>
                </div>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Temperature (0-1)</span>
                    <input type="range" id="setting-temperature" class="setting-range" min="0" max="1" step="0.1" value="0.7">
                    <span class="setting-value" id="temperature-value">0.7</span>
                    <small>Higher = more creative, Lower = more focused</small>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Max Tokens</span>
                    <input type="number" id="setting-max-tokens" class="setting-input" value="4096" min="128" max="32768">
                    <small>Maximum response length</small>
                  </label>
                </div>

                <button class="btn-primary" id="test-model-connection">
                  <i class="fas fa-plug"></i> Test Connection
                </button>
              </div>

              <!-- Security Tab -->
              <div class="settings-tab" data-tab-content="security">
                <h3>Security Configuration</h3>
                <p class="tab-description">Configure security policies and access controls.</p>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-require-approval" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Require Approval for High-Risk Actions</strong>
                      <small>Destructive operations need manual approval</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-prompt-injection" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Prompt Injection Detection</strong>
                      <small>Block malicious prompt attempts</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-rate-limiting" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Rate Limiting</strong>
                      <small>Prevent API abuse</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Max Requests per Minute</span>
                    <input type="number" id="setting-max-rpm" class="setting-input" value="60" min="1" max="1000">
                  </label>
                </div>
              </div>

              <!-- Features Tab -->
              <div class="settings-tab" data-tab-content="features">
                <h3>Feature Configuration</h3>
                <p class="tab-description">Enable or disable platform features.</p>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-shadow-execution" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Shadow Execution</strong>
                      <small>Test plans before production execution</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-blast-radius" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Blast Radius Analysis</strong>
                      <small>Predict impact of changes</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-confidence-scoring" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Confidence Scoring</strong>
                      <small>Bayesian confidence calculation</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-policy-engine" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Policy Engine</strong>
                      <small>Enforce governance policies</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-audit-logging" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Audit Logging</strong>
                      <small>Track all actions for compliance</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-identity-mgmt" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Identity Management (SPIFFE)</strong>
                      <small>Zero-trust workload identity</small>
                    </span>
                  </label>
                </div>
              </div>

              <!-- Performance Tab -->
              <div class="settings-tab" data-tab-content="performance">
                <h3>Performance Tuning</h3>
                <p class="tab-description">Optimize performance and resource usage.</p>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-cache-enabled" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Response Caching</strong>
                      <small>Cache API responses for faster performance</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Cache TTL (seconds)</span>
                    <input type="number" id="setting-cache-ttl" class="setting-input" value="3600" min="60" max="86400">
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-parallel-execution" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Parallel Execution</strong>
                      <small>Execute independent steps concurrently</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Max Concurrent Tasks</span>
                    <input type="number" id="setting-max-concurrent" class="setting-input" value="5" min="1" max="20">
                  </label>
                </div>
              </div>

              <!-- UI/UX Tab -->
              <div class="settings-tab" data-tab-content="ui">
                <h3>UI/UX Preferences</h3>
                <p class="tab-description">Customize the dashboard appearance and behavior.</p>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Theme</span>
                    <select id="setting-theme" class="setting-select">
                      <option value="dark" selected>Dark</option>
                      <option value="light">Light</option>
                      <option value="auto">Auto (System)</option>
                    </select>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-auto-refresh" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Auto Refresh</strong>
                      <small>Automatically update dashboard</small>
                    </span>
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Refresh Interval (ms)</span>
                    <input type="number" id="setting-refresh-interval" class="setting-input" value="5000" min="1000" max="60000" step="1000">
                  </label>
                </div>

                <div class="setting-group">
                  <label class="setting-toggle">
                    <input type="checkbox" id="setting-notifications" checked>
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">
                      <strong>Desktop Notifications</strong>
                      <small>Show system notifications for events</small>
                    </span>
                  </label>
                </div>
              </div>

              <!-- Advanced Tab -->
              <div class="settings-tab" data-tab-content="advanced">
                <h3>Advanced Settings</h3>
                <p class="tab-description">Advanced configuration for power users.</p>

                <div class="setting-group">
                  <label class="setting-label">
                    <span>Debug Mode</span>
                    <select id="setting-debug-mode" class="setting-select">
                      <option value="off" selected>Off</option>
                      <option value="info">Info</option>
                      <option value="debug">Debug</option>
                      <option value="trace">Trace</option>
                    </select>
                  </label>
                </div>

                <div class="setting-group">
                  <button class="btn-secondary" id="export-settings">
                    <i class="fas fa-download"></i> Export Settings
                  </button>
                  <button class="btn-secondary" id="import-settings">
                    <i class="fas fa-upload"></i> Import Settings
                  </button>
                  <input type="file" id="import-settings-file" accept=".json" style="display: none;">
                </div>

                <div class="setting-group">
                  <button class="btn-danger" id="reset-settings">
                    <i class="fas fa-undo"></i> Reset to Defaults
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-footer">
            <button class="btn-secondary" id="settings-cancel">Cancel</button>
            <button class="btn-primary" id="settings-save">
              <i class="fas fa-save"></i> Save Settings
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', settingsHTML);
    this.populateModelOptions();
    this.loadSettingsValues();
  },

  populateModelOptions() {
    const provider = document.getElementById('setting-llm-provider').value;
    this.updateModelDropdown(provider);
  },

  /**
   * Update model dropdown with available models for the provider
   */
  updateModelDropdown(provider) {
    const modelSelect = document.getElementById('setting-llm-model');
    if (!modelSelect) return;

    modelSelect.innerHTML = '';

    const models = this.availableModels[provider] || [];

    if (models.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = provider === 'ollama' ? 'Loading models...' : 'No models available';
      option.disabled = true;
      modelSelect.appendChild(option);
      return;
    }

    models.forEach((model, index) => {
      const option = document.createElement('option');
      option.value = model;

      // Format display name
      let displayName = model;
      if (provider === 'openrouter' && model.includes('/')) {
        displayName = model.split('/')[1]; // Show just the model name
      }

      option.textContent = displayName;

      // Add recommended badge to first model
      if (index === 0) {
        option.textContent += ' (Recommended)';
      }

      modelSelect.appendChild(option);
    });

    // Check availability of currently selected model
    if (modelSelect.value) {
      this.checkModelAvailability(provider, modelSelect.value);
    }
  },

  loadSettingsValues() {
    if (!this.currentSettings) return;

    // LLM settings
    document.getElementById('setting-llm-provider').value = this.currentSettings.llm.provider;
    this.populateModelOptions();
    document.getElementById('setting-llm-model').value = this.currentSettings.llm.model;
    document.getElementById('setting-api-key').value = this.currentSettings.llm.apiKey || '';
    document.getElementById('setting-endpoint').value = this.currentSettings.llm.endpoint || '';
    document.getElementById('setting-temperature').value = this.currentSettings.llm.temperature;
    document.getElementById('temperature-value').textContent = this.currentSettings.llm.temperature;
    document.getElementById('setting-max-tokens').value = this.currentSettings.llm.maxTokens;

    // Security
    document.getElementById('setting-require-approval').checked = this.currentSettings.security.requireApproval;
    document.getElementById('setting-prompt-injection').checked = this.currentSettings.security.promptInjectionDetection;
    document.getElementById('setting-rate-limiting').checked = this.currentSettings.security.rateLimiting;
    document.getElementById('setting-max-rpm').value = this.currentSettings.security.maxRequestsPerMinute;

    // Features
    document.getElementById('setting-shadow-execution').checked = this.currentSettings.features.shadowExecution;
    document.getElementById('setting-blast-radius').checked = this.currentSettings.features.blastRadiusAnalysis;
    document.getElementById('setting-confidence-scoring').checked = this.currentSettings.features.confidenceScoring;
    document.getElementById('setting-policy-engine').checked = this.currentSettings.features.policyEngine;
    document.getElementById('setting-audit-logging').checked = this.currentSettings.features.auditLogging;
    document.getElementById('setting-identity-mgmt').checked = this.currentSettings.features.identityManagement;

    // Performance
    document.getElementById('setting-cache-enabled').checked = this.currentSettings.performance.cacheEnabled;
    document.getElementById('setting-cache-ttl').value = this.currentSettings.performance.cacheTTL;
    document.getElementById('setting-parallel-execution').checked = this.currentSettings.performance.parallelExecution;
    document.getElementById('setting-max-concurrent').value = this.currentSettings.performance.maxConcurrent;

    // UI
    document.getElementById('setting-theme').value = this.currentSettings.ui.theme;
    document.getElementById('setting-auto-refresh').checked = this.currentSettings.ui.autoRefresh;
    document.getElementById('setting-refresh-interval').value = this.currentSettings.ui.refreshInterval;
    document.getElementById('setting-notifications').checked = this.currentSettings.ui.notifications;
  },

  bindEvents() {
    // Open settings
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="open-settings"]')) {
        this.open();
      }
    });

    // Close settings
    document.getElementById('settings-close')?.addEventListener('click', () => this.close());
    document.getElementById('settings-overlay')?.addEventListener('click', () => this.close());
    document.getElementById('settings-cancel')?.addEventListener('click', () => this.close());

    // Tab navigation
    document.querySelectorAll('.settings-nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const tab = e.currentTarget.dataset.tab;
        this.switchTab(tab);
      });
    });

    // Provider change
    document.getElementById('setting-llm-provider')?.addEventListener('change', (e) => {
      const provider = e.target.value;
      this.populateModelOptions();
      this.updateProviderFields(provider);
      this.showValidationIndicator('provider-selection', 'success', `Switched to ${provider}`);

      // Check model availability for new provider
      setTimeout(() => {
        const model = document.getElementById('setting-llm-model').value;
        if (model) {
          this.checkModelAvailability(provider, model);
        }
      }, 100);

      // Re-fetch Ollama models if switching to Ollama
      if (provider === 'ollama') {
        this.fetchDynamicModels();
      }
    });

    // Model change - check availability
    document.getElementById('setting-llm-model')?.addEventListener('change', (e) => {
      const provider = document.getElementById('setting-llm-provider').value;
      const model = e.target.value;
      this.checkModelAvailability(provider, model);
    });

    // API key validation on blur
    document.getElementById('setting-api-key')?.addEventListener('blur', (e) => {
      const provider = document.getElementById('setting-llm-provider').value;
      const apiKey = e.target.value;
      if (provider !== 'ollama' && apiKey) {
        this.validateApiKey(provider, apiKey);
      }
    });

    // Temperature slider
    document.getElementById('setting-temperature')?.addEventListener('input', (e) => {
      document.getElementById('temperature-value').textContent = e.target.value;
      this.autoSaveSettings();
    });

    // Test connection
    document.getElementById('test-model-connection')?.addEventListener('click', () => {
      this.testModelConnection();
    });

    // Preset buttons
    document.querySelectorAll('.preset-button').forEach((button) => {
      button.addEventListener('click', () => {
        const preset = button.getAttribute('data-preset');
        if (preset) {
          this.applyPreset(preset);
          document.querySelectorAll('.preset-button').forEach((btn) => btn.classList.remove('active'));
          button.classList.add('active');
        }
      });
    });

    // Auto-save on input changes
    const autoSaveInputs = [
      'setting-llm-provider',
      'setting-llm-model',
      'setting-endpoint',
      'setting-max-tokens',
      'setting-max-rpm',
      'setting-cache-ttl',
      'setting-max-concurrent',
      'setting-refresh-interval',
      'setting-theme'
    ];

    autoSaveInputs.forEach(id => {
      const element = document.getElementById(id);
      if (element) {
        element.addEventListener('change', () => this.autoSaveSettings());
      }
    });

    // Auto-save on checkbox changes
    const autoSaveCheckboxes = [
      'setting-require-approval',
      'setting-prompt-injection',
      'setting-rate-limiting',
      'setting-shadow-execution',
      'setting-blast-radius',
      'setting-confidence-scoring',
      'setting-policy-engine',
      'setting-audit-logging',
      'setting-identity-mgmt',
      'setting-cache-enabled',
      'setting-parallel-execution',
      'setting-auto-refresh',
      'setting-notifications'
    ];

    autoSaveCheckboxes.forEach(id => {
      const element = document.getElementById(id);
      if (element) {
        element.addEventListener('change', () => this.autoSaveSettings());
      }
    });

    // Save settings (manual)
    document.getElementById('settings-save')?.addEventListener('click', () => {
      this.saveSettings();
    });

    // Export/Import
    document.getElementById('export-settings')?.addEventListener('click', () => this.exportSettings());
    document.getElementById('import-settings')?.addEventListener('click', () => {
      document.getElementById('import-settings-file').click();
    });
    document.getElementById('import-settings-file')?.addEventListener('change', (e) => {
      this.importSettings(e);
    });

    // Reset
    document.getElementById('reset-settings')?.addEventListener('click', () => {
      if (confirm('Are you sure you want to reset all settings to defaults?')) {
        this.resetToDefaults();
      }
    });
  },

  switchTab(tabName) {
    document.querySelectorAll('.settings-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.tab === tabName);
    });
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tabContent === tabName);
    });
  },

  updateProviderFields(provider) {
    const apiKeyGroup = document.getElementById('api-key-group');
    const endpointGroup = document.getElementById('endpoint-group');

    if (provider === 'ollama') {
      apiKeyGroup.style.display = 'none';
      endpointGroup.style.display = 'block';
    } else {
      apiKeyGroup.style.display = 'block';
      endpointGroup.style.display = provider === 'openrouter' || provider === 'gemini' ? 'block' : 'none';
    }
  },

  applyPreset(presetName) {
    const provider = document.getElementById('setting-llm-provider').value;
    const preset = this.modelPresets[presetName];
    if (!preset) return;

    const model = preset.models[provider] || this.availableModels[provider]?.[0];
    if (model) {
      document.getElementById('setting-llm-model').value = model;
      this.checkModelAvailability(provider, model);
    }

    const temperatureInput = document.getElementById('setting-temperature');
    const maxTokensInput = document.getElementById('setting-max-tokens');
    if (temperatureInput) {
      temperatureInput.value = preset.temperature;
      document.getElementById('temperature-value').textContent = preset.temperature;
    }
    if (maxTokensInput) {
      maxTokensInput.value = preset.maxTokens;
    }

    this.autoSaveSettings();
  },

  async testModelConnection() {
    const btn = document.getElementById('test-model-connection');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';

    try {
      const response = await fetch('/api/test-llm-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: document.getElementById('setting-llm-provider').value,
          model: document.getElementById('setting-llm-model').value,
          apiKey: document.getElementById('setting-api-key').value,
          endpoint: document.getElementById('setting-endpoint').value,
        }),
      });

      if (response.ok) {
        alert('✅ Connection successful!');
      } else {
        const error = await response.json();
        alert(`❌ Connection failed: ${error.message}`);
      }
    } catch (error) {
      alert(`❌ Connection failed: ${error.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plug"></i> Test Connection';
    }
  },

  async saveSettings(silent = false) {
    const settings = {
      llm: {
        provider: document.getElementById('setting-llm-provider').value,
        model: document.getElementById('setting-llm-model').value,
        apiKey: document.getElementById('setting-api-key').value,
        endpoint: document.getElementById('setting-endpoint').value,
        temperature: parseFloat(document.getElementById('setting-temperature').value),
        maxTokens: parseInt(document.getElementById('setting-max-tokens').value),
      },
      security: {
        requireApproval: document.getElementById('setting-require-approval').checked,
        promptInjectionDetection: document.getElementById('setting-prompt-injection').checked,
        rateLimiting: document.getElementById('setting-rate-limiting').checked,
        maxRequestsPerMinute: parseInt(document.getElementById('setting-max-rpm').value),
      },
      features: {
        shadowExecution: document.getElementById('setting-shadow-execution').checked,
        blastRadiusAnalysis: document.getElementById('setting-blast-radius').checked,
        confidenceScoring: document.getElementById('setting-confidence-scoring').checked,
        policyEngine: document.getElementById('setting-policy-engine').checked,
        auditLogging: document.getElementById('setting-audit-logging').checked,
        identityManagement: document.getElementById('setting-identity-mgmt').checked,
      },
      performance: {
        cacheEnabled: document.getElementById('setting-cache-enabled').checked,
        cacheTTL: parseInt(document.getElementById('setting-cache-ttl').value),
        parallelExecution: document.getElementById('setting-parallel-execution').checked,
        maxConcurrent: parseInt(document.getElementById('setting-max-concurrent').value),
      },
      ui: {
        theme: document.getElementById('setting-theme').value,
        autoRefresh: document.getElementById('setting-auto-refresh').checked,
        refreshInterval: parseInt(document.getElementById('setting-refresh-interval').value),
        notifications: document.getElementById('setting-notifications').checked,
      },
    };

    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      if (response.ok) {
        this.currentSettings = settings;
        this.applySettings();

        if (!silent) {
          this.showToast('Settings saved successfully!', 'success');
          this.close();
        } else {
          this.updateAutoSaveIndicator('saved');
        }
      } else {
        if (!silent) {
          this.showToast('Failed to save settings', 'error');
        } else {
          this.updateAutoSaveIndicator('error');
        }
      }
    } catch (error) {
      // Save to localStorage as fallback
      localStorage.setItem('aegis-settings', JSON.stringify(settings));
      this.currentSettings = settings;
      this.applySettings();

      if (!silent) {
        this.showToast('Settings saved locally!', 'success');
        this.close();
      } else {
        this.updateAutoSaveIndicator('saved');
      }
    }
  },

  /**
   * Update auto-save indicator
   */
  updateAutoSaveIndicator(state) {
    const indicator = document.getElementById('auto-save-indicator');
    if (!indicator) return;

    switch (state) {
      case 'saving':
        indicator.textContent = 'Saving...';
        indicator.className = 'auto-save-indicator saving';
        break;
      case 'saved':
        indicator.textContent = 'Saved ✓';
        indicator.className = 'auto-save-indicator saved';
        setTimeout(() => {
          indicator.textContent = '';
          indicator.className = 'auto-save-indicator';
        }, 2000);
        break;
      case 'error':
        indicator.textContent = 'Save failed';
        indicator.className = 'auto-save-indicator error';
        setTimeout(() => {
          indicator.textContent = '';
          indicator.className = 'auto-save-indicator';
        }, 3000);
        break;
    }
  },

  /**
   * Show toast notification
   */
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container') || document.body;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'times-circle' : 'info-circle'}"></i>
      <span>${message}</span>
    `;
    container.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },

  applySettings() {
    // Apply theme
    document.documentElement.setAttribute('data-theme', this.currentSettings.ui.theme);

    // Apply auto-refresh
    if (Dashboard.refreshInterval) {
      clearInterval(Dashboard.refreshInterval);
    }
    if (this.currentSettings.ui.autoRefresh) {
      Dashboard.startAutoRefresh(this.currentSettings.ui.refreshInterval);
    }

    // Request notification permission
    if (this.currentSettings.ui.notifications && 'Notification' in window) {
      Notification.requestPermission();
    }
  },

  exportSettings() {
    const dataStr = JSON.stringify(this.currentSettings, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'aegis-settings.json';
    link.click();
    URL.revokeObjectURL(url);
  },

  importSettings(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const settings = JSON.parse(e.target.result);
        this.currentSettings = settings;
        this.loadSettingsValues();
        alert('✅ Settings imported successfully!');
      } catch (error) {
        alert('❌ Failed to import settings: Invalid file format');
      }
    };
    reader.readAsText(file);
  },

  resetToDefaults() {
    this.currentSettings = this.getDefaultSettings();
    this.loadSettingsValues();
  },

  open() {
    const panel = document.getElementById('settings-panel');
    if (panel) {
      panel.classList.remove('hidden');
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';

      // Add ESC key listener
      this.handleEscKey = (e) => {
        if (e.key === 'Escape') {
          this.close();
        }
      };
      document.addEventListener('keydown', this.handleEscKey);
    }
  },

  close() {
    const panel = document.getElementById('settings-panel');
    if (panel) {
      panel.classList.add('hidden');
      // Restore body scroll
      document.body.style.overflow = '';

      // Remove ESC key listener
      if (this.handleEscKey) {
        document.removeEventListener('keydown', this.handleEscKey);
        this.handleEscKey = null;
      }
    }
  },
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => SettingsPanel.init());
} else {
  SettingsPanel.init();
}
