/**
 * AEGIS-T2A Main Application
 *
 * Initializes and coordinates all frontend components.
 */

const AegisApp = {
  initialized: false,

  /**
   * Initialize the application
   */
  async init() {
    if (this.initialized) return;

    console.log('Initializing AEGIS-T2A...');

    // Initialize configuration
    AegisConfig.init();

    // Initialize API client
    AegisAPI.init();

    // Set up theme
    this.initTheme();

    // Check if setup is needed
    if (!AegisConfig.isSetupComplete()) {
      this.showSetupWizard();
    } else {
      this.showMainApp();
    }

    // Initialize components
    Toast.init();

    // Set up global event handlers
    this.bindGlobalEvents();

    // Check server connectivity
    this.checkServerConnection();

    this.initialized = true;
    console.log('AEGIS-T2A initialized');
  },

  /**
   * Show setup wizard
   */
  showSetupWizard() {
    document.getElementById('loading-screen')?.classList.add('hidden');
    document.getElementById('setup-wizard')?.classList.remove('hidden');
    document.getElementById('app')?.classList.add('hidden');

    // Initialize wizard
    SetupWizard.init();
    SetupWizard.loadSavedConfig();
  },

  /**
   * Show main application
   */
  showMainApp() {
    document.getElementById('loading-screen')?.classList.add('hidden');
    document.getElementById('setup-wizard')?.classList.add('hidden');
    document.getElementById('app')?.classList.remove('hidden');

    // Initialize dashboard and settings
    Dashboard.init();
    Settings.init();

    // Load initial data
    this.loadInitialData();
  },

  /**
   * Initialize theme
   */
  initTheme() {
    const theme = AegisConfig.getValue('general.theme') || 'system';
    const root = document.documentElement;

    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');

      // Listen for system theme changes
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (AegisConfig.getValue('general.theme') === 'system') {
          root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
        }
      });
    } else {
      root.setAttribute('data-theme', theme);
    }
  },

  /**
   * Bind global event handlers
   */
  bindGlobalEvents() {
    // Navigation
    document.querySelectorAll('[data-nav]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.navigate(link.dataset.nav);
      });
    });

    // Modal close buttons
    document.querySelectorAll('.modal-close, .modal-overlay').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target === el) {
          this.closeModal(el.closest('.modal'));
        }
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      this.handleKeyboard(e);
    });

    // Handle page visibility
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        Dashboard.startAutoRefresh();
      } else {
        Dashboard.stopAutoRefresh();
      }
    });

    // Handle online/offline
    window.addEventListener('online', () => {
      Toast.success('Connection restored');
      this.checkServerConnection();
    });

    window.addEventListener('offline', () => {
      Toast.error('Connection lost');
    });

    // Prevent accidental navigation with unsaved changes
    window.addEventListener('beforeunload', (e) => {
      if (document.querySelector('.dirty')) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  },

  /**
   * Navigate to a section
   */
  navigate(section) {
    // Update navigation state
    document.querySelectorAll('[data-nav]').forEach(link => {
      link.classList.toggle('active', link.dataset.nav === section);
    });

    // Show section
    document.querySelectorAll('.app-section').forEach(sec => {
      sec.classList.toggle('active', sec.id === `section-${section}`);
    });

    // Update URL hash
    window.location.hash = section;

    // Track navigation
    console.log(`Navigated to: ${section}`);
  },

  /**
   * Handle keyboard shortcuts
   */
  handleKeyboard(e) {
    // Ctrl/Cmd + K - Quick intent input
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const intentInput = document.getElementById('intent-input');
      if (intentInput) {
        intentInput.focus();
        intentInput.select();
      }
    }

    // Escape - Close modals
    if (e.key === 'Escape') {
      const openModal = document.querySelector('.modal.show');
      if (openModal) {
        this.closeModal(openModal);
      }
    }

    // Ctrl/Cmd + S - Save settings
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      const settingsSection = document.querySelector('.settings-section.active');
      if (settingsSection) {
        e.preventDefault();
        Settings.saveSection(Settings.currentSection);
      }
    }
  },

  /**
   * Open a modal
   */
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('show');
      document.body.classList.add('modal-open');
    }
  },

  /**
   * Close a modal
   */
  closeModal(modal) {
    if (typeof modal === 'string') {
      modal = document.getElementById(modal);
    }
    if (modal) {
      modal.classList.remove('show');
      document.body.classList.remove('modal-open');
    }
  },

  /**
   * Check server connection
   */
  async checkServerConnection() {
    const indicator = document.getElementById('connection-status');

    try {
      const health = await AegisAPI.healthCheck();

      if (indicator) {
        indicator.classList.remove('disconnected', 'connecting');
        indicator.classList.add('connected');
        indicator.title = 'Connected to server';
      }

      return true;
    } catch (error) {
      console.error('Server connection failed:', error);

      if (indicator) {
        indicator.classList.remove('connected', 'connecting');
        indicator.classList.add('disconnected');
        indicator.title = 'Disconnected from server';
      }

      return false;
    }
  },

  /**
   * Load initial data
   */
  async loadInitialData() {
    try {
      // Check connection first
      const connected = await this.checkServerConnection();

      if (connected) {
        // Load adapters
        await this.loadAdapters();

        // Load policy rules
        await this.loadPolicyRules();
      }
    } catch (error) {
      console.error('Failed to load initial data:', error);
    }
  },

  /**
   * Load tool adapters
   */
  async loadAdapters() {
    try {
      const adapters = await AegisAPI.getAdapters();
      this.renderAdaptersList(adapters.adapters || adapters);
    } catch (error) {
      console.error('Failed to load adapters:', error);
    }
  },

  /**
   * Render adapters list
   */
  renderAdaptersList(adapters) {
    const container = document.getElementById('adapters-list');
    if (!container || !adapters) return;

    container.innerHTML = adapters.map(adapter => `
      <div class="adapter-card">
        <div class="adapter-header">
          <span class="adapter-icon">${this.getAdapterIcon(adapter.adapterId)}</span>
          <span class="adapter-name">${adapter.name}</span>
          <span class="adapter-version">v${adapter.version}</span>
        </div>
        <div class="adapter-meta">
          <span class="adapter-risk risk-${adapter.riskLevel}">${adapter.riskLevel}</span>
          <span class="adapter-status ${adapter.enabled !== false ? 'enabled' : 'disabled'}">
            ${adapter.enabled !== false ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <div class="adapter-capabilities">
          ${(adapter.capabilities || []).map(cap =>
            `<span class="capability-badge">${cap}</span>`
          ).join('')}
        </div>
      </div>
    `).join('');
  },

  /**
   * Get adapter icon
   */
  getAdapterIcon(adapterId) {
    const icons = {
      'aws-ec2': '☁️',
      'aws-s3': '📦',
      'aws-lambda': '⚡',
      'azure-vm': '☁️',
      'gcp-compute': '☁️',
      'github': '🐙',
      'kubernetes': '☸️',
      'docker': '🐳',
      'terraform': '🏗️',
      'ansible': '📜',
      'shell': '💻',
      'http': '🌐'
    };
    return icons[adapterId] || '🔧';
  },

  /**
   * Load policy rules
   */
  async loadPolicyRules() {
    try {
      const rules = await AegisAPI.getPolicyRules();
      this.renderPolicyRules(rules.rules || rules);
    } catch (error) {
      console.error('Failed to load policy rules:', error);
    }
  },

  /**
   * Render policy rules
   */
  renderPolicyRules(rules) {
    const container = document.getElementById('policy-rules');
    if (!container || !rules) return;

    container.innerHTML = rules.map(rule => `
      <div class="policy-rule ${rule.effect}">
        <div class="rule-header">
          <span class="rule-name">${rule.name}</span>
          <span class="rule-effect effect-${rule.effect}">${rule.effect}</span>
        </div>
        <div class="rule-description">${rule.description || ''}</div>
        <div class="rule-conditions">
          ${(rule.conditions || []).map(cond =>
            `<span class="condition-badge">${cond.field} ${cond.operator} ${cond.value}</span>`
          ).join('')}
        </div>
      </div>
    `).join('');
  },

  /**
   * Show loading state
   */
  showLoading(message = 'Loading...') {
    const loader = document.getElementById('loading-overlay');
    const loaderText = document.getElementById('loading-text');

    if (loaderText) loaderText.textContent = message;
    if (loader) loader.classList.add('show');
  },

  /**
   * Hide loading state
   */
  hideLoading() {
    const loader = document.getElementById('loading-overlay');
    if (loader) loader.classList.remove('show');
  },

  /**
   * Reset application
   */
  reset() {
    if (!confirm('Reset all settings and data? This cannot be undone.')) return;

    AegisConfig.reset();
    localStorage.clear();
    window.location.reload();
  },

  /**
   * Open settings
   */
  openSettings(section = 'general') {
    this.navigate('settings');
    Settings.showSection(section);
  },

  /**
   * Format error for display
   */
  formatError(error) {
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    if (error.error) return error.error;
    return 'An unknown error occurred';
  }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  // Hide loading screen after short delay
  setTimeout(() => {
    AegisApp.init();
  }, 500);
});

// Handle hash navigation
window.addEventListener('hashchange', () => {
  const section = window.location.hash.slice(1);
  if (section) {
    AegisApp.navigate(section);
  }
});

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AegisApp;
}
