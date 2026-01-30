/**
 * AEGIS-T2A Setup Wizard
 *
 * Guides users through initial configuration.
 */

// Global state
let currentWizardStep = 1;
const totalWizardSteps = 5;
let selectedProvider = 'ollama';

/**
 * Initialize the wizard
 */
function initWizard() {
  bindWizardEvents();
  loadSavedWizardConfig();
  showWizardStep(1);
  updateWizardProgress();
  loadModelsForProvider(selectedProvider);
}

/**
 * Bind event handlers
 */
function bindWizardEvents() {
  // Provider selection cards
  document.querySelectorAll('.provider-card').forEach(card => {
    card.addEventListener('click', () => {
      selectLLMProvider(card.dataset.provider);
    });
  });

  // Cloud provider toggles
  ['aws', 'azure', 'gcp', 'onprem'].forEach(provider => {
    const toggle = document.getElementById(`${provider}-enabled`);
    if (toggle) {
      toggle.addEventListener('change', (e) => {
        const config = document.getElementById(`${provider}-config`);
        if (config) {
          config.style.display = e.target.checked ? 'block' : 'none';
        }
      });
    }
  });

  // Channel toggles
  ['telegram', 'whatsapp', 'slack'].forEach(channel => {
    const toggle = document.getElementById(`${channel}-enabled`);
    if (toggle) {
      toggle.addEventListener('change', (e) => {
        const config = document.getElementById(`${channel}-config`);
        if (config) {
          config.style.display = e.target.checked ? 'block' : 'none';
        }
      });
    }
  });

  // On-prem tabs
  document.querySelectorAll('.onprem-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.onprem-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.onprem-content').forEach(c => c.classList.add('hidden'));
      tab.classList.add('active');
      const content = document.getElementById(`onprem-${tab.dataset.tab}`);
      if (content) content.classList.remove('hidden');
    });
  });

  // Intent input enter key
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
 * Show a specific step
 */
function showWizardStep(stepNum) {
  // Hide all steps
  document.querySelectorAll('.wizard-step').forEach(step => {
    step.classList.remove('active');
  });

  // Show target step
  const targetStep = document.getElementById(`wizard-step-${stepNum}`);
  if (targetStep) {
    targetStep.classList.add('active');
    currentWizardStep = stepNum;
    updateWizardProgress();
    updateWizardNavButtons();

    // Run validation if on validation step
    if (stepNum === 4) {
      runValidation();
    }
  }
}

/**
 * Go to next step
 */
function wizardNext() {
  // Save current step config
  saveWizardStepConfig();

  // Move to next step
  if (currentWizardStep < totalWizardSteps) {
    showWizardStep(currentWizardStep + 1);
  }
}

/**
 * Go to previous step
 */
function wizardPrev() {
  if (currentWizardStep > 1) {
    showWizardStep(currentWizardStep - 1);
  }
}

/**
 * Skip wizard and go to main app
 */
function skipWizard() {
  // Set default provider to ollama (no API key needed)
  AegisConfig.setValue('llm.provider', 'ollama');
  AegisConfig.setValue('llm.ollama.baseUrl', 'http://localhost:11434');
  AegisConfig.markSetupComplete();

  // Hide wizard and show app
  document.getElementById('setup-wizard').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Initialize main app
  initMainApp();

  Toast.info('Setup skipped. You can configure settings anytime from the Settings page.');
}

/**
 * Finish wizard
 */
function wizardFinish() {
  // Save final configuration
  saveWizardStepConfig();

  // Mark setup as complete
  AegisConfig.markSetupComplete();

  // Hide wizard and show app
  document.getElementById('setup-wizard').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Initialize main application
  initMainApp();

  Toast.success('Setup complete! Welcome to AEGIS-T2A.');
}

/**
 * Update progress indicator
 */
