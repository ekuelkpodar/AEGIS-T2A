/**
 * AEGIS-T2A Main Application
 *
 * Initializes and coordinates all frontend components.
 */

let appInitialized = false;

/**
 * Initialize the application
 */
function initApp() {
  if (appInitialized) return;

  console.log('Initializing AEGIS-T2A...');

  // Initialize configuration
  AegisConfig.init();

  // Initialize API client
  AegisAPI.init();

  // Set up theme
  initTheme();

  // Check if setup is needed
  if (!AegisConfig.isSetupComplete()) {
    showSetupWizard();
  } else {
    showMainApp();
  }

  // Initialize toast notifications
  Toast.init();

  appInitialized = true;
  console.log('AEGIS-T2A initialized');
}

/**
 * Show setup wizard
 */
function showSetupWizard() {
  document.getElementById('loading-screen')?.classList.add('hidden');
  document.getElementById('setup-wizard')?.classList.remove('hidden');
  document.getElementById('app')?.classList.add('hidden');

  // Initialize wizard
  initWizard();
}

/**
 * Show main application
 */
function showMainApp() {
  document.getElementById('loading-screen')?.classList.add('hidden');
  document.getElementById('setup-wizard')?.classList.add('hidden');
  document.getElementById('app')?.classList.remove('hidden');

  // Initialize main app components
  initMainApp();
}

/**
 * Initialize main application after wizard
 */
function initMainApp() {
  // Bind navigation
  bindNavigation();

  // Bind intent input
  bindIntentInput();

  // Bind settings page controls
  bindSettingsControls();

  // Load initial data
  loadDashboardData();

  // Check server connection
  checkServerConnection();

  // Show dashboard by default
  navigateTo('dashboard');
}

/**
 * Initialize theme
 */
function initTheme() {
  const theme = AegisConfig.getValue('general.theme') || 'system';
  const root = document.documentElement;

  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (AegisConfig.getValue('general.theme') === 'system') {
        root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      }
    });
  } else {
    root.setAttribute('data-theme', theme);
  }
}

/**
 * Bind navigation events
 */
function bindNavigation() {
  document.querySelectorAll('.nav-item').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const page = link.dataset.page;
      if (page) navigateTo(page);
    });
  });

  // Settings navigation
  document.querySelectorAll('.settings-nav-item').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const section = link.dataset.section;
      if (section) showSettingsSection(section);
    });
  });

  // Integrations tabs
  document.querySelectorAll('.integrations-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab) showIntegrationsTab(tab);
    });
  });

  // Settings page tabs
  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.settingsTab;
      if (tab) showSettingsTab(tab);
    });
  });
}

/**
 * Navigate to a page
 */
function navigateTo(page) {
  // Update navigation state
  document.querySelectorAll('.nav-item').forEach(link => {
    link.classList.toggle('active', link.dataset.page === page);
  });

  // Show page
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === `page-${page}`);
  });

  // Load page-specific data
  if (page === 'dashboard') loadDashboardData();
  if (page === 'audit') loadAuditData();
  if (page === 'settings') loadSettingsData();
  if (page === 'integrations') loadIntegrationsData();
}

/**
 * Show settings section
 */
function showSettingsSection(section) {
  document.querySelectorAll('.settings-nav-item').forEach(link => {
    link.classList.toggle('active', link.dataset.section === section);
  });

  document.querySelectorAll('.settings-section').forEach(s => {
    s.classList.toggle('active', s.id === `settings-${section}`);
  });
}

/**
 * Show integrations tab
 */
function showIntegrationsTab(tab) {
  document.querySelectorAll('.integrations-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tab}`);
  });
}

/**
 * Show settings tab (for main app settings page)
 */
function showSettingsTab(tab) {
  // Update tab buttons
  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.settingsTab === tab);
  });

  // Update settings panels
  document.querySelectorAll('.settings-content > .settings-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `settings-panel-${tab}`);
  });
}

/**
 * Bind intent input
 */
function bindIntentInput() {
  const intentInput = document.getElementById('intent-input');
  if (intentInput) {
    intentInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        submitIntent();
      }
    });
  }
}

/**
 * Bind settings page controls
 */
