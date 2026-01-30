/**
 * AEGIS-T2A Dashboard
 *
 * Main dashboard functionality and UI management.
 */

const Dashboard = {
  refreshInterval: null,
  charts: {},

  /**
   * Initialize dashboard
   */
  init() {
    this.bindEvents();
    this.loadDashboardData();
    this.startAutoRefresh();
  },

  /**
   * Bind event handlers
   */
  bindEvents() {
    // Intent input
    const intentInput = document.getElementById('intent-input');
    const intentSubmit = document.getElementById('intent-submit');

    if (intentInput && intentSubmit) {
      intentSubmit.addEventListener('click', () => {
        this.submitIntent(intentInput.value);
      });

      intentInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          this.submitIntent(intentInput.value);
        }
      });
    }

    // Refresh button
    const refreshBtn = document.getElementById('refresh-dashboard');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.loadDashboardData();
      });
    }

    // Period selector
    const periodSelect = document.getElementById('stats-period');
    if (periodSelect) {
      periodSelect.addEventListener('change', (e) => {
        this.loadStats(e.target.value);
      });
    }

    // Activity filter
    const activityFilter = document.getElementById('activity-filter');
    if (activityFilter) {
      activityFilter.addEventListener('change', (e) => {
        this.filterActivity(e.target.value);
      });
    }
  },

  /**
   * Load all dashboard data
   */
  async loadDashboardData() {
    try {
      await Promise.all([
        this.loadStats('24h'),
        this.loadRecentActivity(),
        this.loadActiveWorkflows(),
        this.loadSystemHealth()
      ]);
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
      Toast.error('Failed to load dashboard data');
    }
  },

  /**
   * Load statistics
   */
  async loadStats(period = '24h') {
    try {
      const stats = await AegisAPI.getStats(period);

      // Update stat cards
      this.updateStatCard('intents-count', stats.intents || 0);
      this.updateStatCard('workflows-count', stats.workflows || 0);
      this.updateStatCard('success-rate', `${stats.successRate || 0}%`);
      this.updateStatCard('avg-duration', this.formatDuration(stats.avgDuration || 0));

      // Update charts if available
      if (stats.timeline) {
        this.updateActivityChart(stats.timeline);
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  },

  /**
   * Update a stat card value
   */
  updateStatCard(id, value) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = value;
      element.classList.add('updated');
      setTimeout(() => element.classList.remove('updated'), 300);
    }
  },

  /**
   * Load recent activity
   */
  async loadRecentActivity() {
    try {
      const events = await AegisAPI.getAuditEvents({ limit: 20 });
      this.renderActivityList(events.events || events);
    } catch (error) {
      console.error('Failed to load activity:', error);
    }
  },

  /**
   * Render activity list
   */
  renderActivityList(events) {
    const container = document.getElementById('activity-list');
    if (!container) return;

    if (!events || events.length === 0) {
      container.innerHTML = '<div class="empty-state">No recent activity</div>';
      return;
    }

    container.innerHTML = events.map(event => `
      <div class="activity-item ${event.success ? 'success' : 'error'}" data-type="${event.eventType}">
        <div class="activity-icon">${this.getEventIcon(event.eventType)}</div>
        <div class="activity-content">
          <div class="activity-title">${this.escapeHtml(event.action)}</div>
          <div class="activity-meta">
            <span class="activity-type">${event.eventType}</span>
            <span class="activity-time">${this.formatTime(event.timestamp)}</span>
          </div>
        </div>
        <div class="activity-status">
          ${event.success ? '<span class="status-success">✓</span>' : '<span class="status-error">✗</span>'}
        </div>
      </div>
    `).join('');
  },

  /**
   * Filter activity list
   */
  filterActivity(type) {
    const items = document.querySelectorAll('.activity-item');
    items.forEach(item => {
      if (type === 'all' || item.dataset.type === type) {
        item.style.display = 'flex';
      } else {
        item.style.display = 'none';
      }
    });
  },

  /**
   * Load active workflows
   */
  async loadActiveWorkflows() {
    try {
      const workflows = await AegisAPI.listWorkflows({ status: 'running', limit: 10 });
      this.renderWorkflowList(workflows.workflows || workflows);
    } catch (error) {
      console.error('Failed to load workflows:', error);
    }
  },

  /**
   * Render workflow list
   */
  renderWorkflowList(workflows) {
    const container = document.getElementById('active-workflows');
    if (!container) return;

    if (!workflows || workflows.length === 0) {
      container.innerHTML = '<div class="empty-state">No active workflows</div>';
      return;
    }

    container.innerHTML = workflows.map(wf => `
      <div class="workflow-item" data-id="${wf.workflowId}">
        <div class="workflow-header">
          <span class="workflow-id">${wf.workflowId.substring(0, 12)}...</span>
          <span class="workflow-status status-${wf.status}">${wf.status}</span>
        </div>
        <div class="workflow-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${this.calculateProgress(wf)}%"></div>
          </div>
          <span class="progress-text">${wf.completedSteps?.length || 0}/${wf.totalSteps || '?'} steps</span>
        </div>
        <div class="workflow-actions">
          <button class="btn btn-small" onclick="Dashboard.viewWorkflow('${wf.workflowId}')">View</button>
          ${wf.status === 'awaiting_approval' ?
            `<button class="btn btn-small btn-primary" onclick="Dashboard.approveWorkflow('${wf.workflowId}')">Approve</button>` :
            ''}
          ${wf.status === 'running' ?
            `<button class="btn btn-small btn-danger" onclick="Dashboard.cancelWorkflow('${wf.workflowId}')">Cancel</button>` :
            ''}
        </div>
      </div>
    `).join('');
  },

  /**
   * Load system health
   */
  async loadSystemHealth() {
    try {
      const health = await AegisAPI.healthCheck();
      this.renderHealthStatus(health);
    } catch (error) {
      console.error('Failed to load health:', error);
      this.renderHealthStatus({ status: 'unhealthy', error: error.message });
    }
  },

  /**
   * Render health status
   */
  renderHealthStatus(health) {
    const container = document.getElementById('system-health');
    if (!container) return;

    const isHealthy = health.status === 'ok' || health.status === 'healthy';
    container.innerHTML = `
      <div class="health-indicator ${isHealthy ? 'healthy' : 'unhealthy'}">
        <span class="health-dot"></span>
        <span class="health-text">${isHealthy ? 'All Systems Operational' : 'System Issues Detected'}</span>
      </div>
      ${health.components ? `
        <div class="health-components">
          ${Object.entries(health.components).map(([name, status]) => `
            <div class="health-component">
              <span class="component-name">${name}</span>
              <span class="component-status status-${status}">${status}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  },

  /**
   * Submit an intent
   */
  async submitIntent(text) {
    if (!text || !text.trim()) {
      Toast.warning('Please enter an intent');
      return;
    }

    const input = document.getElementById('intent-input');
    const submitBtn = document.getElementById('intent-submit');

    try {
      if (input) input.disabled = true;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Processing...';
      }

      // Create intent
      const intentResult = await AegisAPI.createIntent(text.trim());
      Toast.success('Intent created successfully');

      // Generate plan
      const planResult = await AegisAPI.generatePlan(intentResult.intent.intentId);
      Toast.info('Plan generated');

      // Show plan review modal
      this.showPlanReview(planResult.plan);

      // Clear input
      if (input) input.value = '';

    } catch (error) {
      Toast.error(`Failed: ${error.message}`);
    } finally {
      if (input) input.disabled = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Execute';
      }
    }
  },

  /**
   * Show plan review modal
   */
  showPlanReview(plan) {
    const modal = document.getElementById('plan-review-modal');
    if (!modal) return;

    const content = modal.querySelector('.modal-body');
    if (content) {
      content.innerHTML = `
        <div class="plan-summary">
          <h4>Plan Summary</h4>
          <div class="plan-meta">
            <span><strong>Plan ID:</strong> ${plan.planId}</span>
            <span><strong>Risk Level:</strong> <span class="risk-${plan.riskLevel}">${plan.riskLevel}</span></span>
            <span><strong>Estimated Cost:</strong> $${plan.totalEstimatedCost?.toFixed(2) || '0.00'}</span>
          </div>
        </div>
        <div class="plan-steps">
          <h4>Steps (${plan.steps?.length || 0})</h4>
          <ol class="steps-list">
            ${(plan.steps || []).map(step => `
              <li class="step-item risk-${step.riskLevel}">
                <div class="step-header">
                  <span class="step-action">${step.action}</span>
                  <span class="step-risk">${step.riskLevel}</span>
                </div>
                <div class="step-description">${step.description}</div>
                ${step.approvalRequired ? '<span class="approval-badge">Requires Approval</span>' : ''}
              </li>
            `).join('')}
          </ol>
        </div>
      `;
    }

    // Set up action buttons
    const simulateBtn = modal.querySelector('[data-action="simulate"]');
    const executeBtn = modal.querySelector('[data-action="execute"]');

    if (simulateBtn) {
      simulateBtn.onclick = () => this.simulatePlan(plan.planId);
    }

    if (executeBtn) {
      executeBtn.onclick = () => this.executePlan(plan.planId);
    }

    // Show modal
    modal.classList.add('show');
  },

  /**
   * Simulate a plan
   */
  async simulatePlan(planId) {
    try {
      Toast.info('Running simulation...');
      const result = await AegisAPI.simulatePlan(planId);

      // Update modal with simulation results
      const modal = document.getElementById('plan-review-modal');
      if (modal) {
        const simResults = modal.querySelector('.simulation-results') || document.createElement('div');
        simResults.className = 'simulation-results';
        simResults.innerHTML = `
          <h4>Simulation Results</h4>
          <div class="sim-meta">
            <span><strong>Status:</strong> ${result.status}</span>
            <span><strong>Risk Score:</strong> ${result.riskScore}/100</span>
            <span><strong>Blast Radius:</strong> ${result.blastRadius}</span>
          </div>
          ${result.anomalies?.length ? `
            <div class="sim-anomalies">
              <h5>Anomalies Detected:</h5>
              <ul>
                ${result.anomalies.map(a => `<li>${a}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
        `;

        const content = modal.querySelector('.modal-body');
        if (content && !content.querySelector('.simulation-results')) {
          content.appendChild(simResults);
        }
      }

      Toast.success('Simulation completed');
    } catch (error) {
      Toast.error(`Simulation failed: ${error.message}`);
    }
  },

  /**
   * Execute a plan
   */
  async executePlan(planId) {
    try {
      if (!confirm('Are you sure you want to execute this plan?')) return;

      Toast.info('Creating workflow...');
      const result = await AegisAPI.executePlan(planId);

      Toast.success(`Workflow created: ${result.workflow.workflowId}`);

      // Close modal
      const modal = document.getElementById('plan-review-modal');
      if (modal) modal.classList.remove('show');

      // Refresh workflows
      this.loadActiveWorkflows();
      this.loadRecentActivity();

    } catch (error) {
      Toast.error(`Execution failed: ${error.message}`);
    }
  },

  /**
   * View workflow details
   */
  async viewWorkflow(workflowId) {
    try {
      const workflow = await AegisAPI.getWorkflow(workflowId);
      this.showWorkflowModal(workflow);
    } catch (error) {
      Toast.error(`Failed to load workflow: ${error.message}`);
    }
  },

  /**
   * Show workflow detail modal
   */
  showWorkflowModal(workflow) {
    const modal = document.getElementById('workflow-modal');
    if (!modal) return;

    const content = modal.querySelector('.modal-body');
    if (content) {
      content.innerHTML = `
        <div class="workflow-detail">
          <div class="workflow-header">
            <h4>Workflow: ${workflow.workflowId}</h4>
            <span class="status-badge status-${workflow.status}">${workflow.status}</span>
          </div>
          <div class="workflow-meta">
            <span><strong>Created:</strong> ${this.formatTime(workflow.createdAt)}</span>
            <span><strong>Plan ID:</strong> ${workflow.planId}</span>
            <span><strong>Attempt:</strong> ${workflow.currentAttempt}</span>
          </div>
          <div class="workflow-steps">
            <h5>Steps</h5>
            <div class="steps-timeline">
              ${this.renderWorkflowSteps(workflow)}
            </div>
          </div>
          ${workflow.error ? `
            <div class="workflow-error">
              <h5>Error</h5>
              <pre>${workflow.error}</pre>
            </div>
          ` : ''}
        </div>
      `;
    }

    modal.classList.add('show');
  },

  /**
   * Render workflow steps timeline
   */
  renderWorkflowSteps(workflow) {
    const completedIds = new Set((workflow.completedSteps || []).map(s => s.stepId));
    const failedId = workflow.failedStep?.stepId;

    // We need to get plan steps - for now show completed/failed
    return `
      <div class="completed-steps">
        ${(workflow.completedSteps || []).map(step => `
          <div class="timeline-step completed">
            <span class="step-icon">✓</span>
            <span class="step-name">${step.action || step.stepId}</span>
          </div>
        `).join('')}
      </div>
      ${workflow.failedStep ? `
        <div class="timeline-step failed">
          <span class="step-icon">✗</span>
          <span class="step-name">${workflow.failedStep.action || workflow.failedStep.stepId}</span>
        </div>
      ` : ''}
    `;
  },

  /**
   * Approve a workflow
   */
  async approveWorkflow(workflowId) {
    try {
      if (!confirm('Approve this workflow for execution?')) return;

      await AegisAPI.approveWorkflow(workflowId, 'approved');
      Toast.success('Workflow approved');
      this.loadActiveWorkflows();
    } catch (error) {
      Toast.error(`Failed to approve: ${error.message}`);
    }
  },

  /**
   * Cancel a workflow
   */
  async cancelWorkflow(workflowId) {
    try {
      if (!confirm('Are you sure you want to cancel this workflow?')) return;

      await AegisAPI.cancelWorkflow(workflowId);
      Toast.success('Workflow cancelled');
      this.loadActiveWorkflows();
    } catch (error) {
      Toast.error(`Failed to cancel: ${error.message}`);
    }
  },

  /**
   * Start auto-refresh
   */
  startAutoRefresh(interval = 30000) {
    this.stopAutoRefresh();
    this.refreshInterval = setInterval(() => {
      this.loadDashboardData();
    }, interval);
  },

  /**
   * Stop auto-refresh
   */
  stopAutoRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  },

  // ==========================================================================
  // Helper functions
  // ==========================================================================

  getEventIcon(type) {
    const icons = {
      'intent.created': '📝',
      'intent.parsed': '🔍',
      'plan.generated': '📋',
      'simulation.completed': '🧪',
      'workflow.created': '🔄',
      'workflow.started': '▶️',
      'workflow.completed': '✅',
      'workflow.failed': '❌',
      'step.executed': '⚡',
      'step.compensated': '↩️',
      'approval.requested': '⏳',
      'approval.granted': '✓',
      'approval.denied': '✗'
    };
    return icons[type] || '•';
  },

  formatTime(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

    return date.toLocaleDateString();
  },

  formatDuration(ms) {
    if (!ms) return '0s';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  },

  calculateProgress(workflow) {
    if (!workflow.totalSteps) return 0;
    const completed = workflow.completedSteps?.length || 0;
    return Math.round((completed / workflow.totalSteps) * 100);
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  updateActivityChart(data) {
    // Placeholder for chart implementation
    // Could use Chart.js or similar
    console.log('Activity chart data:', data);
  }
};

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Dashboard;
}