function updateWizardProgress() {
  const progressFill = document.getElementById('wizard-progress-fill');
  if (progressFill) {
    const percentage = ((currentWizardStep - 1) / (totalWizardSteps - 1)) * 100;
    progressFill.style.width = `${percentage}%`;
  }

  // Update step indicators
  document.querySelectorAll('.progress-step').forEach((step) => {
    const stepNum = parseInt(step.dataset.step);
    step.classList.remove('active', 'completed');
    if (stepNum === currentWizardStep) {
      step.classList.add('active');
    } else if (stepNum < currentWizardStep) {
      step.classList.add('completed');
    }
  });
}

/**
 * Update navigation buttons
 */
function updateWizardNavButtons() {
  const prevBtn = document.getElementById('wizard-prev');
  const nextBtn = document.getElementById('wizard-next');
  const finishBtn = document.getElementById('wizard-finish');

  if (prevBtn) {
    prevBtn.disabled = currentWizardStep === 1;
    prevBtn.style.visibility = currentWizardStep === 1 ? 'hidden' : 'visible';
  }

  if (nextBtn) {
    nextBtn.style.display = currentWizardStep === totalWizardSteps ? 'none' : 'inline-flex';
  }

  if (finishBtn) {
    finishBtn.style.display = currentWizardStep === totalWizardSteps ? 'inline-flex' : 'none';
  }
}

/**
 * Select LLM provider
 */
function selectLLMProvider(provider) {
  selectedProvider = provider;

  // Update selection visual
  document.querySelectorAll('.provider-card').forEach(c => {
    c.classList.remove('selected');
  });
  const card = document.querySelector(`.provider-card[data-provider="${provider}"]`);
  if (card) card.classList.add('selected');

  // Show/hide API key section
  const apiKeySection = document.getElementById('api-key-section');
  const apiKeyGroup = document.querySelector('#api-key-section .form-group:first-child');
  const ollamaUrlGroup = document.getElementById('ollama-url-group');
  const apiKeyLabel = document.getElementById('api-key-label');
  const apiKeyHelp = document.getElementById('api-key-help');

  if (apiKeySection) {
    apiKeySection.style.display = 'block';
  }

  if (provider === 'ollama') {
    if (apiKeyGroup) apiKeyGroup.style.display = 'none';
    if (ollamaUrlGroup) ollamaUrlGroup.style.display = 'block';
    if (apiKeyHelp) apiKeyHelp.textContent = 'Ollama runs locally - no API key needed';
  } else {
    if (apiKeyGroup) apiKeyGroup.style.display = 'block';
    if (ollamaUrlGroup) ollamaUrlGroup.style.display = 'none';

    const labels = {
      anthropic: 'Anthropic API Key',
      openai: 'OpenAI API Key',
      openrouter: 'OpenRouter API Key'
    };
    if (apiKeyLabel) apiKeyLabel.textContent = labels[provider] || 'API Key';
    if (apiKeyHelp) apiKeyHelp.textContent = 'Your API key is stored locally and never shared';
  }

  // Load models for the selected provider
  loadModelsForProvider(provider);

  // Save selection
  AegisConfig.setValue('llm.provider', provider);
}

/**
 * Load models for a provider
 */