function bindSettingsControls() {
  // Cloud provider toggles
  const cloudToggles = [
    { id: 'settings-aws-enabled', configId: 'settings-aws-config' },
    { id: 'settings-azure-enabled', configId: 'settings-azure-config' },
    { id: 'settings-gcp-enabled', configId: 'settings-gcp-config' },
    { id: 'settings-local-enabled', configId: 'settings-local-config' }
  ];

  cloudToggles.forEach(({ id, configId }) => {
    const toggle = document.getElementById(id);
    const config = document.getElementById(configId);
    if (toggle && config) {
      toggle.addEventListener('change', () => {
        config.style.display = toggle.checked ? 'block' : 'none';
      });
      // Initialize state
      config.style.display = toggle.checked ? 'block' : 'none';
    }
  });

  // Channel toggles
  const channelToggles = [
    { id: 'settings-telegram-enabled', configId: 'settings-telegram-config' },
    { id: 'settings-slack-enabled', configId: 'settings-slack-config' }
  ];

  channelToggles.forEach(({ id, configId }) => {
    const toggle = document.getElementById(id);
    const config = document.getElementById(configId);
    if (toggle && config) {
      toggle.addEventListener('change', () => {
        config.style.display = toggle.checked ? 'block' : 'none';
      });
      // Initialize state
      config.style.display = toggle.checked ? 'block' : 'none';
    }
  });

  // Provider card selection
  document.querySelectorAll('.settings-provider-card').forEach(card => {
    card.addEventListener('click', () => {
      const provider = card.dataset.settingsProvider;
      if (provider) {
        // Update selection
        document.querySelectorAll('.settings-provider-card').forEach(c => {
          c.classList.remove('selected');
        });
        card.classList.add('selected');

        // Show/hide provider-specific fields
        const apiKeyGroup = document.getElementById('settings-api-key-group');
        const ollamaUrlGroup = document.getElementById('settings-ollama-url-group');

        if (provider === 'ollama') {
          apiKeyGroup.style.display = 'none';
          ollamaUrlGroup.style.display = 'block';
        } else {
          apiKeyGroup.style.display = 'block';
          ollamaUrlGroup.style.display = 'block';
        }

        updateLLMSettings(provider);
      }
    });
  });

  // Save buttons
  const saveButtons = [
    'save-llm-btn',
    'save-cloud-btn',
    'save-channels-btn'
  ];

  saveButtons.forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener('click', () => {
        Toast.success('Settings saved successfully');
        // TODO: Actually save settings to server
      });
    }
  });

  // Test LLM button
  const testLlmBtn = document.getElementById('test-llm-btn');
  if (testLlmBtn) {
    testLlmBtn.addEventListener('click', async () => {
      testLlmBtn.disabled = true;
      testLlmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';

      await testLLMConnection();

      testLlmBtn.innerHTML = '<i class="fas fa-vial"></i> Test Connection';
      testLlmBtn.disabled = false;
    });
  }

  const testSaveDefaultBtn = document.getElementById('test-save-default-btn');
  if (testSaveDefaultBtn) {
    testSaveDefaultBtn.addEventListener('click', async () => {
      testSaveDefaultBtn.disabled = true;
      testSaveDefaultBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running...';
      await testSaveSetDefault();
      testSaveDefaultBtn.innerHTML = '<i class="fas fa-bolt"></i> Test + Save + Default';
      testSaveDefaultBtn.disabled = false;
    });
  }

  const modelSelect = document.getElementById('settings-llm-model');
  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      const provider = getSelectedSettingsProvider();
      const modelId = modelSelect.value;
      const meta = getModelMeta(provider, modelId);
      updateModelDetails(provider, modelId);
      setRecentModel(provider, modelId, meta?.name || modelId);
    });
  }

  document.getElementById('settings-set-default')?.addEventListener('click', () => {
    setProjectDefault();
    const statusEl = document.getElementById('settings-inline-status');
    if (statusEl) {
      statusEl.textContent = 'Set project default.';
      statusEl.className = 'inline-status success';
    }
  });

  document.getElementById('settings-toggle-favorite')?.addEventListener('click', () => {
    const provider = getSelectedSettingsProvider();
    const modelId = document.getElementById('settings-llm-model')?.value;
    const meta = getModelMeta(provider, modelId);
    toggleFavoriteModel(provider, modelId, meta?.name || modelId);
  });

  document.getElementById('settings-project-name')?.addEventListener('input', () => {
    updateProjectDefaultDisplay();
  });

  // Danger zone buttons
  const rerunWizardBtn = document.getElementById('rerun-wizard-btn');
  if (rerunWizardBtn) {
    rerunWizardBtn.addEventListener('click', () => {
      if (confirm('This will restart the setup wizard. Continue?')) {
        AegisConfig.clear();
        location.reload();
      }
    });
  }

  const clearDataBtn = document.getElementById('clear-data-btn');
  if (clearDataBtn) {
    clearDataBtn.addEventListener('click', () => {
      if (confirm('This will permanently delete all data. This action cannot be undone. Are you sure?')) {
        AegisConfig.clear();
        localStorage.clear();
        Toast.success('All data cleared');
        setTimeout(() => location.reload(), 1000);
      }
    });
  }
}

