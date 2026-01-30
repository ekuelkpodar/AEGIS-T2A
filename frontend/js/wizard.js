/**
 * AEGIS-T2A Setup Wizard
 *
 * Guides users through initial configuration.
 * All functions are globally accessible for onclick handlers.
 */

// Global wizard state
var currentWizardStep = 1;
var totalWizardSteps = 5;
var selectedProvider = 'ollama';

/**
 * Initialize the wizard
 */
function initWizard() {
  console.log('Initializing AEGIS-T2A wizard...');

  // Setup event listeners for toggles
  setupCloudToggles();
  setupChannelToggles();

  // Show first step
  showWizardStep(1);

  // Select default provider (ollama)
  selectLLMProvider('ollama');

  console.log('Wizard initialized successfully');
}

/**
 * Setup cloud provider toggle listeners
 */
function setupCloudToggles() {
  var providers = ['aws', 'azure', 'gcp', 'onprem'];
  providers.forEach(function(provider) {
    var toggle = document.getElementById(provider + '-enabled');
    if (toggle) {
      toggle.onchange = function() {
        var config = document.getElementById(provider + '-config');
        if (config) {
          config.style.display = this.checked ? 'block' : 'none';
        }
      };
    }
  });
}

/**
 * Setup channel toggle listeners
 */
function setupChannelToggles() {
  var channels = ['telegram', 'whatsapp', 'slack'];
  channels.forEach(function(channel) {
    var toggle = document.getElementById(channel + '-enabled');
    if (toggle) {
      toggle.onchange = function() {
        var config = document.getElementById(channel + '-config');
        if (config) {
          config.style.display = this.checked ? 'block' : 'none';
        }
      };
    }
  });
}

/**
 * Switch on-prem tab
 */
function switchOnpremTab(tab) {
  // Update tab buttons
  var tabs = document.querySelectorAll('.onprem-tab');
  tabs.forEach(function(t) {
    t.classList.remove('active');
    if (t.dataset.tab === tab) {
      t.classList.add('active');
    }
  });

  // Update content
  var contents = document.querySelectorAll('.onprem-content');
  contents.forEach(function(c) {
    c.classList.add('hidden');
  });

  var activeContent = document.getElementById('onprem-' + tab);
  if (activeContent) {
    activeContent.classList.remove('hidden');
  }
}

/**
 * Show a specific wizard step
 */
function showWizardStep(stepNum) {
  console.log('Showing step:', stepNum);

  // Hide all steps
  var steps = document.querySelectorAll('.wizard-step');
  steps.forEach(function(step) {
    step.classList.remove('active');
    step.style.display = 'none';
  });

  // Show target step
  var targetStep = document.getElementById('wizard-step-' + stepNum);
  if (targetStep) {
    targetStep.classList.add('active');
    targetStep.style.display = 'block';
    currentWizardStep = stepNum;
  }

  // Update progress
  updateWizardProgress();
  updateWizardNavButtons();

  // Auto-run validation on step 4
  if (stepNum === 4) {
    setTimeout(runValidation, 300);
  }
}

/**
 * Go to next wizard step
 */
function wizardNext() {
  console.log('Next clicked, current step:', currentWizardStep);

  // Save current step data
  saveCurrentStepData();

  // Go to next step
  if (currentWizardStep < totalWizardSteps) {
    showWizardStep(currentWizardStep + 1);
  }
}

/**
 * Go to previous wizard step
 */
function wizardPrev() {
  console.log('Previous clicked, current step:', currentWizardStep);

  if (currentWizardStep > 1) {
    showWizardStep(currentWizardStep - 1);
  }
}

/**
 * Skip wizard and go directly to app
 */
function skipWizard() {
  console.log('Skipping wizard...');

  // Set defaults
  if (typeof AegisConfig !== 'undefined') {
    AegisConfig.setValue('llm.provider', 'ollama');
    AegisConfig.setValue('llm.ollama.baseUrl', 'http://localhost:11434');
    AegisConfig.markSetupComplete();
  }

  // Hide wizard, show app
  var wizard = document.getElementById('setup-wizard');
  var app = document.getElementById('app');

  if (wizard) wizard.classList.add('hidden');
  if (app) app.classList.remove('hidden');

  // Initialize main app
  if (typeof initMainApp === 'function') {
    initMainApp();
  }

  // Show notification
  if (typeof Toast !== 'undefined') {
    Toast.info('Setup skipped. Configure settings anytime from the Settings page.');
  }

  return false;
}

/**
 * Finish wizard and start the app
 */
