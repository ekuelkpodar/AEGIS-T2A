/**
 * AEGIS-T2A Toast Notifications
 *
 * Simple toast notification system.
 */

const Toast = {
  container: null,
  defaultDuration: 4000,

  /**
   * Initialize toast container
   */
  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'toast-container';
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },

  /**
   * Show a toast notification
   */
  show(message, type = 'info', duration = this.defaultDuration) {
    this.init();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icon = this.getIcon(type);
    toast.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <span class="toast-message">${this.escapeHtml(message)}</span>
      <button class="toast-close" aria-label="Close">&times;</button>
    `;

    // Add close handler
    toast.querySelector('.toast-close').addEventListener('click', () => {
      this.dismiss(toast);
    });

    this.container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // Auto dismiss
    if (duration > 0) {
      setTimeout(() => {
        this.dismiss(toast);
      }, duration);
    }

    return toast;
  },

  /**
   * Dismiss a toast
   */
  dismiss(toast) {
    toast.classList.remove('show');
    toast.classList.add('hide');

    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  },

  /**
   * Get icon for toast type
   */
  getIcon(type) {
    switch (type) {
      case 'success':
        return '✓';
      case 'error':
        return '✗';
      case 'warning':
        return '⚠';
      case 'info':
      default:
        return 'ℹ';
    }
  },

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  // Convenience methods
  success(message, duration) {
    return this.show(message, 'success', duration);
  },

  error(message, duration) {
    return this.show(message, 'error', duration);
  },

  warning(message, duration) {
    return this.show(message, 'warning', duration);
  },

  info(message, duration) {
    return this.show(message, 'info', duration);
  },

  /**
   * Show a promise-based loading toast
   */
  async promise(promise, messages = {}) {
    const loadingToast = this.show(
      messages.loading || 'Loading...',
      'info',
      0
    );

    try {
      const result = await promise;
      this.dismiss(loadingToast);
      this.success(messages.success || 'Success!');
      return result;
    } catch (error) {
      this.dismiss(loadingToast);
      this.error(messages.error || error.message || 'An error occurred');
      throw error;
    }
  }
};

// Initialize on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  Toast.init();
});

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Toast;
}