/**
 * Submit intent from input
 */
async function submitIntent() {
  const intentInput = document.getElementById('intent-input');
  if (!intentInput) return;

  const text = intentInput.value.trim();
  if (!text) {
    Toast.warning('Please enter what you want to do');
    return;
  }

  // Show loading state
  intentInput.disabled = true;
  const submitBtn = intentInput.parentElement.querySelector('button');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  }

  try {
    // Check if this is an app building request
    if (isAppBuildingRequest(text)) {
      await handleAppBuildingRequest(text);
    } else {
      // Regular intent processing
      const result = await AegisAPI.createIntent(text);

      if (result.success) {
        Toast.success('Intent created! Generating plan...');
        intentInput.value = '';

        // Navigate to intents page or show plan
        if (result.intent) {
          showIntentDetails(result.intent);
        }
      } else {
        Toast.error(result.error || 'Failed to create intent');
      }
    }
  } catch (error) {
    console.error('Intent submission failed:', error);
    Toast.error(error.message || 'Failed to process your request');
  } finally {
    intentInput.disabled = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
    }
  }
}

/**
 * Check if request is for building an app
 */
function isAppBuildingRequest(text) {
  const buildKeywords = [
    'build', 'create', 'make', 'generate', 'scaffold',
    'crud', 'landing page', 'website', 'web app', 'application',
    'api', 'backend', 'frontend', 'full stack'
  ];
  const lowerText = text.toLowerCase();
  return buildKeywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Handle app building request
 */
async function handleAppBuildingRequest(text) {
  // Show build modal
  showBuildModal(text);
}

/**
 * Show build modal
 */
function showBuildModal(request) {
  const modal = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalFooter = document.getElementById('modal-footer');

  if (!modal || !modalBody) return;

  modalTitle.textContent = 'Building Your Application';
  modalBody.innerHTML = `
    <div class="build-modal">
      <div class="build-request">
        <i class="fas fa-quote-left"></i>
        <p>${escapeHtml(request)}</p>
      </div>

      <div class="build-options">
        <h4>Build Configuration</h4>

        <div class="form-group">
          <label>Project Name</label>
          <input type="text" id="build-project-name" placeholder="my-awesome-app" value="${generateProjectName(request)}">
        </div>

        <div class="form-group">
          <label>Project Type</label>
          <select id="build-project-type">
            <option value="crud">CRUD Application</option>
            <option value="landing">Landing Page</option>
            <option value="api">REST API</option>
            <option value="fullstack">Full Stack App</option>
          </select>
        </div>

        <div class="form-group">
          <label>Technology Stack</label>
          <select id="build-stack">
            <option value="node-express">Node.js + Express</option>
            <option value="python-flask">Python + Flask</option>
            <option value="python-fastapi">Python + FastAPI</option>
            <option value="static-html">Static HTML/CSS/JS</option>
          </select>
        </div>

        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" id="build-use-docker" checked>
            <span>Build with Docker</span>
          </label>
        </div>

        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" id="build-auto-run" checked>
            <span>Run automatically after build</span>
          </label>
        </div>
      </div>

      <div class="build-status" id="build-status" style="display: none;">
        <div class="build-progress">
          <div class="progress-bar">
            <div class="progress-fill" id="build-progress-fill"></div>
          </div>
          <p id="build-status-text">Initializing...</p>
        </div>
        <div class="build-logs" id="build-logs"></div>
      </div>
    </div>
  `;

  modalFooter.innerHTML = `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" id="start-build-btn" onclick="startBuild('${escapeHtml(request).replace(/'/g, "\\'")}')">
      <i class="fas fa-hammer"></i> Start Build
    </button>
  `;

  modal.classList.add('active');
}

/**
 * Generate project name from request
 */
function generateProjectName(request) {
  const words = request.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['build', 'create', 'make', 'please', 'want', 'need', 'the', 'for', 'with'].includes(w))
    .slice(0, 2);
  return words.join('-') || 'my-app';
}

/**
 * Start the build process
 */
