/**
 * Sandbox Builder - Interactive Environment Creator
 *
 * Allows users to request and build custom sandboxes for testing, development,
 * and experimentation. Supports:
 * - Graphic/Visual sandboxes
 * - Code execution environments
 * - API testing environments
 * - Container-based sandboxes
 */

const SandboxBuilder = {
  activeSandboxes: [],
  topZIndex: 9000,
  templates: {
    graphic: {
      name: 'Graphic Sandbox',
      description: 'Interactive canvas for graphics, animations, and visualizations',
      icon: 'fas fa-paint-brush',
      type: 'browser',
      setup: 'canvas',
    },
    code: {
      name: 'Code Playground',
      description: 'Execute JavaScript, Python, or other code',
      icon: 'fas fa-code',
      type: 'container',
      setup: 'jupyter',
    },
    api: {
      name: 'API Tester',
      description: 'Test and debug REST APIs',
      icon: 'fas fa-plug',
      type: 'browser',
      setup: 'postman-like',
    },
    docker: {
      name: 'Docker Sandbox',
      description: 'Full container environment',
      icon: 'fab fa-docker',
      type: 'container',
      setup: 'docker-compose',
    },
  },

  init() {
    this.createSandboxPanel();
    this.bindEvents();
    this.loadActiveSandboxes();
  },

  createSandboxPanel() {
    const sandboxHTML = `
      <div id="sandbox-panel" class="sandbox-panel hidden">
        <div class="sandbox-overlay" id="sandbox-overlay"></div>
        <div class="sandbox-container">
          <div class="sandbox-header">
            <h2><i class="fas fa-cube"></i> Sandbox Builder</h2>
            <button class="sandbox-close" id="sandbox-close">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <div class="sandbox-content">
            <!-- Quick Request -->
            <div class="sandbox-quick-request">
              <h3>Quick Request</h3>
              <p>Describe what you want to build, and we'll create it for you</p>
              <div class="quick-request-input">
                <input type="text" id="sandbox-quick-request"
                       placeholder="e.g., 'build a graphic sandbox locally', 'create API testing environment'"
                       class="sandbox-input">
                <button id="sandbox-quick-build" class="btn-primary">
                  <i class="fas fa-magic"></i> Build
                </button>
              </div>
            </div>

            <!-- Templates -->
            <div class="sandbox-templates">
              <h3>Templates</h3>
              <div class="template-grid">
                ${Object.entries(this.templates).map(([id, template]) => `
                  <div class="template-card" data-template="${id}">
                    <div class="template-icon">
                      <i class="${template.icon}"></i>
                    </div>
                    <h4>${template.name}</h4>
                    <p>${template.description}</p>
                    <button class="btn-secondary template-create" data-template="${id}">
                      <i class="fas fa-plus"></i> Create
                    </button>
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- Active Sandboxes -->
            <div class="sandbox-active">
              <h3>Active Sandboxes</h3>
              <div id="sandbox-list" class="sandbox-list">
                <p class="empty-state">No active sandboxes. Create one to get started!</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Sandbox Window Template -->
      <div id="sandbox-window-template" class="sandbox-window-template" style="display: none;">
        <div class="sandbox-window">
          <div class="sandbox-window-header">
            <span class="sandbox-window-title"></span>
            <div class="sandbox-window-controls">
              <button class="sandbox-control" data-action="minimize">
                <i class="fas fa-window-minimize"></i>
              </button>
              <button class="sandbox-control" data-action="maximize">
                <i class="fas fa-window-maximize"></i>
              </button>
              <button class="sandbox-control" data-action="close">
                <i class="fas fa-times"></i>
              </button>
            </div>
          </div>
          <div class="sandbox-window-content"></div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', sandboxHTML);
  },

  bindEvents() {
    // Open sandbox builder
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="open-sandbox"]')) {
        this.open();
      }
    });

    // Close
    document.getElementById('sandbox-close')?.addEventListener('click', () => this.close());
    document.getElementById('sandbox-overlay')?.addEventListener('click', () => this.close());

    // Quick build
    document.getElementById('sandbox-quick-build')?.addEventListener('click', () => {
      const request = document.getElementById('sandbox-quick-request').value;
      if (request) {
        this.quickBuild(request);
      }
    });

    // Enter key on quick request
    document.getElementById('sandbox-quick-request')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const request = e.target.value;
        if (request) {
          this.quickBuild(request);
        }
      }
    });

    // Template create buttons
    document.querySelectorAll('.template-create').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const templateId = e.target.dataset.template;
        this.createFromTemplate(templateId);
      });
    });
  },

  async quickBuild(request) {
    const btn = document.getElementById('sandbox-quick-build');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Building...';

    try {
      // Parse the request to determine what to build
      const sandboxType = this.parseRequest(request);

      await this.createSandbox(sandboxType.type, sandboxType.config);

      document.getElementById('sandbox-quick-request').value = '';
      alert(`✅ ${sandboxType.name} created successfully!`);
    } catch (error) {
      alert(`❌ Failed to create sandbox: ${error.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-magic"></i> Build';
    }
  },

  parseRequest(request) {
    const lower = request.toLowerCase();

    if (lower.includes('graphic') || lower.includes('canvas') || lower.includes('draw') || lower.includes('visual')) {
      return {
        type: 'graphic',
        name: 'Graphic Sandbox',
        config: {
          width: 800,
          height: 600,
          tools: ['brush', 'line', 'rectangle', 'circle', 'text'],
        },
      };
    } else if (lower.includes('code') || lower.includes('python') || lower.includes('javascript') || lower.includes('execute')) {
      return {
        type: 'code',
        name: 'Code Playground',
        config: {
          language: lower.includes('python') ? 'python' : 'javascript',
          theme: 'dark',
        },
      };
    } else if (lower.includes('api') || lower.includes('rest') || lower.includes('http')) {
      return {
        type: 'api',
        name: 'API Tester',
        config: {
          method: 'GET',
          url: '',
        },
      };
    } else if (lower.includes('docker') || lower.includes('container')) {
      return {
        type: 'docker',
        name: 'Docker Sandbox',
        config: {
          image: 'ubuntu:latest',
        },
      };
    } else {
      // Default to graphic sandbox
      return {
        type: 'graphic',
        name: 'Graphic Sandbox',
        config: {
          width: 800,
          height: 600,
        },
      };
    }
  },

  async createFromTemplate(templateId) {
    const template = this.templates[templateId];
    await this.createSandbox(templateId, {});
    alert(`✅ ${template.name} created successfully!`);
  },

  async createSandbox(type, config) {
    const sandboxId = `sandbox_${Date.now()}`;
    const template = this.templates[type];

    let content = '';

    switch (type) {
      case 'graphic':
        content = this.createGraphicSandbox(sandboxId, config);
        break;
      case 'code':
        content = this.createCodeSandbox(sandboxId, config);
        break;
      case 'api':
        content = this.createApiSandbox(sandboxId, config);
        break;
      case 'docker':
        content = this.createDockerSandbox(sandboxId, config);
        break;
    }

    const sandbox = {
      id: sandboxId,
      type,
      name: template.name,
      config,
      createdAt: new Date(),
    };

    this.activeSandboxes.push(sandbox);
    this.renderSandboxWindow(sandbox, content);
    this.updateSandboxList();
    this.saveSandboxes();
  },

  createGraphicSandbox(sandboxId, config) {
    const width = config.width || 800;
    const height = config.height || 600;

    return `
      <div class="graphic-sandbox" id="${sandboxId}">
        <div class="graphic-toolbar">
          <button class="tool-btn active" data-tool="brush" title="Brush">
            <i class="fas fa-paint-brush"></i>
          </button>
          <button class="tool-btn" data-tool="line" title="Line">
            <i class="fas fa-minus"></i>
          </button>
          <button class="tool-btn" data-tool="rectangle" title="Rectangle">
            <i class="far fa-square"></i>
          </button>
          <button class="tool-btn" data-tool="circle" title="Circle">
            <i class="far fa-circle"></i>
          </button>
          <button class="tool-btn" data-tool="text" title="Text">
            <i class="fas fa-font"></i>
          </button>
          <div class="tool-separator"></div>
          <input type="color" id="${sandboxId}-color" value="#000000" title="Color">
          <input type="range" id="${sandboxId}-size" min="1" max="50" value="5" title="Brush Size">
          <div class="tool-separator"></div>
          <button class="tool-btn" id="${sandboxId}-clear" title="Clear">
            <i class="fas fa-trash"></i>
          </button>
          <button class="tool-btn" id="${sandboxId}-save" title="Save">
            <i class="fas fa-download"></i>
          </button>
        </div>
        <canvas id="${sandboxId}-canvas"
                width="${width}"
                height="${height}"
                style="border: 1px solid #333; cursor: crosshair;">
        </canvas>
        <script>
          (function() {
            const canvas = document.getElementById('${sandboxId}-canvas');
            const ctx = canvas.getContext('2d');
            let isDrawing = false;
            let currentTool = 'brush';
            let startX, startY;

            // Tool selection
            document.querySelectorAll('#${sandboxId} .tool-btn[data-tool]').forEach(btn => {
              btn.addEventListener('click', (e) => {
                document.querySelectorAll('#${sandboxId} .tool-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                currentTool = e.currentTarget.dataset.tool;
              });
            });

            canvas.addEventListener('mousedown', (e) => {
              isDrawing = true;
              startX = e.offsetX;
              startY = e.offsetY;
            });

            canvas.addEventListener('mousemove', (e) => {
              if (!isDrawing) return;

              ctx.strokeStyle = document.getElementById('${sandboxId}-color').value;
              ctx.lineWidth = document.getElementById('${sandboxId}-size').value;

              if (currentTool === 'brush') {
                ctx.lineTo(e.offsetX, e.offsetY);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(e.offsetX, e.offsetY);
              }
            });

            canvas.addEventListener('mouseup', (e) => {
              if (!isDrawing) return;
              isDrawing = false;

              const color = document.getElementById('${sandboxId}-color').value;
              const size = document.getElementById('${sandboxId}-size').value;

              if (currentTool === 'line') {
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(e.offsetX, e.offsetY);
                ctx.strokeStyle = color;
                ctx.lineWidth = size;
                ctx.stroke();
              } else if (currentTool === 'rectangle') {
                ctx.strokeStyle = color;
                ctx.lineWidth = size;
                ctx.strokeRect(startX, startY, e.offsetX - startX, e.offsetY - startY);
              } else if (currentTool === 'circle') {
                const radius = Math.sqrt(Math.pow(e.offsetX - startX, 2) + Math.pow(e.offsetY - startY, 2));
                ctx.beginPath();
                ctx.arc(startX, startY, radius, 0, 2 * Math.PI);
                ctx.strokeStyle = color;
                ctx.lineWidth = size;
                ctx.stroke();
              }
            });

            document.getElementById('${sandboxId}-clear').addEventListener('click', () => {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
            });

            document.getElementById('${sandboxId}-save').addEventListener('click', () => {
              const link = document.createElement('a');
              link.download = 'drawing.png';
              link.href = canvas.toDataURL();
              link.click();
            });
          })();
        </script>
      </div>
    `;
  },

  createCodeSandbox(sandboxId, config) {
    const language = config.language || 'javascript';

    return `
      <div class="code-sandbox" id="${sandboxId}">
        <div class="code-editor-container">
          <div class="code-editor-header">
            <select id="${sandboxId}-language" class="language-select">
              <option value="javascript" ${language === 'javascript' ? 'selected' : ''}>JavaScript</option>
              <option value="python" ${language === 'python' ? 'selected' : ''}>Python</option>
              <option value="html" ${language === 'html' ? 'selected' : ''}>HTML/CSS</option>
            </select>
            <button id="${sandboxId}-run" class="btn-primary">
              <i class="fas fa-play"></i> Run
            </button>
            <button id="${sandboxId}-clear-output" class="btn-secondary">
              <i class="fas fa-eraser"></i> Clear
            </button>
          </div>
          <textarea id="${sandboxId}-editor" class="code-editor" placeholder="Write your code here...">${this.getDefaultCode(language)}</textarea>
          <div class="code-output">
            <div class="output-header">Output:</div>
            <pre id="${sandboxId}-output" class="output-content"></pre>
          </div>
        </div>
        <script>
          document.getElementById('${sandboxId}-run').addEventListener('click', () => {
            const code = document.getElementById('${sandboxId}-editor').value;
            const language = document.getElementById('${sandboxId}-language').value;
            const output = document.getElementById('${sandboxId}-output');

            if (language === 'javascript') {
              try {
                const result = eval(code);
                output.textContent = result !== undefined ? String(result) : 'Code executed successfully';
              } catch (error) {
                output.textContent = 'Error: ' + error.message;
                output.style.color = '#ff4444';
              }
            } else if (language === 'python' || language === 'html') {
              output.textContent = 'Note: ' + language + ' execution requires server-side support. This is a demo.';
            }
          });

          document.getElementById('${sandboxId}-clear-output').addEventListener('click', () => {
            document.getElementById('${sandboxId}-output').textContent = '';
          });
        </script>
      </div>
    `;
  },

  createApiSandbox(sandboxId, config) {
    return `
      <div class="api-sandbox" id="${sandboxId}">
        <div class="api-request">
          <div class="api-method-url">
            <select id="${sandboxId}-method" class="api-method">
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
              <option value="PATCH">PATCH</option>
            </select>
            <input type="text" id="${sandboxId}-url" class="api-url" placeholder="https://api.example.com/endpoint">
            <button id="${sandboxId}-send" class="btn-primary">
              <i class="fas fa-paper-plane"></i> Send
            </button>
          </div>
          <div class="api-tabs">
            <button class="api-tab active" data-tab="headers">Headers</button>
            <button class="api-tab" data-tab="body">Body</button>
            <button class="api-tab" data-tab="auth">Auth</button>
          </div>
          <div class="api-tab-content">
            <textarea id="${sandboxId}-headers" class="api-textarea" placeholder='{"Content-Type": "application/json"}'></textarea>
            <textarea id="${sandboxId}-body" class="api-textarea hidden" placeholder='{"key": "value"}'></textarea>
            <div id="${sandboxId}-auth" class="api-auth hidden">
              <input type="text" placeholder="Username">
              <input type="password" placeholder="Password">
            </div>
          </div>
        </div>
        <div class="api-response">
          <div class="response-header">
            <span>Response</span>
            <span id="${sandboxId}-status" class="response-status"></span>
          </div>
          <pre id="${sandboxId}-response" class="response-content"></pre>
        </div>
        <script>
          document.getElementById('${sandboxId}-send').addEventListener('click', async () => {
            const method = document.getElementById('${sandboxId}-method').value;
            const url = document.getElementById('${sandboxId}-url').value;
            const headersText = document.getElementById('${sandboxId}-headers').value;
            const bodyText = document.getElementById('${sandboxId}-body').value;

            try {
              const headers = headersText ? JSON.parse(headersText) : {};
              const options = { method, headers };

              if (method !== 'GET' && bodyText) {
                options.body = bodyText;
              }

              const response = await fetch(url, options);
              const data = await response.json();

              document.getElementById('${sandboxId}-status').textContent = response.status + ' ' + response.statusText;
              document.getElementById('${sandboxId}-status').style.color = response.ok ? '#4CAF50' : '#ff4444';
              document.getElementById('${sandboxId}-response').textContent = JSON.stringify(data, null, 2);
            } catch (error) {
              document.getElementById('${sandboxId}-status').textContent = 'Error';
              document.getElementById('${sandboxId}-status').style.color = '#ff4444';
              document.getElementById('${sandboxId}-response').textContent = error.message;
            }
          });

          document.querySelectorAll('#${sandboxId} .api-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
              const tabName = e.target.dataset.tab;
              document.querySelectorAll('#${sandboxId} .api-tab').forEach(t => t.classList.remove('active'));
              e.target.classList.add('active');
              document.querySelectorAll('#${sandboxId} .api-tab-content > *').forEach(c => c.classList.add('hidden'));
              document.getElementById('${sandboxId}-' + tabName).classList.remove('hidden');
            });
          });
        </script>
      </div>
    `;
  },

  createDockerSandbox(sandboxId, config) {
    return `
      <div class="docker-sandbox" id="${sandboxId}">
        <div class="docker-controls">
          <input type="text" id="${sandboxId}-image" class="docker-input" placeholder="Image (e.g., ubuntu:latest)" value="${config.image || 'ubuntu:latest'}">
          <button id="${sandboxId}-start" class="btn-primary">
            <i class="fas fa-play"></i> Start Container
          </button>
          <button id="${sandboxId}-stop" class="btn-secondary" disabled>
            <i class="fas fa-stop"></i> Stop
          </button>
        </div>
        <div class="docker-terminal">
          <pre id="${sandboxId}-logs">Container logs will appear here...</pre>
        </div>
        <script>
          document.getElementById('${sandboxId}-start').addEventListener('click', async () => {
            const image = document.getElementById('${sandboxId}-image').value;
            const logs = document.getElementById('${sandboxId}-logs');

            logs.textContent = 'Starting container...\\n';

            try {
              const response = await fetch('/api/sandbox/docker/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image }),
              });

              const data = await response.json();

              if (response.ok) {
                logs.textContent += 'Container started: ' + data.containerId + '\\n';
                document.getElementById('${sandboxId}-stop').disabled = false;
              } else {
                logs.textContent += 'Error: ' + data.error + '\\n';
              }
            } catch (error) {
              logs.textContent += 'Error: ' + error.message + '\\n';
            }
          });
        </script>
      </div>
    `;
  },

  getDefaultCode(language) {
    const defaults = {
      javascript: `// JavaScript Example
