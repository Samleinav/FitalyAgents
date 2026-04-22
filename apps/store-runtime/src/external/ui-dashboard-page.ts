export function renderUiDashboardHtml(deps: { storeId: string }): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Store Runtime Console</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe6;
        --panel: rgba(255, 252, 246, 0.88);
        --panel-strong: #fffaf0;
        --line: rgba(28, 54, 79, 0.12);
        --ink: #17324a;
        --muted: #627688;
        --accent: #c05621;
        --accent-soft: rgba(192, 86, 33, 0.12);
        --ok: #1f7a5a;
        --warn: #b06b1b;
        --danger: #b33434;
        --shadow: 0 18px 48px rgba(29, 47, 61, 0.12);
        --radius: 24px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(192, 86, 33, 0.16), transparent 28%),
          radial-gradient(circle at top right, rgba(31, 122, 90, 0.12), transparent 24%),
          linear-gradient(180deg, #faf6ee 0%, #f2eadc 100%);
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(23, 50, 74, 0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(23, 50, 74, 0.03) 1px, transparent 1px);
        background-size: 28px 28px;
        mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.4), transparent 82%);
      }

      .page {
        width: min(1380px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }

      .hero {
        display: grid;
        gap: 14px;
        margin-bottom: 22px;
      }

      .hero-top {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.55);
        border: 1px solid rgba(23, 50, 74, 0.08);
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .pulse {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--warn);
        box-shadow: 0 0 0 0 rgba(176, 107, 27, 0.35);
      }

      .pulse.online {
        background: var(--ok);
        box-shadow: 0 0 0 0 rgba(31, 122, 90, 0.35);
        animation: pulse 1.8s infinite;
      }

      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(31, 122, 90, 0.36); }
        70% { box-shadow: 0 0 0 14px rgba(31, 122, 90, 0); }
        100% { box-shadow: 0 0 0 0 rgba(31, 122, 90, 0); }
      }

      h1 {
        margin: 0;
        font-size: clamp(30px, 5vw, 54px);
        line-height: 0.95;
        letter-spacing: -0.04em;
      }

      .hero p {
        margin: 0;
        max-width: 780px;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.6;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 14px;
      }

      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        backdrop-filter: blur(16px);
      }

      .stat {
        padding: 18px 20px;
      }

      .stat-label {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .stat-value {
        margin-top: 8px;
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.04em;
      }

      .layout {
        display: grid;
        grid-template-columns: 1.4fr 0.9fr;
        gap: 18px;
        margin-top: 18px;
      }

      .panel {
        padding: 22px;
      }

      .panel h2 {
        margin: 0 0 6px;
        font-size: 22px;
        letter-spacing: -0.03em;
      }

      .panel-subtitle {
        margin: 0 0 18px;
        color: var(--muted);
        font-size: 14px;
      }

      .queue-grid,
      .component-grid {
        display: grid;
        gap: 14px;
      }

      .queue-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .queue-box {
        padding: 16px;
        border-radius: 18px;
        background: var(--panel-strong);
        border: 1px solid var(--line);
      }

      .queue-box strong,
      .component-box strong {
        display: block;
        margin-bottom: 8px;
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .primary-pill {
        display: inline-flex;
        align-items: center;
        padding: 8px 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 700;
      }

      .chip-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        border-radius: 999px;
        background: rgba(23, 50, 74, 0.06);
        color: var(--ink);
        font-size: 13px;
      }

      .transcript-list,
      .event-list {
        display: grid;
        gap: 14px;
      }

      .turn {
        padding: 16px;
        border-radius: 20px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.72);
      }

      .turn-top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
        font-size: 13px;
        color: var(--muted);
      }

      .turn-copy {
        display: grid;
        gap: 10px;
      }

      .bubble {
        padding: 12px 14px;
        border-radius: 16px;
        line-height: 1.55;
        font-size: 14px;
      }

      .bubble.user {
        background: rgba(23, 50, 74, 0.08);
      }

      .bubble.assistant {
        background: rgba(31, 122, 90, 0.1);
      }

      .bubble.empty {
        color: var(--muted);
        font-style: italic;
      }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        background: rgba(23, 50, 74, 0.06);
      }

      .status.responding { color: var(--accent); }
      .status.completed { color: var(--ok); }
      .status.error { color: var(--danger); }

      .component-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .component-box {
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.68);
      }

      .component-body {
        font-size: 14px;
        line-height: 1.55;
        color: var(--ink);
      }

      .component-body code {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: 12px;
      }

      .mono {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      }

      .empty-state {
        padding: 18px;
        border-radius: 18px;
        border: 1px dashed rgba(23, 50, 74, 0.22);
        color: var(--muted);
        background: rgba(255, 255, 255, 0.45);
      }

      .event-item {
        display: grid;
        gap: 6px;
        padding: 14px 0;
        border-bottom: 1px solid rgba(23, 50, 74, 0.08);
      }

      .event-item:last-child {
        border-bottom: 0;
        padding-bottom: 0;
      }

      .event-label {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 13px;
        color: var(--muted);
      }

      .event-summary {
        font-size: 14px;
        line-height: 1.5;
      }

      @media (max-width: 1100px) {
        .layout {
          grid-template-columns: 1fr;
        }

        .stats,
        .queue-grid,
        .component-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 720px) {
        .page {
          width: min(100vw - 18px, 100%);
          padding-top: 16px;
        }

        .stats,
        .queue-grid,
        .component-grid {
          grid-template-columns: 1fr;
        }

        .panel {
          padding: 18px;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <div class="hero-top">
          <div class="eyebrow">
            <span id="connection-dot" class="pulse"></span>
            <span id="connection-label">Conectando a /events…</span>
          </div>
          <div class="eyebrow mono">Store: <span id="store-id">${escapeHtml(deps.storeId)}</span></div>
        </div>
        <div>
          <h1>Store Runtime Console</h1>
          <p>
            Vista externa para seguir el target group, la transcripción viva, la respuesta del
            asistente y los paneles operativos emitidos por el runtime sobre Redis.
          </p>
        </div>
        <div class="stats">
          <article class="card stat">
            <div class="stat-label">Cliente Primario</div>
            <div class="stat-value mono" id="stat-primary">-</div>
          </article>
          <article class="card stat">
            <div class="stat-label">En Cola</div>
            <div class="stat-value mono" id="stat-queued">0</div>
          </article>
          <article class="card stat">
            <div class="stat-label">Turnos Vistos</div>
            <div class="stat-value mono" id="stat-turns">0</div>
          </article>
          <article class="card stat">
            <div class="stat-label">Aprobaciones Pendientes</div>
            <div class="stat-value mono" id="stat-approvals">0</div>
          </article>
          <article class="card stat">
            <div class="stat-label">Última Actualización</div>
            <div class="stat-value mono" id="stat-updated">-</div>
          </article>
        </div>
      </section>

      <section class="layout">
        <div class="left-column">
          <article class="card panel">
            <h2>Target Group</h2>
            <p class="panel-subtitle">A quién atiende ahora el runtime y quién queda esperando.</p>
            <div class="queue-grid">
              <div class="queue-box">
                <strong>Primary</strong>
                <div id="primary-slot" class="primary-pill">Sin cliente</div>
              </div>
              <div class="queue-box">
                <strong>Queued</strong>
                <div id="queued-slot" class="chip-list"></div>
              </div>
              <div class="queue-box">
                <strong>Ambient</strong>
                <div id="ambient-slot" class="chip-list"></div>
              </div>
            </div>
          </article>

          <article class="card panel" style="margin-top: 18px;">
            <h2>Conversación</h2>
            <p class="panel-subtitle">
              Transcripción del cliente y texto emitido por el asistente, ya normalizado por el bridge.
            </p>
            <div id="transcript-list" class="transcript-list"></div>
          </article>
        </div>

        <div class="right-column">
          <article class="card panel">
            <h2>Aprobaciones</h2>
            <p class="panel-subtitle">Solicitudes restringidas en cola y última resolución recibida.</p>
            <div id="approval-list" class="event-list"></div>
          </article>

          <article class="card panel" style="margin-top: 18px;">
            <h2>Paneles Operativos</h2>
            <p class="panel-subtitle">Estado actual de los componentes emitidos por <code>bus:UI_UPDATE</code>.</p>
            <div id="component-grid" class="component-grid"></div>
          </article>

          <article class="card panel" style="margin-top: 18px;">
            <h2>Timeline</h2>
            <p class="panel-subtitle">Últimos eventos relevantes procesados por la UI externa.</p>
            <div id="event-list" class="event-list"></div>
          </article>
        </div>
      </section>
    </main>

    <script>
      const app = {
        state: null,
        connected: false,
      };

      const elements = {
        connectionDot: document.getElementById('connection-dot'),
        connectionLabel: document.getElementById('connection-label'),
        storeId: document.getElementById('store-id'),
        statPrimary: document.getElementById('stat-primary'),
        statQueued: document.getElementById('stat-queued'),
        statTurns: document.getElementById('stat-turns'),
        statApprovals: document.getElementById('stat-approvals'),
        statUpdated: document.getElementById('stat-updated'),
        primarySlot: document.getElementById('primary-slot'),
        queuedSlot: document.getElementById('queued-slot'),
        ambientSlot: document.getElementById('ambient-slot'),
        approvalList: document.getElementById('approval-list'),
        transcriptList: document.getElementById('transcript-list'),
        componentGrid: document.getElementById('component-grid'),
        eventList: document.getElementById('event-list'),
      };

      bootstrap().catch((error) => {
        console.error('[store-ui-bridge] UI bootstrap failed', error);
        elements.connectionLabel.textContent = 'No se pudo cargar /state';
      });

      async function bootstrap() {
        const response = await fetch('/state', { headers: { accept: 'application/json' } });
        if (!response.ok) {
          throw new Error('state request failed');
        }
        app.state = await response.json();
        render();
        connect();
      }

      function connect() {
        const source = new EventSource('/events');

        source.addEventListener('open', () => {
          app.connected = true;
          renderConnection();
        });

        source.addEventListener('error', () => {
          app.connected = false;
          renderConnection();
        });

        source.addEventListener('dashboard_state', (event) => {
          app.state = JSON.parse(event.data);
          render();
        });
      }

      function render() {
        renderConnection();
        renderStats();
        renderQueue();
        renderApprovals();
        renderTranscript();
        renderComponents();
        renderEvents();
      }

      function renderConnection() {
        elements.connectionDot.className = app.connected ? 'pulse online' : 'pulse';
        elements.connectionLabel.textContent = app.connected
          ? 'Conectado a /events'
          : 'Esperando stream SSE';
      }

      function renderStats() {
        const state = app.state;
        if (!state) {
          return;
        }

        elements.storeId.textContent = state.storeId || '${escapeJs(deps.storeId)}';
        elements.statPrimary.textContent = state.queue.primary || 'Sin cliente';
        elements.statQueued.textContent = String(state.queue.queued.length);
        elements.statTurns.textContent = String(state.transcript.turns.length);
        elements.statApprovals.textContent = String(state.approvals.pending.length);
        elements.statUpdated.textContent = state.updatedAt ? formatTime(state.updatedAt) : '-';
      }

      function renderQueue() {
        const state = app.state;
        if (!state) {
          return;
        }

        elements.primarySlot.textContent = state.queue.primary || 'Sin cliente';
        elements.queuedSlot.innerHTML = renderChipList(state.queue.queued, 'Nadie en cola');
        elements.ambientSlot.innerHTML = renderChipList(state.queue.ambient, 'Sin ambiente');
      }

      function renderApprovals() {
        const state = app.state;
        if (!state) {
          return;
        }

        const sections = [];

        if (state.approvals.pending.length > 0) {
          sections.push(
            state.approvals.pending
              .map((entry) => {
                return \`
                  <article class="event-item">
                    <div class="event-label">
                      <span class="mono">\${escapeHtml(entry.requestId)}</span>
                      <span>\${formatTime(entry.queuedAt)}</span>
                    </div>
                    <div class="event-summary">
                      Esperando aprobador con rol <strong>\${escapeHtml(entry.requiredRole || 'manager')}</strong>
                      para sesión <span class="mono">\${escapeHtml(entry.sessionId || 'sin sesión')}</span>.
                    </div>
                  </article>
                \`;
              })
              .join('')
          );
        }

        if (state.approvals.lastResolved) {
          const resolved = state.approvals.lastResolved;
          sections.push(\`
            <article class="event-item">
              <div class="event-label">
                <span class="mono">\${escapeHtml(resolved.requestId)}</span>
                <span>\${formatTime(resolved.resolvedAt)}</span>
              </div>
              <div class="event-summary">
                Última resolución: <strong>\${escapeHtml(resolved.approved ? 'aprobada' : 'rechazada')}</strong>
                por <span class="mono">\${escapeHtml(resolved.approverId || 'sin aprobador')}</span>.
              </div>
            </article>
          \`);
        }

        if (sections.length === 0) {
          const timeoutNote = state.approvals.timeoutCount > 0
            ? ' También hubo expiraciones recientes.'
            : '';
          elements.approvalList.innerHTML = emptyState(
            'No hay aprobaciones pendientes ni resoluciones recientes.' + timeoutNote
          );
          return;
        }

        elements.approvalList.innerHTML = sections.join('');
      }

      function renderTranscript() {
        const state = app.state;
        if (!state) {
          return;
        }

        const turns = [...state.transcript.turns].reverse();
        if (turns.length === 0) {
          elements.transcriptList.innerHTML = emptyState(
            'Todavía no hay transcripción. Cuando llegue un SPEECH_FINAL, aparecerá aquí.'
          );
          return;
        }

        elements.transcriptList.innerHTML = turns
          .map((turn) => {
            const speaker = turn.speakerId || 'desconocido';
            const statusClass = escapeHtml(turn.status);
            return \`
              <article class="turn">
                <div class="turn-top">
                  <span class="mono">\${escapeHtml(turn.sessionId)}</span>
                  <span class="status \${statusClass}">\${escapeHtml(labelForStatus(turn.status))}</span>
                </div>
                <div class="turn-copy">
                  <div class="bubble user"><strong>\${escapeHtml(speaker)}</strong><br />\${escapeHtml(turn.userText || 'Sin texto de cliente')}</div>
                  <div class="bubble assistant \${turn.assistantText ? '' : 'empty'}">\${escapeHtml(turn.assistantText || 'Esperando respuesta del asistente…')}</div>
                </div>
              </article>
            \`;
          })
          .join('');
      }

      function renderComponents() {
        const state = app.state;
        if (!state) {
          return;
        }

        const components = Object.values(state.components)
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, 6);

        if (components.length === 0) {
          elements.componentGrid.innerHTML = emptyState(
            'La UI todavía no recibió paneles operativos. Cuando UIAgent publique bus:UI_UPDATE, aparecerán aquí.'
          );
          return;
        }

        elements.componentGrid.innerHTML = components
          .map((component) => {
            return \`
              <article class="component-box">
                <strong>\${escapeHtml(component.component)}</strong>
                <div class="component-body">
                  <div style="margin-bottom: 8px;">
                    <span class="status \${component.visible ? 'completed' : ''}">\${escapeHtml(component.action)}</span>
                  </div>
                  <div>\${renderComponentBody(component)}</div>
                </div>
              </article>
            \`;
          })
          .join('');
      }

      function renderEvents() {
        const state = app.state;
        if (!state) {
          return;
        }

        const events = [...state.recentEvents].reverse().slice(0, 14);
        if (events.length === 0) {
          elements.eventList.innerHTML = emptyState('Sin eventos recientes todavía.');
          return;
        }

        elements.eventList.innerHTML = events
          .map((entry) => {
            return \`
              <article class="event-item">
                <div class="event-label">
                  <span class="mono">\${escapeHtml(entry.channel)}</span>
                  <span>\${formatTime(entry.timestamp)}</span>
                </div>
                <div class="event-summary">\${escapeHtml(entry.summary)}</div>
              </article>
            \`;
          })
          .join('');
      }

      function renderChipList(values, fallback) {
        if (!Array.isArray(values) || values.length === 0) {
          return emptyState(fallback);
        }

        return values
          .map((value) => \`<span class="chip mono">\${escapeHtml(String(value))}</span>\`)
          .join('');
      }

      function renderComponentBody(component) {
        const data = component.data;
        if (!data || typeof data !== 'object') {
          return '<span class="mono">sin payload</span>';
        }

        if (component.component === 'product_grid' && Array.isArray(data.results)) {
          return data.results
            .slice(0, 4)
            .map((item) => \`<div class="mono">\${escapeHtml(JSON.stringify(item))}</div>\`)
            .join('');
        }

        if (component.component === 'order_panel' && data.summary) {
          return \`<div class="mono">\${escapeHtml(JSON.stringify(data.summary))}</div>\`;
        }

        return \`<code>\${escapeHtml(JSON.stringify(data, null, 2))}</code>\`;
      }

      function labelForStatus(status) {
        switch (status) {
          case 'heard':
            return 'escuchado';
          case 'responding':
            return 'respondiendo';
          case 'completed':
            return 'cerrado';
          case 'error':
            return 'error';
          default:
            return status;
        }
      }

      function formatTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      }

      function emptyState(message) {
        return \`<div class="empty-state">\${escapeHtml(message)}</div>\`;
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }
    </script>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeJs(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}