async function startBuild(request) {
  const projectName = document.getElementById('build-project-name')?.value || 'my-app';
  const projectType = document.getElementById('build-project-type')?.value || 'crud';
  const stack = document.getElementById('build-stack')?.value || 'node-express';
  const useDocker = document.getElementById('build-use-docker')?.checked ?? true;
  const autoRun = document.getElementById('build-auto-run')?.checked ?? true;

  // Hide options, show status
  const buildOptions = document.querySelector('.build-options');
  if (buildOptions) buildOptions.style.display = 'none';
  document.getElementById('build-status').style.display = 'block';
  const startBtn = document.getElementById('start-build-btn');
  if (startBtn) startBtn.style.display = 'none';

  const statusText = document.getElementById('build-status-text');
  const progressFill = document.getElementById('build-progress-fill');
  const logsContainer = document.getElementById('build-logs');

  const updateStatus = (text, progress) => {
    if (statusText) statusText.textContent = text;
    if (progressFill) progressFill.style.width = `${progress}%`;
    if (logsContainer) {
      const logEntry = document.createElement('div');
      logEntry.className = 'log-entry';
      logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
      logsContainer.appendChild(logEntry);
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }
  };

  // Map stack to framework
  const frameworkMap = {
    'node-express': 'express',
    'python-flask': 'express',
    'python-fastapi': 'fastapi',
    'static-html': 'react'
  };

  try {
    updateStatus('Creating project structure...', 10);
    await sleep(500);

    updateStatus(`Generating ${projectType} code with LLM...`, 20);

    // Call the build API with correct schema
    const buildResult = await AegisAPI.startBuild({
      type: projectType,
      name: projectName,
      description: request,
      options: {
        framework: frameworkMap[stack] || 'express',
        database: 'none',
        styling: 'tailwind'
      }
    });

    if (buildResult.success && buildResult.buildId) {
      updateStatus('Build started, generating code...', 30);

      // Poll for build status
      let build = null;
      let attempts = 0;
      const maxAttempts = 60; // 60 seconds max

      while (attempts < maxAttempts) {
        await sleep(1000);
        attempts++;

        try {
          const statusResponse = await AegisAPI.getBuild(buildResult.buildId);
          build = statusResponse.build;

          if (build) {
            updateStatus(build.logs[build.logs.length - 1] || 'Processing...', build.progress);

            if (build.status === 'completed') {
              break;
            } else if (build.status === 'failed') {
              throw new Error(build.error || 'Build failed');
            }
          }
        } catch (e) {
          console.log('Polling error:', e);
        }
      }

      if (build && build.status === 'completed') {
        updateStatus('Build complete!', 100);

        // Show success message with link
        if (build.url) {
          logsContainer.innerHTML += `
            <div class="log-entry success">
              ✅ Application ready at <a href="${build.url}" target="_blank">${build.url}</a>
            </div>
          `;

          // Update footer
          const modalFooter = document.getElementById('modal-footer');
          modalFooter.innerHTML = `
            <button class="btn btn-secondary" onclick="closeModal()">Close</button>
            <a class="btn btn-success" href="${build.url}" target="_blank">
              <i class="fas fa-external-link-alt"></i> Open Application
            </a>
          `;
        } else {
          logsContainer.innerHTML += `
            <div class="log-entry success">
              ✅ Build complete! Files are in the builds directory.
            </div>
          `;
        }

        Toast.success('Application built successfully!');
      } else {
        throw new Error('Build timed out');
      }
    } else {
      throw new Error(buildResult.error || 'Failed to start build');
    }
  } catch (error) {
    updateStatus(`Error: ${error.message}`, 0);
    if (logsContainer) {
      logsContainer.innerHTML += `
        <div class="log-entry error">❌ ${error.message}</div>
      `;
    }
    Toast.error('Build failed: ' + error.message);

    // Re-enable modal footer
    const modalFooter = document.getElementById('modal-footer');
    if (modalFooter) {
      modalFooter.innerHTML = `
        <button class="btn btn-secondary" onclick="closeModal()">Close</button>
      `;
    }
  }
}

// Make startBuild globally accessible
window.startBuild = startBuild;

/**
 * Close modal
 */
function closeModal() {
  const modal = document.getElementById('modal-overlay');
  if (modal) modal.classList.remove('active');
}

/**
 * Show intent details
 */
function showIntentDetails(intent) {
  // Navigate to intents page and show details
  navigateTo('intents');
  // TODO: Show specific intent details
}

/**
 * Load dashboard data
 */