console.log('Hello from AEGIS-T2A Sandbox!');

function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

console.log('Factorial of 5:', factorial(5));`,
      python: `# Python Example
print('Hello from AEGIS-T2A Sandbox!')

def factorial(n):
    return 1 if n <= 1 else n * factorial(n - 1)

print('Factorial of 5:', factorial(5))`,
      html: `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial; text-align: center; }
    h1 { color: #4CAF50; }
  </style>
</head>
<body>
  <h1>Hello from AEGIS-T2A!</h1>
  <p>This is a sandbox environment.</p>
</body>
</html>`,
    };

    return defaults[language] || '';
  },

  renderSandboxWindow(sandbox, content) {
    const windowHTML = `
      <div class="sandbox-window" id="window-${sandbox.id}" data-sandbox-id="${sandbox.id}">
        <div class="sandbox-window-header">
          <span class="sandbox-window-title">
            <i class="${this.templates[sandbox.type].icon}"></i> ${sandbox.name}
          </span>
          <div class="sandbox-window-controls">
            <button class="sandbox-control" data-action="minimize">
              <i class="fas fa-window-minimize"></i>
            </button>
            <button class="sandbox-control" data-action="maximize">
              <i class="fas fa-window-maximize"></i>
            </button>
            <button class="sandbox-control" data-action="close" data-sandbox-id="${sandbox.id}">
              <i class="fas fa-times"></i>
            </button>
          </div>
        </div>
        <div class="sandbox-window-content">${content}</div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', windowHTML);

    // Make draggable
    this.makeWindowDraggable(`window-${sandbox.id}`);

    // Bind window controls
    const window = document.getElementById(`window-${sandbox.id}`);
    this.bringToFront(window);
    window.querySelector('[data-action="close"]').addEventListener('click', () => {
      this.closeSandbox(sandbox.id);
    });

    window.querySelector('[data-action="minimize"]').addEventListener('click', () => {
      window.classList.add('minimized');
    });

    window.querySelector('[data-action="maximize"]').addEventListener('click', () => {
      if (!window.classList.contains('maximized')) {
        window.dataset.prevLeft = window.style.left || '';
        window.dataset.prevTop = window.style.top || '';
        window.dataset.prevWidth = window.style.width || '';
        window.dataset.prevHeight = window.style.height || '';
        window.dataset.prevTransform = window.style.transform || '';
      } else {
        window.style.left = window.dataset.prevLeft || '';
        window.style.top = window.dataset.prevTop || '';
        window.style.width = window.dataset.prevWidth || '';
        window.style.height = window.dataset.prevHeight || '';
        window.style.transform = window.dataset.prevTransform || '';
      }
      window.classList.toggle('maximized');
      this.bringToFront(window);
    });

    window.addEventListener('mousedown', () => this.bringToFront(window));
  },

  makeWindowDraggable(windowId) {
    const window = document.getElementById(windowId);
    const header = window.querySelector('.sandbox-window-header');

    let isDragging = false;
    let currentX, currentY, initialX, initialY;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.sandbox-control')) return;

      isDragging = true;
      initialX = e.clientX - (window.offsetLeft || 0);
      initialY = e.clientY - (window.offsetTop || 0);
      window.style.transform = 'none';
      this.bringToFront(window);
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;

      window.style.left = currentX + 'px';
      window.style.top = currentY + 'px';
      window.style.position = 'fixed';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  },

  bringToFront(window) {
    if (!window) return;
    this.topZIndex += 1;
    window.style.zIndex = this.topZIndex.toString();
  },

  closeSandbox(sandboxId) {
    const window = document.getElementById(`window-${sandboxId}`);
    if (window) {
      window.remove();
    }

    this.activeSandboxes = this.activeSandboxes.filter(s => s.id !== sandboxId);
    this.updateSandboxList();
    this.saveSandboxes();
  },

  updateSandboxList() {
    const list = document.getElementById('sandbox-list');

    if (this.activeSandboxes.length === 0) {
      list.innerHTML = '<p class="empty-state">No active sandboxes. Create one to get started!</p>';
      return;
    }

    list.innerHTML = this.activeSandboxes.map(sandbox => `
      <div class="sandbox-item">
        <div class="sandbox-item-info">
          <i class="${this.templates[sandbox.type].icon}"></i>
          <span>${sandbox.name}</span>
        </div>
        <div class="sandbox-item-actions">
          <button class="btn-icon" data-action="show" data-sandbox-id="${sandbox.id}" title="Show">
            <i class="fas fa-eye"></i>
          </button>
          <button class="btn-icon" data-action="delete" data-sandbox-id="${sandbox.id}" title="Delete">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `).join('');

    // Bind actions
    list.querySelectorAll('[data-action="show"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sandboxId = e.currentTarget.dataset.sandboxId;
        const window = document.getElementById(`window-${sandboxId}`);
        if (window) {
          window.classList.remove('minimized');
          this.bringToFront(window);
        }
      });
    });

    list.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sandboxId = e.currentTarget.dataset.sandboxId;
        this.closeSandbox(sandboxId);
      });
    });
  },

  loadActiveSandboxes() {
    // Load from localStorage if available
    const saved = localStorage.getItem('aegis-sandboxes');
    if (saved) {
      try {
        this.activeSandboxes = JSON.parse(saved);
        this.updateSandboxList();
        this.restoreSandboxWindows();
      } catch (error) {
        console.warn('Failed to load sandboxes:', error);
      }
    }
  },

  restoreSandboxWindows() {
    this.activeSandboxes.forEach((sandbox) => {
      if (document.getElementById(`window-${sandbox.id}`)) return;
      let content = '';
      switch (sandbox.type) {
        case 'graphic':
          content = this.createGraphicSandbox(sandbox.id, sandbox.config || {});
          break;
        case 'code':
          content = this.createCodeSandbox(sandbox.id, sandbox.config || {});
          break;
        case 'api':
          content = this.createApiSandbox(sandbox.id, sandbox.config || {});
          break;
        case 'docker':
          content = this.createDockerSandbox(sandbox.id, sandbox.config || {});
          break;
        default:
          content = this.createGraphicSandbox(sandbox.id, sandbox.config || {});
          break;
      }
      this.renderSandboxWindow(sandbox, content);
    });
  },

  saveSandboxes() {
    localStorage.setItem('aegis-sandboxes', JSON.stringify(this.activeSandboxes));
  },

  open() {
    document.getElementById('sandbox-panel').classList.remove('hidden');
  },

  close() {
    document.getElementById('sandbox-panel').classList.add('hidden');
  },
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => SandboxBuilder.init());
} else {
  SandboxBuilder.init();
}
