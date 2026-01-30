/**
 * AEGIS-T2A API Client
 *
 * Handles all API communication with the backend.
 */

const AegisAPI = {
  baseUrl: '',
  headers: {},

  /**
   * Initialize API client
   */
  init(baseUrl = '') {
    this.baseUrl = baseUrl || AegisConfig.getValue('advanced.apiBaseUrl') || window.location.origin;
    this.headers = {
      'Content-Type': 'application/json',
    };
  },

  /**
   * Set authentication token
   */
  setAuthToken(token) {
    if (token) {
      this.headers['Authorization'] = `Bearer ${token}`;
    } else {
      delete this.headers['Authorization'];
    }
  },

  /**
   * Set user ID header
   */
  setUserId(userId) {
    if (userId) {
      this.headers['X-User-Id'] = userId;
    }
  },

  /**
   * Make API request
   */
  async request(method, endpoint, data = null, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const config = {
      method,
      headers: { ...this.headers, ...options.headers },
    };

    if (data && method !== 'GET') {
      config.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, config);
      const contentType = response.headers.get('content-type');

      let result;
      if (contentType && contentType.includes('application/json')) {
        result = await response.json();
      } else {
        result = await response.text();
      }

      if (!response.ok) {
        throw new APIError(
          result.error || result.message || 'Request failed',
          response.status,
          result
        );
      }

      return result;
    } catch (error) {
      if (error instanceof APIError) {
        throw error;
      }
      throw new APIError(error.message || 'Network error', 0, null);
    }
  },

  // HTTP method shortcuts
  get(endpoint, options) {
    return this.request('GET', endpoint, null, options);
  },

  post(endpoint, data, options) {
    return this.request('POST', endpoint, data, options);
  },

  put(endpoint, data, options) {
    return this.request('PUT', endpoint, data, options);
  },

  patch(endpoint, data, options) {
    return this.request('PATCH', endpoint, data, options);
  },

  delete(endpoint, options) {
    return this.request('DELETE', endpoint, null, options);
  },

  // ==========================================================================
  // Health & Status
  // ==========================================================================

  async healthCheck() {
    return this.get('/api/v1/health');
  },

  async getStatus() {
    return this.get('/api/v1/status');
  },

  // ==========================================================================
  // Intent Operations
  // ==========================================================================

  async createIntent(text, options = {}) {
    return this.post('/api/v1/intents', {
      text,
      environment: options.environment || 'development',
      context: options.context || {}
    });
  },

  async getIntent(intentId) {
    return this.get(`/api/v1/intents/${intentId}`);
  },

  async generatePlan(intentId) {
    return this.post(`/api/v1/intents/${intentId}/plan`);
  },

  // ==========================================================================
  // Plan Operations
  // ==========================================================================

  async getPlan(planId) {
    return this.get(`/api/v1/plans/${planId}`);
  },

  async simulatePlan(planId) {
    return this.post(`/api/v1/plans/${planId}/simulate`);
  },

  async executePlan(planId, options = {}) {
    return this.post(`/api/v1/plans/${planId}/execute`, {
      dryRun: options.dryRun || false
    });
  },

  // ==========================================================================
  // Workflow Operations
  // ==========================================================================

  async getWorkflow(workflowId) {
    return this.get(`/api/v1/workflows/${workflowId}`);
  },

  async approveWorkflow(workflowId, decision, reason = '') {
    return this.post(`/api/v1/workflows/${workflowId}/approve`, {
      decision,
      reason
    });
  },

  async cancelWorkflow(workflowId) {
    return this.post(`/api/v1/workflows/${workflowId}/cancel`);
  },

  async listWorkflows(options = {}) {
    const params = new URLSearchParams();
    if (options.status) params.append('status', options.status);
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.offset) params.append('offset', options.offset.toString());

    const query = params.toString();
    return this.get(`/api/v1/workflows${query ? '?' + query : ''}`);
  },

  // ==========================================================================
  // Audit Operations
  // ==========================================================================

  async getAuditEvents(options = {}) {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.offset) params.append('offset', options.offset.toString());
    if (options.workflowId) params.append('workflowId', options.workflowId);
    if (options.intentId) params.append('intentId', options.intentId);
    if (options.eventType) params.append('eventType', options.eventType);

    const query = params.toString();
    return this.get(`/api/v1/audit/events${query ? '?' + query : ''}`);
  },

  async verifyAuditChain() {
    return this.get('/api/v1/audit/verify');
  },

  // ==========================================================================
  // Registry Operations
  // ==========================================================================

  async getAdapters() {
    return this.get('/api/v1/registry/adapters');
  },

  async getAdapter(adapterId) {
    return this.get(`/api/v1/registry/adapters/${adapterId}`);
  },

  // ==========================================================================
  // Policy Operations
  // ==========================================================================

  async getPolicyRules() {
    return this.get('/api/v1/policy/rules');
  },

  // ==========================================================================
  // Configuration Operations
  // ==========================================================================

  async getServerConfig() {
    return this.get('/api/v1/config');
  },

  async updateServerConfig(config) {
    return this.put('/api/v1/config', config);
  },

  async testConnection(provider, config) {
    return this.post('/api/v1/connections/test', {
      provider,
      config
    });
  },

  // ==========================================================================
  // LLM Provider Operations
  // ==========================================================================

  async testLLMConnection(provider, config) {
    return this.post('/api/v1/llm/test', {
      provider,
      ...config
    });
  },

  async getLLMProviders() {
    return this.get('/api/v1/llm/providers');
  },

  // ==========================================================================
  // Cloud Provider Operations
  // ==========================================================================

  async testCloudConnection(provider, config) {
    return this.post('/api/v1/cloud/test', {
      provider,
      config
    });
  },

  async getCloudResources(provider) {
    return this.get(`/api/v1/cloud/${provider}/resources`);
  },

  // ==========================================================================
  // Channel Operations
  // ==========================================================================

  async testChannelConnection(channel, config) {
    return this.post('/api/v1/channels/test', {
      channel,
      config
    });
  },

  async getChannelStatus() {
    return this.get('/api/v1/channels/status');
  },

  // ==========================================================================
  // Metrics & Stats
  // ==========================================================================

  async getMetrics() {
    return this.get('/api/v1/metrics');
  },

  async getStats(period = '24h') {
    return this.get(`/api/v1/stats?period=${period}`);
  }
};

/**
 * Custom API Error class
 */
class APIError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.data = data;
  }
}

// Initialize on load
AegisAPI.init();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AegisAPI, APIError };
}