async function loadDashboardData() {
  try {
    // Load stats
    const [health, auditEvents] = await Promise.all([
      AegisAPI.healthCheck().catch(() => null),
      AegisAPI.getAuditEvents({ limit: 10 }).catch(() => ({ events: [] }))
    ]);

    // Update stats
    if (auditEvents.events) {
      const events = auditEvents.events;
      document.getElementById('stat-intents').textContent = events.filter(e => e.eventType?.includes('INTENT')).length;
      document.getElementById('stat-completed').textContent = events.filter(e => e.eventType?.includes('COMPLETED')).length;
      document.getElementById('stat-pending').textContent = events.filter(e => e.eventType?.includes('PENDING')).length;
      document.getElementById('stat-failed').textContent = events.filter(e => e.eventType?.includes('FAILED')).length;

      // Update recent activity
      updateRecentActivity(events);
    }

    // Update connection status
    updateConnectionStatus(!!health);
  } catch (error) {
    console.error('Failed to load dashboard data:', error);
  }
}

/**
 * Update recent activity list
 */
function updateRecentActivity(events) {
  const container = document.getElementById('recent-activity');
  if (!container || !events.length) return;

  container.innerHTML = events.slice(0, 5).map(event => `
    <div class="activity-item">
      <div class="activity-icon ${event.success ? 'success' : 'error'}">
        <i class="fas fa-${event.success ? 'check' : 'times'}"></i>
      </div>
      <div class="activity-content">
        <p>${event.action || event.eventType}</p>
        <small>${formatTimeAgo(event.timestamp)}</small>
      </div>
    </div>
  `).join('');
}

/**
 * Load audit data
 */