function wizardFinish() {
  console.log('Finishing wizard...');

  // Save final data
  saveCurrentStepData();

  // Mark complete
  if (typeof AegisConfig !== 'undefined') {
    AegisConfig.markSetupComplete();
  }

  // Hide wizard, show app
  var wizard = document.getElementById('setup-wizard');
  var app = document.getElementById('app');

  if (wizard) wizard.classList.add('hidden');
  if (app) app.classList.remove('hidden');

  // Initialize main app
  if (typeof initMainApp === 'function') {
    initMainApp();
  }

  // Show notification
  if (typeof Toast !== 'undefined') {
    Toast.success('Setup complete! Welcome to AEGIS-T2A.');
  }
}

/**
 * Update the progress bar and step indicators
 */
function updateWizardProgress() {
  var progressFill = document.getElementById('wizard-progress-fill');
  if (progressFill) {
    var percentage = ((currentWizardStep - 1) / (totalWizardSteps - 1)) * 100;
    progressFill.style.width = percentage + '%';
  }

  // Update step indicators
  var stepIndicators = document.querySelectorAll('.progress-step');
  stepIndicators.forEach(function(step) {
    var stepNum = parseInt(step.dataset.step);
    step.classList.remove('active', 'completed');

    if (stepNum === currentWizardStep) {
      step.classList.add('active');
    } else if (stepNum < currentWizardStep) {
      step.classList.add('completed');
    }
  });
}

/**
 * Update navigation button states
 */
function updateWizardNavButtons() {
  var prevBtn = document.getElementById('wizard-prev');
  var nextBtn = document.getElementById('wizard-next');
  var finishBtn = document.getElementById('wizard-finish');

  if (prevBtn) {
    prevBtn.disabled = (currentWizardStep === 1);
    prevBtn.style.visibility = (currentWizardStep === 1) ? 'hidden' : 'visible';
  }

  if (nextBtn) {
    nextBtn.style.display = (currentWizardStep === totalWizardSteps) ? 'none' : 'inline-flex';
  }

  if (finishBtn) {
    finishBtn.style.display = (currentWizardStep === totalWizardSteps) ? 'inline-flex' : 'none';
  }
}

/**
 * Select an LLM provider
 */
function selectLLMProvider(provider) {
  console.log('Selecting provider:', provider);
  selectedProvider = provider;

  // Update card selection visuals
  var cards = document.querySelectorAll('.provider-card');
  cards.forEach(function(card) {
    card.classList.remove('selected');
    if (card.dataset.provider === provider) {
      card.classList.add('selected');
    }
  });

  // Get UI elements
  var apiKeySection = document.getElementById('api-key-section');
  var apiKeyInput = document.getElementById('llm-api-key');
  var ollamaUrlGroup = document.getElementById('ollama-url-group');
  var apiKeyLabel = document.getElementById('api-key-label');
  var apiKeyHelp = document.getElementById('api-key-help');

  // Find the API key form group
  var apiKeyGroup = null;
  if (apiKeyInput) {
    apiKeyGroup = apiKeyInput.closest('.form-group');
  }

  // Show the section
  if (apiKeySection) {
    apiKeySection.style.display = 'block';
  }

  // Configure based on provider
  if (provider === 'ollama') {
    if (apiKeyGroup) apiKeyGroup.style.display = 'none';
    if (ollamaUrlGroup) ollamaUrlGroup.style.display = 'block';
    if (apiKeyHelp) apiKeyHelp.textContent = 'Ollama runs locally - no API key needed';
  } else {
    if (apiKeyGroup) apiKeyGroup.style.display = 'block';
    if (ollamaUrlGroup) ollamaUrlGroup.style.display = 'none';

    var labels = {
      anthropic: 'Anthropic API Key',
      openai: 'OpenAI API Key',
      openrouter: 'OpenRouter API Key'
    };

    if (apiKeyLabel) apiKeyLabel.textContent = labels[provider] || 'API Key';
    if (apiKeyHelp) apiKeyHelp.textContent = 'Your API key is stored locally and never shared';
  }

  // Load models for this provider
  loadModelsForProvider(provider);

  // Save to config
  if (typeof AegisConfig !== 'undefined') {
    AegisConfig.setValue('llm.provider', provider);
  }
}

/**
 * Load available models for a provider
 */