async function loadModelsForProvider(provider) {
  const modelSelect = document.getElementById('llm-model');
  if (!modelSelect) return;

  modelSelect.innerHTML = '<option value="">Loading models...</option>';

  try {
    if (provider === 'ollama') {
      // Try to load from Ollama server
      const ollamaUrl = document.getElementById('ollama-url')?.value || 'http://localhost:11434';
      try {
        const response = await fetch(`${ollamaUrl}/api/tags`);
        if (response.ok) {
          const data = await response.json();
          const models = data.models || [];
          if (models.length > 0) {
            modelSelect.innerHTML = models.map(m =>
              `<option value="${m.name}">${m.name}</option>`
            ).join('');
          } else {
            modelSelect.innerHTML = `
              <option value="llama2">llama2 (pull with: ollama pull llama2)</option>
              <option value="mistral">mistral</option>
              <option value="codellama">codellama</option>
            `;
          }
        } else {
          throw new Error('Ollama not running');
        }
      } catch (e) {
        modelSelect.innerHTML = `
          <option value="llama2">llama2</option>
          <option value="mistral">mistral</option>
          <option value="codellama">codellama</option>
          <option value="llama3">llama3</option>
        `;
      }
    } else {
      // Use predefined models
      const modelsByProvider = {
        anthropic: [
          { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (Latest)' },
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
          { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
          { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku (Fast)' },
        ],
        openai: [
          { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'gpt-4o', name: 'GPT-4o' },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast)' },
          { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
        ],
        openrouter: [
          { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'google/gemini-pro', name: 'Gemini Pro' },
          { id: 'meta-llama/llama-3-70b-instruct', name: 'Llama 3 70B' },
          { id: 'mistralai/mixtral-8x7b-instruct', name: 'Mixtral 8x7B' },
        ],
      };

      const models = modelsByProvider[provider] || [];
      modelSelect.innerHTML = models.map(m =>
        `<option value="${m.id}">${m.name}</option>`
      ).join('');
    }
  } catch (error) {
    console.error('Failed to load models:', error);
    modelSelect.innerHTML = '<option value="">Failed to load models</option>';
  }
}

/**
 * Toggle password visibility
 */
function togglePassword(inputId) {
  const input = document.getElementById(inputId);
  if (input) {
    input.type = input.type === 'password' ? 'text' : 'password';
    const icon = input.parentElement.querySelector('.toggle-password i');
    if (icon) {
      icon.className = input.type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
    }
  }
}

/**
 * Save current step configuration
 */
function saveWizardStepConfig() {
  // Step 1: LLM Provider
  if (currentWizardStep === 1) {
    const apiKey = document.getElementById('llm-api-key')?.value;
    const model = document.getElementById('llm-model')?.value;
    const ollamaUrl = document.getElementById('ollama-url')?.value;

    AegisConfig.setValue('llm.provider', selectedProvider);

    if (selectedProvider === 'ollama') {
      AegisConfig.setValue('llm.ollama.baseUrl', ollamaUrl || 'http://localhost:11434');
      AegisConfig.setValue('llm.ollama.model', model);
    } else {
      AegisConfig.setValue(`llm.${selectedProvider}.apiKey`, apiKey);
      AegisConfig.setValue(`llm.${selectedProvider}.model`, model);
    }
  }

  // Step 2: Cloud providers
  if (currentWizardStep === 2) {
    ['aws', 'azure', 'gcp', 'onprem'].forEach(provider => {
      const enabled = document.getElementById(`${provider}-enabled`)?.checked;
      AegisConfig.setValue(`cloud.${provider}.enabled`, enabled || false);
    });
  }

  // Step 3: Channels
  if (currentWizardStep === 3) {
    ['telegram', 'whatsapp', 'slack'].forEach(channel => {
      const enabled = document.getElementById(`${channel}-enabled`)?.checked;
      AegisConfig.setValue(`channels.${channel}.enabled`, enabled || false);
    });
  }
}

/**
 * Load saved configuration into form fields
 */
function loadSavedWizardConfig() {
  const config = AegisConfig.get();

  // Load LLM provider
  const provider = config.llm?.provider || 'ollama';
  selectLLMProvider(provider);

  // Load API key if present
  if (provider !== 'ollama' && config.llm?.[provider]?.apiKey) {
    const apiKeyInput = document.getElementById('llm-api-key');
    if (apiKeyInput) apiKeyInput.value = config.llm[provider].apiKey;
  }

  // Load Ollama URL
  if (config.llm?.ollama?.baseUrl) {
    const ollamaUrl = document.getElementById('ollama-url');
    if (ollamaUrl) ollamaUrl.value = config.llm.ollama.baseUrl;
  }
}

/**
 * Run validation on step 4
 */
async function runValidation() {
  const validationList = document.getElementById('validation-list');
  if (!validationList) return;

  validationList.innerHTML = '';

  const config = AegisConfig.get();
  const provider = config.llm?.provider || 'ollama';

  // Add validation items
  const items = [
    { name: `LLM Provider (${provider})`, id: 'llm' }
  ];

  // Add enabled cloud providers
  if (config.cloud?.aws?.enabled) items.push({ name: 'AWS', id: 'aws' });
  if (config.cloud?.azure?.enabled) items.push({ name: 'Azure', id: 'azure' });
  if (config.cloud?.gcp?.enabled) items.push({ name: 'Google Cloud', id: 'gcp' });
  if (config.cloud?.onprem?.enabled) items.push({ name: 'On-Premises', id: 'onprem' });

  // Add enabled channels
  if (config.channels?.telegram?.enabled) items.push({ name: 'Telegram', id: 'telegram' });
  if (config.channels?.whatsapp?.enabled) items.push({ name: 'WhatsApp', id: 'whatsapp' });
  if (config.channels?.slack?.enabled) items.push({ name: 'Slack', id: 'slack' });

  // Render validation items
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'validation-item';
    div.id = `validation-${item.id}`;
    div.innerHTML = `
      <div class="icon pending"><i class="fas fa-circle"></i></div>
      <div class="content">
        <h4>${item.name}</h4>
        <p>Waiting...</p>
      </div>
    `;
    validationList.appendChild(div);
  });

  // Run validations
  for (const item of items) {
    await validateItem(item);
  }

  // Show summary
  const allPassed = document.querySelectorAll('.validation-item .icon.error').length === 0;
  const summary = document.getElementById('validation-summary');
  if (summary) {
    summary.style.display = 'block';
    summary.innerHTML = allPassed ? `
      <div class="summary-icon success"><i class="fas fa-check-circle"></i></div>
      <h3>All validations passed!</h3>
      <p>Your AEGIS-T2A instance is ready to use</p>
    ` : `
      <div class="summary-icon warning"><i class="fas fa-exclamation-circle"></i></div>
      <h3>Some validations failed</h3>
      <p>You can still proceed, but some features may not work correctly</p>
    `;
  }
}

/**
 * Validate a single item
 */
async function validateItem(item) {
  const el = document.getElementById(`validation-${item.id}`);
  if (!el) return;

  const icon = el.querySelector('.icon');
  const content = el.querySelector('.content p');

  icon.className = 'icon checking';
  icon.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  content.textContent = 'Checking...';

  try {
    let success = false;
    let message = '';

    if (item.id === 'llm') {
      const config = AegisConfig.get();
      const provider = config.llm?.provider || 'ollama';

      if (provider === 'ollama') {
        try {
          const ollamaUrl = config.llm?.ollama?.baseUrl || 'http://localhost:11434';
          const response = await fetch(`${ollamaUrl}/api/tags`, {
            signal: AbortSignal.timeout(5000)
          });
          success = response.ok;
          message = success ? 'Connected to Ollama' : 'Cannot connect to Ollama';
        } catch (e) {
          success = false;
          message = 'Ollama not running - start with: ollama serve';
        }
      } else {
        const apiKey = config.llm?.[provider]?.apiKey;
        success = !!apiKey;
        message = success ? 'API key configured' : 'No API key provided';
      }
    } else {
      // For other providers, just check if configured
      success = true;
      message = 'Configured';
    }

    icon.className = success ? 'icon success' : 'icon error';
    icon.innerHTML = success ? '<i class="fas fa-check"></i>' : '<i class="fas fa-times"></i>';
    content.textContent = message;
  } catch (error) {
    icon.className = 'icon error';
    icon.innerHTML = '<i class="fas fa-times"></i>';
    content.textContent = error.message;
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // The wizard will be initialized by app.js if needed
});

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { initWizard, wizardNext, wizardPrev, wizardFinish, skipWizard };
}