async function loadAuditData() {
  try {
    const result = await AegisAPI.getAuditEvents({ limit: 50 });
    const container = document.getElementById('audit-list');
    if (!container) return;

    if (!result.events || result.events.length === 0) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>No audit events yet</p></div>';
      return;
    }

    container.innerHTML = result.events.map(event => `
      <div class="audit-item">
        <div class="audit-icon ${event.success ? 'success' : 'error'}">
          <i class="fas fa-${event.success ? 'check-circle' : 'times-circle'}"></i>
        </div>
        <div class="audit-content">
          <div class="audit-header">
            <span class="audit-type">${event.eventType}</span>
            <span class="audit-time">${formatTimeAgo(event.timestamp)}</span>
          </div>
          <p class="audit-action">${event.action}</p>
          <p class="audit-actor">by ${event.actorId}</p>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load audit data:', error);
  }
}

/**
 * Load settings data
 */
async function loadSettingsData() {
  try {
    const settings = await AegisAPI.getSettings();
    const config = AegisConfig.get();

    const provider = settings.llm?.provider || config.llm?.provider || 'ollama';
    document.querySelectorAll('.settings-provider-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.settingsProvider === provider);
    });

    updateLLMSettings(provider);
    updateProjectDefaultDisplay();
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

/**
 * Update LLM settings UI based on selected provider
 */
function getSelectedSettingsProvider() {
  const selected = document.querySelector('.settings-provider-card.selected');
  return selected?.dataset.settingsProvider || 'ollama';
}

const LLM_PREFS_KEY = 'aegis-llm-preferences';
const modelMetaCache = {};

function getProjectKey() {
  const projectInput = document.getElementById('settings-project-name');
  const projectName = projectInput?.value?.trim();
  if (projectName) return projectName;
  return `${location.host}${location.pathname || '/'}`;
}

function loadLLMPreferences() {
  try {
    return JSON.parse(localStorage.getItem(LLM_PREFS_KEY)) || {
      favorites: [],
      recents: [],
      defaults: {},
    };
  } catch (error) {
    return { favorites: [], recents: [], defaults: {} };
  }
}

function saveLLMPreferences(prefs) {
  localStorage.setItem(LLM_PREFS_KEY, JSON.stringify(prefs));
}

function updateModelMeta(provider, models) {
  modelMetaCache[provider] = models;
}

function getModelMeta(provider, modelId) {
  const models = modelMetaCache[provider] || [];
  return models.find((model) => model.id === modelId);
}

function updateModelDetails(provider, modelId) {
  const meta = getModelMeta(provider, modelId);
  const contextEl = document.getElementById('settings-model-context');
  const pricingEl = document.getElementById('settings-model-pricing');
  const modalityEl = document.getElementById('settings-model-modality');
  if (!contextEl || !pricingEl || !modalityEl) return;

  contextEl.textContent = meta?.contextTokens ? `${meta.contextTokens.toLocaleString()} tokens` : '—';
  if (meta?.priceInputPerMTokens || meta?.priceOutputPerMTokens) {
    const input = meta?.priceInputPerMTokens ?? '—';
    const output = meta?.priceOutputPerMTokens ?? '—';
    pricingEl.textContent = `$${input} / $${output} per 1M`;
  } else {
    pricingEl.textContent = '—';
  }
  modalityEl.textContent = meta?.modality ? meta.modality : '—';
  updateFavoriteButton(provider, modelId);
}

function updateFavoritesRecentsUI(provider) {
  const prefs = loadLLMPreferences();
  const favoritesEl = document.getElementById('settings-model-favorites');
  const recentsEl = document.getElementById('settings-model-recents');
  if (!favoritesEl || !recentsEl) return;

  const favorites = prefs.favorites.filter(item => item.provider === provider);
  const recents = prefs.recents.filter(item => item.provider === provider);

  favoritesEl.innerHTML = favorites.length ? favorites.map((item) => `
    <span class="model-chip active" data-model="${item.model}" data-provider="${item.provider}">
      ${item.label || item.model}
    </span>
  `).join('') : '<span class="detail-label">None yet</span>';

  recentsEl.innerHTML = recents.length ? recents.map((item) => `
    <span class="model-chip" data-model="${item.model}" data-provider="${item.provider}">
      ${item.label || item.model}
    </span>
  `).join('') : '<span class="detail-label">None yet</span>';

  [...favoritesEl.querySelectorAll('.model-chip'), ...recentsEl.querySelectorAll('.model-chip')].forEach((chip) => {
    chip.addEventListener('click', () => {
      const model = chip.dataset.model;
      const providerId = chip.dataset.provider;
      if (!model || !providerId) return;
      selectModel(providerId, model);
    });
  });
}

function setRecentModel(provider, modelId, label) {
  const prefs = loadLLMPreferences();
  prefs.recents = prefs.recents.filter(item => !(item.provider === provider && item.model === modelId));
  prefs.recents.unshift({ provider, model: modelId, label });
  prefs.recents = prefs.recents.slice(0, 5);
  saveLLMPreferences(prefs);
  updateFavoritesRecentsUI(provider);
}

function toggleFavoriteModel(provider, modelId, label) {
  const prefs = loadLLMPreferences();
  const exists = prefs.favorites.find(item => item.provider === provider && item.model === modelId);
  if (exists) {
    prefs.favorites = prefs.favorites.filter(item => !(item.provider === provider && item.model === modelId));
  } else {
    prefs.favorites.push({ provider, model: modelId, label });
  }
  saveLLMPreferences(prefs);
  updateFavoritesRecentsUI(provider);
  updateFavoriteButton(provider, modelId);
}

function updateFavoriteButton(provider, modelId) {
  const button = document.getElementById('settings-toggle-favorite');
  if (!button) return;
  const prefs = loadLLMPreferences();
  const exists = prefs.favorites.find(item => item.provider === provider && item.model === modelId);
  button.innerHTML = exists
    ? '<i class="fas fa-star"></i> Favorited'
    : '<i class="far fa-star"></i> Favorite';
}

function updateProjectDefaultDisplay() {
  const prefs = loadLLMPreferences();
  const projectKey = getProjectKey();
  const display = document.getElementById('settings-project-default');
  if (!display) return;
  const entry = prefs.defaults[projectKey];
  display.textContent = entry ? `${entry.label || entry.model}` : '—';
}

function setProjectDefault() {
  const provider = getSelectedSettingsProvider();
  const model = document.getElementById('settings-llm-model')?.value;
  const meta = getModelMeta(provider, model);
  const prefs = loadLLMPreferences();
  prefs.defaults[getProjectKey()] = { provider, model, label: meta?.name || model };
  saveLLMPreferences(prefs);
  updateProjectDefaultDisplay();
}

function selectModel(provider, modelId) {
  document.querySelectorAll('.settings-provider-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.settingsProvider === provider);
  });
  updateLLMSettings(provider);
  const select = document.getElementById('settings-llm-model');
  if (select) {
    select.value = modelId;
  }
  const meta = getModelMeta(provider, modelId);
  updateModelDetails(provider, modelId);
  setRecentModel(provider, modelId, meta?.name || modelId);
}

function updateLLMSettings(providerOverride) {
  const provider = providerOverride || getSelectedSettingsProvider();
  const apiKeyGroup = document.getElementById('settings-api-key-group');
  const ollamaUrlGroup = document.getElementById('settings-ollama-url-group');
  const modelSelect = document.getElementById('settings-llm-model');
  const config = AegisConfig.get();
  const desiredModel = provider === 'ollama'
    ? config.llm?.ollama?.model
    : config.llm?.[provider]?.model;

  if (provider === 'ollama') {
    if (apiKeyGroup) apiKeyGroup.style.display = 'none';
    if (ollamaUrlGroup) ollamaUrlGroup.style.display = 'block';
  } else {
    if (apiKeyGroup) apiKeyGroup.style.display = 'block';
    if (ollamaUrlGroup) ollamaUrlGroup.style.display = 'none';
  }

  // Load models for provider
  if (modelSelect) {
    loadSettingsModels(provider, modelSelect, desiredModel);
  }

  updateFavoritesRecentsUI(provider);
}

/**
 * Load models for settings
 */
async function loadSettingsModels(provider, select, desiredModel) {
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    if (provider === 'ollama') {
      const discovery = await AegisAPI.getOllamaModels();
      const models = Array.isArray(discovery.models) ? discovery.models : [];
      updateModelMeta(provider, models.map((model) => ({ id: model, name: model })));
      select.innerHTML = models.map((model) => `<option value="${model}">${model}</option>`).join('');
      if (desiredModel && models.includes(desiredModel)) {
        select.value = desiredModel;
        updateModelDetails(provider, desiredModel);
      }
      return;
    }

    const data = await AegisAPI.getModelsForProvider(provider);
    const models = Array.isArray(data.models) ? data.models : [];
    updateModelMeta(provider, models);
    select.innerHTML = models.map(m => `<option value="${m.id}" title="${m.description || ''}">${m.name}</option>`).join('');
    if (desiredModel && models.some((model) => model.id === desiredModel)) {
      select.value = desiredModel;
      updateModelDetails(provider, desiredModel);
    } else if (models[0]?.id) {
      updateModelDetails(provider, models[0].id);
    }
  } catch (error) {
    console.warn('Failed to load models from API, using fallback list.', error);
    select.innerHTML = '<option value="">No models available</option>';
  }
}

/**
 * Load integrations data
 */
function loadIntegrationsData() {
  // Load cloud integrations
  const cloudContainer = document.getElementById('cloud-integrations');
  if (cloudContainer) {
    const config = AegisConfig.get();
    cloudContainer.innerHTML = `
      <div class="integration-card ${config.cloud?.aws?.enabled ? 'enabled' : ''}">
        <div class="integration-icon aws"><i class="fab fa-aws"></i></div>
        <div class="integration-info">
          <h3>Amazon Web Services</h3>
          <p>${config.cloud?.aws?.enabled ? 'Connected' : 'Not configured'}</p>
        </div>
        <button class="btn btn-sm btn-secondary" onclick="configureIntegration('aws')">Configure</button>
      </div>
      <div class="integration-card ${config.cloud?.azure?.enabled ? 'enabled' : ''}">
        <div class="integration-icon azure"><i class="fab fa-microsoft"></i></div>
        <div class="integration-info">
          <h3>Microsoft Azure</h3>
          <p>${config.cloud?.azure?.enabled ? 'Connected' : 'Not configured'}</p>
        </div>
        <button class="btn btn-sm btn-secondary" onclick="configureIntegration('azure')">Configure</button>
      </div>
      <div class="integration-card ${config.cloud?.gcp?.enabled ? 'enabled' : ''}">
        <div class="integration-icon gcp"><i class="fab fa-google"></i></div>
        <div class="integration-info">
          <h3>Google Cloud</h3>
          <p>${config.cloud?.gcp?.enabled ? 'Connected' : 'Not configured'}</p>
        </div>
        <button class="btn btn-sm btn-secondary" onclick="configureIntegration('gcp')">Configure</button>
      </div>
      <div class="integration-card ${config.cloud?.onprem?.enabled ? 'enabled' : ''}">
        <div class="integration-icon onprem"><i class="fas fa-server"></i></div>
        <div class="integration-info">
          <h3>Local / On-Premises</h3>
          <p>${config.cloud?.onprem?.enabled ? 'Connected' : 'Not configured'}</p>
        </div>
        <button class="btn btn-sm btn-secondary" onclick="configureIntegration('onprem')">Configure</button>
      </div>
    `;
  }
}

/**
 * Configure integration
 */
function configureIntegration(provider) {
  Toast.info(`Opening ${provider} configuration...`);
  // TODO: Open integration configuration modal
}

/**
 * Check server connection
 */
async function checkServerConnection() {
  try {
    await AegisAPI.healthCheck();
    updateConnectionStatus(true);
  } catch (error) {
    updateConnectionStatus(false);
  }
}

/**
 * Update connection status indicator
 */
function updateConnectionStatus(connected) {
  const statusDot = document.querySelector('.connection-status .status-dot');
  const statusText = document.querySelector('.connection-status span:last-child');

  if (statusDot) {
    statusDot.classList.toggle('connected', connected);
    statusDot.classList.toggle('disconnected', !connected);
  }
  if (statusText) {
    statusText.textContent = connected ? 'Connected' : 'Disconnected';
  }
}

/**
 * Save settings
 */
async function saveSettings() {
  const provider = getSelectedSettingsProvider();
  const apiKey = document.getElementById('settings-api-key')?.value;
  const model = document.getElementById('settings-llm-model')?.value;
  const ollamaUrl = document.getElementById('settings-ollama-url')?.value;

  // Save to local config
  AegisConfig.setValue('llm.provider', provider);
  if (provider === 'ollama') {
    AegisConfig.setValue('llm.ollama.baseUrl', ollamaUrl);
    AegisConfig.setValue('llm.ollama.model', model);
  } else {
    AegisConfig.setValue(`llm.${provider}.apiKey`, apiKey);
    AegisConfig.setValue(`llm.${provider}.model`, model);
  }

  const meta = getModelMeta(provider, model);
  setRecentModel(provider, model, meta?.name || model);

  Toast.success('Settings saved!');
}

/**
 * Discard settings changes
 */
function discardSettings() {
  loadSettingsData();
  Toast.info('Changes discarded');
}

/**
 * Reset settings to defaults
 */
function resetSettings() {
  if (confirm('Reset all settings to defaults? This cannot be undone.')) {
    AegisConfig.reset();
    loadSettingsData();
    Toast.success('Settings reset to defaults');
  }
}

/**
 * Clear all data
 */
function clearData() {
  if (confirm('Clear all data? This will remove all intents, workflows, and audit logs.')) {
    localStorage.clear();
    Toast.success('All data cleared');
    location.reload();
  }
}

/**
 * Test LLM connection from settings
 */
async function testLLMConnection() {
  const provider = getSelectedSettingsProvider();
  const apiKey = document.getElementById('settings-api-key')?.value;
  const ollamaUrl = document.getElementById('settings-ollama-url')?.value;
  const statusEl = document.getElementById('settings-inline-status');

  if (statusEl) {
    statusEl.textContent = 'Testing connection...';
    statusEl.className = 'inline-status pending';
  }

  try {
    const result = await AegisAPI.testLLMConnection(provider, apiKey, null, ollamaUrl);
    if (result.success) {
      if (statusEl) {
        statusEl.textContent = 'Connection successful.';
        statusEl.className = 'inline-status success';
      }
    } else {
      if (statusEl) {
        statusEl.textContent = 'Connection failed.';
        statusEl.className = 'inline-status error';
      }
    }
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = `Connection failed: ${error.message || 'unknown error'}`;
      statusEl.className = 'inline-status error';
    }
  }
}

async function testSaveSetDefault() {
  const statusEl = document.getElementById('settings-inline-status');
  if (statusEl) {
    statusEl.textContent = 'Testing, saving, and setting default...';
    statusEl.className = 'inline-status pending';
  }

  await testLLMConnection();
  await saveSettings();
  setProjectDefault();
}

/**
 * Show notifications
 */
function showNotifications() {
  Toast.info('No new notifications');
}

/**
 * Show help
 */
function showHelp() {
  const modal = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalFooter = document.getElementById('modal-footer');

  modalTitle.textContent = 'Help & Documentation';
  modalBody.innerHTML = `
    <div class="help-content">
      <h4>Quick Start</h4>
      <p>Type what you want to do in the command bar at the top. For example:</p>
      <ul>
        <li><code>Build me a CRUD app for managing tasks</code></li>
        <li><code>Create a landing page for my startup</code></li>
        <li><code>Deploy my-app to production</code></li>
      </ul>

      <h4>Keyboard Shortcuts</h4>
      <ul>
        <li><kbd>Ctrl</kbd> + <kbd>K</kbd> - Focus command bar</li>
        <li><kbd>Escape</kbd> - Close modal</li>
      </ul>

      <h4>Need More Help?</h4>
      <p>Visit the <a href="https://github.com/ekuelkpodar/AEGIS-T2A" target="_blank">documentation</a> for more information.</p>
    </div>
  `;
  modalFooter.innerHTML = '<button class="btn btn-primary" onclick="closeModal()">Got it</button>';

  modal.classList.add('active');
}

/**
 * Toggle user menu
 */
function toggleUserMenu() {
  Toast.info('User menu coming soon');
}

/**
 * Export audit log
 */
function exportAudit() {
  Toast.info('Exporting audit log...');
  // TODO: Implement audit export
}

// Utility functions

function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    initApp();
  }, 500);
});

// Handle keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + K - Focus intent input
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
    closeModal();
  }
});

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { initApp, initMainApp };
}