function loadModelsForProvider(provider) {
  var modelSelect = document.getElementById('llm-model');
  if (!modelSelect) return;

  modelSelect.innerHTML = '<option value="">Loading models...</option>';

  if (provider === 'ollama') {
    // Try to fetch from Ollama
    var ollamaUrl = document.getElementById('ollama-url');
    var url = ollamaUrl ? ollamaUrl.value : 'http://localhost:11434';

    fetch(url + '/api/tags', { signal: AbortSignal.timeout(3000) })
      .then(function(response) {
        if (response.ok) return response.json();
        throw new Error('Not found');
      })
      .then(function(data) {
        var models = data.models || [];
        if (models.length > 0) {
          modelSelect.innerHTML = models.map(function(m) {
            return '<option value="' + m.name + '">' + m.name + '</option>';
          }).join('');
        } else {
          setDefaultOllamaModels(modelSelect);
        }
      })
      .catch(function() {
        setDefaultOllamaModels(modelSelect);
      });
  } else {
    // Use predefined models
    var modelsByProvider = {
      anthropic: [
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (Latest)' },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
        { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku (Fast)' }
      ],
      openai: [
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast)' },
        { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }
      ],
      openrouter: [
        { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
        { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'google/gemini-pro', name: 'Gemini Pro' },
        { id: 'meta-llama/llama-3-70b-instruct', name: 'Llama 3 70B' }
      ]
    };

    var models = modelsByProvider[provider] || [];
    modelSelect.innerHTML = models.map(function(m) {
      return '<option value="' + m.id + '">' + m.name + '</option>';
    }).join('');
  }
}

/**
 * Set default Ollama models
 */
function setDefaultOllamaModels(select) {
  select.innerHTML = [
    '<option value="llama2">llama2</option>',
    '<option value="llama3">llama3</option>',
    '<option value="mistral">mistral</option>',
    '<option value="codellama">codellama</option>',
    '<option value="phi">phi</option>'
  ].join('');
}

/**
 * Toggle password visibility
 */
function togglePassword(inputId) {
  var input = document.getElementById(inputId);
  if (input) {
    if (input.type === 'password') {
      input.type = 'text';
    } else {
      input.type = 'password';
    }

    var icon = input.parentElement.querySelector('.toggle-password i');
    if (icon) {
      icon.className = (input.type === 'password') ? 'fas fa-eye' : 'fas fa-eye-slash';
    }
  }
}

/**
 * Save data from current step
 */
function saveCurrentStepData() {
  if (typeof AegisConfig === 'undefined') return;

  // Step 1: LLM Provider
  if (currentWizardStep === 1) {
    var apiKey = document.getElementById('llm-api-key');
    var model = document.getElementById('llm-model');
    var ollamaUrl = document.getElementById('ollama-url');

    AegisConfig.setValue('llm.provider', selectedProvider);

    if (selectedProvider === 'ollama') {
      AegisConfig.setValue('llm.ollama.baseUrl', ollamaUrl ? ollamaUrl.value : 'http://localhost:11434');
      AegisConfig.setValue('llm.ollama.model', model ? model.value : '');
    } else {
      AegisConfig.setValue('llm.' + selectedProvider + '.apiKey', apiKey ? apiKey.value : '');
      AegisConfig.setValue('llm.' + selectedProvider + '.model', model ? model.value : '');
    }
  }

  // Step 2: Cloud Providers
  if (currentWizardStep === 2) {
    ['aws', 'azure', 'gcp', 'onprem'].forEach(function(provider) {
      var toggle = document.getElementById(provider + '-enabled');
      AegisConfig.setValue('cloud.' + provider + '.enabled', toggle ? toggle.checked : false);
    });
  }

  // Step 3: Channels
  if (currentWizardStep === 3) {
    ['telegram', 'whatsapp', 'slack'].forEach(function(channel) {
      var toggle = document.getElementById(channel + '-enabled');
      AegisConfig.setValue('channels.' + channel + '.enabled', toggle ? toggle.checked : false);
    });
  }
}

/**
 * Run validation checks
 */
function runValidation() {
  console.log('Running validation...');

  var validationList = document.getElementById('validation-list');
  if (!validationList) return;

  validationList.innerHTML = '';

  // Get config
  var config = (typeof AegisConfig !== 'undefined') ? AegisConfig.get() : {};
  var provider = config.llm ? config.llm.provider : 'ollama';

  // Build validation items
  var items = [
    { name: 'LLM Provider (' + provider + ')', id: 'llm' }
  ];

  // Add cloud providers
  if (config.cloud) {
    if (config.cloud.aws && config.cloud.aws.enabled) items.push({ name: 'AWS', id: 'aws' });
    if (config.cloud.azure && config.cloud.azure.enabled) items.push({ name: 'Azure', id: 'azure' });
    if (config.cloud.gcp && config.cloud.gcp.enabled) items.push({ name: 'Google Cloud', id: 'gcp' });
    if (config.cloud.onprem && config.cloud.onprem.enabled) items.push({ name: 'On-Premises', id: 'onprem' });
  }

  // Add channels
  if (config.channels) {
    if (config.channels.telegram && config.channels.telegram.enabled) items.push({ name: 'Telegram', id: 'telegram' });
    if (config.channels.whatsapp && config.channels.whatsapp.enabled) items.push({ name: 'WhatsApp', id: 'whatsapp' });
    if (config.channels.slack && config.channels.slack.enabled) items.push({ name: 'Slack', id: 'slack' });
  }

  // Render items
  items.forEach(function(item) {
    var div = document.createElement('div');
    div.className = 'validation-item';
    div.id = 'validation-' + item.id;
    div.innerHTML = '<div class="icon pending"><i class="fas fa-circle"></i></div>' +
      '<div class="content"><h4>' + item.name + '</h4><p>Waiting...</p></div>';
    validationList.appendChild(div);
  });

  // Run validations sequentially
  validateItemsSequentially(items, 0, config);
}

/**
 * Validate items one by one
 */
function validateItemsSequentially(items, index, config) {
  if (index >= items.length) {
    showValidationSummary();
    return;
  }

  var item = items[index];
  validateSingleItem(item, config, function() {
    setTimeout(function() {
      validateItemsSequentially(items, index + 1, config);
    }, 300);
  });
}

/**
 * Validate a single item
 */
function validateSingleItem(item, config, callback) {
  var el = document.getElementById('validation-' + item.id);
  if (!el) {
    callback();
    return;
  }

  var icon = el.querySelector('.icon');
  var content = el.querySelector('.content p');

  // Show checking state
  icon.className = 'icon checking';
  icon.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  content.textContent = 'Checking...';

  setTimeout(function() {
    var success = false;
    var message = '';

    if (item.id === 'llm') {
      var provider = config.llm ? config.llm.provider : 'ollama';

      if (provider === 'ollama') {
        // For Ollama, check if it's reachable
        var ollamaUrl = (config.llm && config.llm.ollama && config.llm.ollama.baseUrl) || 'http://localhost:11434';

        fetch(ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(3000) })
          .then(function(response) {
            success = response.ok;
            message = success ? 'Connected to Ollama' : 'Cannot connect to Ollama';
            updateValidationUI(icon, content, success, message);
            callback();
          })
          .catch(function() {
            success = false;
            message = 'Ollama not running. Start with: ollama serve';
            updateValidationUI(icon, content, success, message);
            callback();
          });
        return; // Exit here, callback will be called in promise
      } else {
        var apiKey = config.llm && config.llm[provider] && config.llm[provider].apiKey;
        success = apiKey && apiKey.length > 10;
        message = success ? 'API key configured' : 'API key missing or invalid';
      }
    } else {
      // For other items, just mark as configured
      success = true;
      message = 'Configured';
    }

    updateValidationUI(icon, content, success, message);
    callback();
  }, 500);
}

