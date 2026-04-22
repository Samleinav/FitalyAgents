export function renderCustomerDisplayHtml(deps: {
  storeId: string
  mode: 'order' | 'full'
}): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Customer Display</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1115;
        --panel: rgba(14, 24, 31, 0.92);
        --panel-soft: rgba(18, 31, 40, 0.86);
        --line: rgba(148, 196, 219, 0.16);
        --ink: #f4f8fb;
        --muted: #9db3c2;
        --accent: #f59e0b;
        --accent-soft: rgba(245, 158, 11, 0.18);
        --success: #34d399;
        --warning: #fbbf24;
        --danger: #fb7185;
        --radius: 30px;
        --shadow: 0 24px 60px rgba(0, 0, 0, 0.3);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Sora", "Avenir Next", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(245, 158, 11, 0.14), transparent 24%),
          radial-gradient(circle at top right, rgba(52, 211, 153, 0.12), transparent 26%),
          linear-gradient(180deg, #10191f 0%, #090e12 100%);
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
        background-size: 34px 34px;
        mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.45), transparent 85%);
      }

      .page {
        width: min(1440px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 36px;
      }

      .hero,
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        backdrop-filter: blur(16px);
      }

      .hero {
        padding: 24px 28px;
      }

      .hero-top {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
        margin-bottom: 20px;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        border-radius: 999px;
        border: 1px solid rgba(157, 179, 194, 0.14);
        background: rgba(255, 255, 255, 0.04);
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
      }

      .pulse {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--warning);
      }

      .pulse.online {
        background: var(--success);
        box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.36);
        animation: pulse 1.8s infinite;
      }

      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.36); }
        70% { box-shadow: 0 0 0 16px rgba(52, 211, 153, 0); }
        100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
      }

      h1 {
        margin: 0;
        font-size: clamp(42px, 6vw, 74px);
        line-height: 0.95;
        letter-spacing: -0.05em;
      }

      .hero-copy {
        display: grid;
        gap: 12px;
      }

      .hero-copy p {
        margin: 0;
        max-width: 880px;
        color: var(--muted);
        font-size: clamp(16px, 2vw, 20px);
        line-height: 1.55;
      }

      .layout {
        display: grid;
        grid-template-columns: 1.3fr 0.9fr;
        gap: 18px;
        margin-top: 18px;
      }

      .column {
        display: grid;
        gap: 18px;
      }

      .card {
        padding: 22px;
      }

      .section-title {
        margin: 0 0 6px;
        font-size: 28px;
        letter-spacing: -0.04em;
      }

      .section-subtitle {
        margin: 0 0 18px;
        color: var(--muted);
        font-size: 15px;
      }

      .summary-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
      }

      .summary-box {
        padding: 16px;
        border-radius: 22px;
        background: var(--panel-soft);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .summary-label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
      }

      .summary-value {
        margin-top: 8px;
        font-size: clamp(24px, 3vw, 38px);
        line-height: 1;
        letter-spacing: -0.04em;
      }

      .status-pill,
      .change-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 14px;
        font-weight: 700;
      }

      .status-pill.waiting,
      .change-pill.updated {
        background: rgba(245, 158, 11, 0.16);
        color: var(--warning);
      }

      .status-pill.approved,
      .status-pill.printed,
      .change-pill.added {
        background: rgba(52, 211, 153, 0.16);
        color: var(--success);
      }

      .status-pill.rejected,
      .status-pill.timeout,
      .status-pill.declined,
      .change-pill.removed {
        background: rgba(251, 113, 133, 0.16);
        color: var(--danger);
      }

      .message-box {
        padding: 22px;
        border-radius: 24px;
        background: linear-gradient(135deg, rgba(245, 158, 11, 0.14), rgba(255, 255, 255, 0.04));
        border: 1px solid rgba(245, 158, 11, 0.12);
      }

      .message-box.success {
        background: linear-gradient(135deg, rgba(52, 211, 153, 0.14), rgba(255, 255, 255, 0.04));
        border-color: rgba(52, 211, 153, 0.12);
      }

      .message-box.warning {
        background: linear-gradient(135deg, rgba(251, 191, 36, 0.14), rgba(255, 255, 255, 0.04));
      }

      .message-title {
        margin: 0 0 10px;
        font-size: 24px;
        letter-spacing: -0.04em;
      }

      .message-body {
        margin: 0;
        color: var(--ink);
        font-size: clamp(18px, 2.4vw, 28px);
        line-height: 1.4;
      }

      .list {
        display: grid;
        gap: 14px;
      }

      .line-item {
        display: grid;
        grid-template-columns: 1.6fr 0.4fr 0.6fr 0.6fr;
        gap: 12px;
        align-items: center;
        padding: 16px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.05);
      }

      .line-main strong {
        display: block;
        font-size: 20px;
        letter-spacing: -0.03em;
      }

      .line-main span,
      .line-meta {
        color: var(--muted);
        font-size: 14px;
      }

      .right {
        text-align: right;
      }

      .totals {
        display: grid;
        gap: 12px;
      }

      .total-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        font-size: 18px;
      }

      .total-row strong {
        font-size: 24px;
        letter-spacing: -0.04em;
      }

      .change-list,
      .suggestion-list {
        display: grid;
        gap: 12px;
      }

      .suggestion-item,
      .change-item {
        padding: 16px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.05);
      }

      .suggestion-item strong,
      .change-item strong {
        display: block;
        margin-bottom: 8px;
        font-size: 18px;
      }

      .empty-state {
        padding: 18px;
        border-radius: 20px;
        border: 1px dashed rgba(157, 179, 194, 0.24);
        color: var(--muted);
        background: rgba(255, 255, 255, 0.03);
        font-size: 16px;
      }

      .mono {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      }

      @media (max-width: 1100px) {
        .layout {
          grid-template-columns: 1fr;
        }

        .summary-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 720px) {
        .page {
          width: min(100vw - 18px, 100%);
          padding-top: 16px;
        }

        .summary-grid {
          grid-template-columns: 1fr;
        }

        .line-item {
          grid-template-columns: 1fr;
        }

        .right {
          text-align: left;
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
            <span id="connection-label">Conectando…</span>
          </div>
          <div class="eyebrow mono">Store: <span id="store-id">${escapeHtml(deps.storeId)}</span></div>
        </div>
        <div class="hero-copy">
          <h1>Pantalla Cliente</h1>
          <p>
            Segunda pantalla para mostrar pedido, totales, pago, mensajes y aprobaciones visibles
            al cliente. Modo activo: <strong>${escapeHtml(deps.mode)}</strong>.
          </p>
        </div>
      </section>

      <section class="layout">
        <div class="column">
          <article class="card">
            <h2 class="section-title">Pedido Actual</h2>
            <p class="section-subtitle">Líneas activas de la orden y cambios recientes.</p>
            <div class="summary-grid">
              <div class="summary-box">
                <div class="summary-label">Estado</div>
                <div class="summary-value" id="order-status">-</div>
              </div>
              <div class="summary-box">
                <div class="summary-label">Pago</div>
                <div class="summary-value" id="payment-status">-</div>
              </div>
              <div class="summary-box">
                <div class="summary-label">Receipt</div>
                <div class="summary-value" id="receipt-status">-</div>
              </div>
              <div class="summary-box">
                <div class="summary-label">Aprobación</div>
                <div class="summary-value" id="approval-status">-</div>
              </div>
            </div>
            <div id="message-slot" style="margin-top: 18px;"></div>
            <div id="line-items" class="list" style="margin-top: 18px;"></div>
          </article>
        </div>

        <div class="column">
          <article class="card">
            <h2 class="section-title">Totales</h2>
            <p class="section-subtitle">Resumen económico visible para el cliente.</p>
            <div id="totals-slot" class="totals"></div>
          </article>

          <article class="card">
            <h2 class="section-title">Cambios</h2>
            <p class="section-subtitle">Productos añadidos, retirados o ajustados recientemente.</p>
            <div id="changes-slot" class="change-list"></div>
          </article>

          <article class="card">
            <h2 class="section-title">Sugerencias</h2>
            <p class="section-subtitle">Productos o bundles que la tienda está mostrando ahora.</p>
            <div id="suggestions-slot" class="suggestion-list"></div>
          </article>
        </div>
      </section>
    </main>

    <script>
      const displayMode = '${escapeJs(deps.mode)}';
      const app = {
        state: null,
        connected: false,
      };

      const elements = {
        connectionDot: document.getElementById('connection-dot'),
        connectionLabel: document.getElementById('connection-label'),
        storeId: document.getElementById('store-id'),
        orderStatus: document.getElementById('order-status'),
        paymentStatus: document.getElementById('payment-status'),
        receiptStatus: document.getElementById('receipt-status'),
        approvalStatus: document.getElementById('approval-status'),
        messageSlot: document.getElementById('message-slot'),
        lineItems: document.getElementById('line-items'),
        totalsSlot: document.getElementById('totals-slot'),
        changesSlot: document.getElementById('changes-slot'),
        suggestionsSlot: document.getElementById('suggestions-slot'),
      };

      bootstrap().catch((error) => {
        console.error('[customer-display] bootstrap failed', error);
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

        source.addEventListener('customer_display_state', (event) => {
          app.state = JSON.parse(event.data);
          render();
        });
      }

      function render() {
        renderConnection();
        renderSummary();
        renderMessage();
        renderItems();
        renderTotals();
        renderChanges();
        renderSuggestions();
      }

      function renderConnection() {
        elements.connectionDot.className = app.connected ? 'pulse online' : 'pulse';
        elements.connectionLabel.textContent = app.connected
          ? 'Pantalla conectada'
          : 'Esperando stream SSE';
      }

      function renderSummary() {
        const state = app.state;
        if (!state) {
          return;
        }

        elements.storeId.textContent = state.storeId || '${escapeJs(deps.storeId)}';
        elements.orderStatus.innerHTML = renderStatusPill(labelForOrderStatus(state.order.status), state.order.status);
        elements.paymentStatus.innerHTML = renderStatusPill(labelForPaymentStatus(state.order.paymentStatus), state.order.paymentStatus);
        elements.receiptStatus.innerHTML = renderStatusPill(labelForReceiptStatus(state.order.receiptStatus), state.order.receiptStatus);
        elements.approvalStatus.innerHTML = renderStatusPill(labelForApprovalStatus(state.order.approvalStatus), state.order.approvalStatus);
      }

      function renderMessage() {
        const state = app.state;
        if (!state || !state.message) {
          elements.messageSlot.innerHTML = emptyState('Aquí aparecerán mensajes claros para el cliente.');
          return;
        }

        elements.messageSlot.innerHTML = \`
          <div class="message-box \${escapeHtml(state.message.tone)}">
            <h3 class="message-title">\${escapeHtml(state.message.title)}</h3>
            <p class="message-body">\${escapeHtml(state.message.body)}</p>
          </div>
        \`;
      }

      function renderItems() {
        const state = app.state;
        if (!state || state.order.items.length === 0) {
          elements.lineItems.innerHTML = emptyState('Todavía no hay productos en pantalla.');
          return;
        }

        elements.lineItems.innerHTML = state.order.items
          .map((item) => {
            return \`
              <article class="line-item">
                <div class="line-main">
                  <strong>\${escapeHtml(item.name)}</strong>
                  <span class="mono">\${escapeHtml(item.productId)}</span>
                </div>
                <div class="line-meta">\${escapeHtml(String(item.quantity))} uds.</div>
                <div class="line-meta right">\${formatCurrency(item.unitPrice)}</div>
                <div class="line-meta right"><strong>\${formatCurrency(item.lineTotal)}</strong></div>
              </article>
            \`;
          })
          .join('');
      }

      function renderTotals() {
        const state = app.state;
        if (!state) {
          return;
        }

        const rows = [
          ['Subtotal', formatCurrency(state.order.subtotal)],
        ];

        if (displayMode === 'full') {
          rows.push(['Impuestos', formatCurrency(state.order.tax)]);
          rows.push(['Descuentos', formatCurrency(state.order.discount)]);
        }

        rows.push(['Total', formatCurrency(state.order.total)]);

        if (state.order.paymentMethod) {
          rows.push(['Método', escapeHtml(state.order.paymentMethod)]);
        }

        elements.totalsSlot.innerHTML = rows
          .map(([label, value], index) => {
            const strong = index === rows.length - 1 ? '<strong>' + value + '</strong>' : value;
            return \`
              <div class="total-row">
                <span>\${escapeHtml(label)}</span>
                <span>\${strong}</span>
              </div>
            \`;
          })
          .join('');
      }

      function renderChanges() {
        const state = app.state;
        if (!state || state.order.recentChanges.length === 0) {
          elements.changesSlot.innerHTML = emptyState('Los cambios recientes del pedido aparecerán aquí.');
          return;
        }

        elements.changesSlot.innerHTML = state.order.recentChanges
          .map((change) => {
            return \`
              <article class="change-item">
                <strong>\${escapeHtml(change.label)}</strong>
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
                  <span class="mono">\${escapeHtml(String(change.quantity))} uds.</span>
                  <span class="change-pill \${escapeHtml(change.type)}">\${escapeHtml(labelForChange(change.type))}</span>
                </div>
              </article>
            \`;
          })
          .join('');
      }

      function renderSuggestions() {
        const state = app.state;
        if (!state || state.suggestions.length === 0) {
          elements.suggestionsSlot.innerHTML = emptyState('Cuando haya sugerencias o bundles, se mostrarán aquí.');
          return;
        }

        elements.suggestionsSlot.innerHTML = state.suggestions
          .map((product) => {
            return \`
              <article class="suggestion-item">
                <strong>\${escapeHtml(product.name)}</strong>
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
                  <span>\${escapeHtml(product.description || 'Producto recomendado')}</span>
                  <span class="mono">\${formatCurrency(product.price)}</span>
                </div>
              </article>
            \`;
          })
          .join('');
      }

      function renderStatusPill(label, status) {
        return \`<span class="status-pill \${escapeHtml(status || 'idle')}">\${escapeHtml(label)}</span>\`;
      }

      function labelForOrderStatus(status) {
        switch (status) {
          case 'draft':
            return 'borrador';
          case 'open':
            return 'abierta';
          case 'confirmed':
            return 'confirmada';
          default:
            return 'sin orden';
        }
      }

      function labelForPaymentStatus(status) {
        switch (status) {
          case 'waiting':
            return 'esperando';
          case 'processing':
            return 'procesando';
          case 'approved':
            return 'aprobado';
          case 'declined':
            return 'rechazado';
          default:
            return 'sin pago';
        }
      }

      function labelForReceiptStatus(status) {
        switch (status) {
          case 'printed':
            return 'impreso';
          default:
            return 'pendiente';
        }
      }

      function labelForApprovalStatus(status) {
        switch (status) {
          case 'waiting':
            return 'esperando';
          case 'approved':
            return 'aprobada';
          case 'rejected':
            return 'rechazada';
          case 'timeout':
            return 'expirada';
          default:
            return 'sin espera';
        }
      }

      function labelForChange(type) {
        switch (type) {
          case 'added':
            return 'añadido';
          case 'removed':
            return 'retirado';
          default:
            return 'actualizado';
        }
      }

      function formatCurrency(value) {
        return new Intl.NumberFormat('es-ES', {
          style: 'currency',
          currency: 'USD',
        }).format(Number(value || 0));
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