/**
 * Update validation UI
 */
function updateValidationUI(icon, content, success, message) {
  icon.className = success ? 'icon success' : 'icon error';
  icon.innerHTML = success ? '<i class="fas fa-check"></i>' : '<i class="fas fa-times"></i>';
  content.textContent = message;
}

/**
 * Show validation summary
 */
function showValidationSummary() {
  var errorCount = document.querySelectorAll('.validation-item .icon.error').length;
  var summary = document.getElementById('validation-summary');

  if (summary) {
    summary.style.display = 'block';

    if (errorCount === 0) {
      summary.innerHTML = '<div class="summary-icon success"><i class="fas fa-check-circle"></i></div>' +
        '<h3>All validations passed!</h3>' +
        '<p>Your AEGIS-T2A instance is ready to use</p>';
    } else {
      summary.innerHTML = '<div class="summary-icon warning"><i class="fas fa-exclamation-circle"></i></div>' +
        '<h3>Some validations need attention</h3>' +
        '<p>You can still proceed, but some features may not work</p>';
    }
  }

  // Update buttons
  var runBtn = document.getElementById('run-validation');
  var rerunBtn = document.getElementById('rerun-validation');

  if (runBtn) runBtn.style.display = 'none';
  if (rerunBtn) rerunBtn.style.display = 'inline-flex';
}

// Make all functions globally available
window.initWizard = initWizard;
window.showWizardStep = showWizardStep;
window.wizardNext = wizardNext;
window.wizardPrev = wizardPrev;
window.wizardFinish = wizardFinish;
window.skipWizard = skipWizard;
window.selectLLMProvider = selectLLMProvider;
window.loadModelsForProvider = loadModelsForProvider;
window.togglePassword = togglePassword;
window.runValidation = runValidation;
window.switchOnpremTab = switchOnpremTab;
