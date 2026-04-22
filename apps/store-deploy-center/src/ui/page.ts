export function renderDeployCenterHtml(args: { projectName: string }): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(args.projectName)}</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --cream: #f7f2ea;
      --cream-deep: #ede6d9;
      --cream-border: #d9cfbe;
      --ink: #2a2118;
      --ink-soft: #8a7a66;
      --amber: #c97d2a;
      --amber-soft: rgba(201,125,42,.12);
      --sage: #5a7a5e;
      --sage-soft: #c8dec9;
      --rust: #c25a3a;
      --rust-soft: #f5d8ce;
      --sky: #3a6a8a;
      --sky-soft: #c8def0;
      --panel: #fffdf7;
      --radius: 14px;
      --shadow: 0 12px 40px rgba(42,33,24,.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Syne', sans-serif;
      background:
        radial-gradient(circle at top right, rgba(201,125,42,.12), transparent 28%),
        linear-gradient(180deg, #fbf7ef 0%, var(--cream) 100%);
      color: var(--ink);
      min-height: 100vh;
    }
    .shell {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      min-height: 100vh;
    }
    .sidebar {
      background: rgba(255,253,247,.9);
      border-right: 1px solid var(--cream-border);
      padding: 24px 18px;
      backdrop-filter: blur(10px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .brand-mark {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      background: var(--ink);
      color: var(--cream);
      display: grid;
      place-items: center;
      font-family: 'DM Serif Display', serif;
      font-size: 20px;
    }
    .brand-copy h1 {
      margin: 0;
      font-family: 'DM Serif Display', serif;
      font-size: 22px;
      line-height: 1;
    }
    .brand-copy p {
      margin: 5px 0 0;
      color: var(--ink-soft);
      font-size: 12px;
      font-family: 'DM Mono', monospace;
    }
    .section-label {
      margin: 20px 0 10px;
      color: var(--ink-soft);
      font-size: 11px;
      letter-spacing: .16em;
      text-transform: uppercase;
      font-weight: 700;
    }
    .service-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .service-item {
      border: 1px solid var(--cream-border);
      border-radius: 12px;
      background: var(--panel);
      padding: 12px;
      box-shadow: 0 4px 18px rgba(42,33,24,.05);
    }
    .service-title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 6px;
    }
    .service-title strong {
      font-size: 13px;
    }
    .status-pill {
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 10px;
      font-family: 'DM Mono', monospace;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .status-running { background: var(--sage-soft); color: var(--sage); }
    .status-down { background: var(--rust-soft); color: var(--rust); }
    .status-unverified { background: var(--sky-soft); color: var(--sky); }
    .status-disabled { background: var(--cream-deep); color: var(--ink-soft); }
    .service-meta {
      font-size: 11px;
      color: var(--ink-soft);
      font-family: 'DM Mono', monospace;
    }
    .main {
      padding: 26px 28px 28px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      background: rgba(255,253,247,.82);
      border: 1px solid var(--cream-border);
      border-radius: 18px;
      padding: 18px 20px;
      box-shadow: var(--shadow);
    }
    .topbar h2 {
      margin: 0;
      font-family: 'DM Serif Display', serif;
      font-size: 30px;
      line-height: 1;
    }
    .topbar p {
      margin: 8px 0 0;
      color: var(--ink-soft);
      font-size: 13px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: flex-end;
    }
    button, select, input {
      font: inherit;
    }
    .btn {
      border: none;
      border-radius: 12px;
      padding: 11px 15px;
      font-weight: 700;
      cursor: pointer;
      transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
    }
    .btn:hover {
      transform: translateY(-1px);
    }
    .btn-amber {
      background: var(--amber);
      color: white;
      box-shadow: 0 10px 22px rgba(201,125,42,.22);
    }
    .btn-ghost {
      background: transparent;
      color: var(--ink);
      border: 1px solid var(--cream-border);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 18px;
    }
    .card {
      grid-column: span 12;
      background: rgba(255,253,247,.88);
      border: 1px solid var(--cream-border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: var(--shadow);
    }
    .card h3 {
      margin: 0 0 14px;
      font-size: 12px;
      letter-spacing: .18em;
      text-transform: uppercase;
      color: var(--ink-soft);
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .metric {
      border: 1px solid var(--cream-border);
      border-radius: 14px;
      background: white;
      padding: 14px;
    }
    .metric span {
      display: block;
      color: var(--ink-soft);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .12em;
      margin-bottom: 8px;
    }
    .metric strong {
      font-size: 28px;
      font-family: 'DM Serif Display', serif;
      font-weight: 400;
    }
    .wizard-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(280px, .9fr);
      gap: 16px;
      align-items: start;
    }
    .wizard-steps {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .wizard-step {
      border: 1px solid var(--cream-border);
      border-radius: 16px;
      background: white;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 184px;
    }
    .wizard-step.step-done {
      border-color: rgba(90,122,94,.32);
      box-shadow: 0 8px 24px rgba(90,122,94,.08);
    }
    .wizard-step.step-active {
      border-color: rgba(201,125,42,.35);
      box-shadow: 0 8px 24px rgba(201,125,42,.08);
    }
    .wizard-step.step-pending {
      border-style: dashed;
    }
    .wizard-step-head {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 12px;
    }
    .wizard-step-index {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 40px;
      height: 40px;
      border-radius: 12px;
      background: var(--cream-deep);
      color: var(--ink);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .08em;
      font-family: 'DM Mono', monospace;
    }
    .wizard-step-title {
      margin: 0;
      font-size: 18px;
      font-family: 'DM Serif Display', serif;
      font-weight: 400;
    }
    .wizard-step-copy {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .wizard-step-detail {
      color: var(--ink-soft);
      font-size: 13px;
      line-height: 1.5;
    }
    .wizard-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 10px;
      font-family: 'DM Mono', monospace;
      text-transform: uppercase;
      letter-spacing: .08em;
      font-weight: 700;
      white-space: nowrap;
    }
    .wizard-status-done {
      background: var(--sage-soft);
      color: var(--sage);
    }
    .wizard-status-active {
      background: var(--amber-soft);
      color: var(--amber);
    }
    .wizard-status-pending {
      background: var(--cream-deep);
      color: var(--ink-soft);
    }
    .wizard-panel {
      border: 1px solid var(--cream-border);
      border-radius: 16px;
      background: white;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 100%;
    }
    .wizard-panel p {
      margin: 0;
      color: var(--ink-soft);
      font-size: 13px;
      line-height: 1.6;
    }
    .preset-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .preset-card {
      border: 1px solid var(--cream-border);
      border-radius: 16px;
      background: white;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 220px;
    }
    .preset-card h4 {
      margin: 0;
      font-size: 18px;
      font-family: 'DM Serif Display', serif;
      font-weight: 400;
    }
    .preset-card p {
      margin: 0;
      color: var(--ink-soft);
      font-size: 13px;
      line-height: 1.5;
    }
    .preset-summary {
      color: var(--ink);
      font-size: 13px;
      font-weight: 600;
      line-height: 1.5;
    }
    .preset-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .preset-badge {
      border-radius: 999px;
      padding: 4px 9px;
      background: var(--cream-deep);
      border: 1px solid var(--cream-border);
      color: var(--ink-soft);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      font-family: 'DM Mono', monospace;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .field label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--ink-soft);
    }
    .field input, .field select, .field textarea {
      width: 100%;
      border: 1px solid var(--cream-border);
      border-radius: 12px;
      padding: 11px 12px;
      background: white;
      color: var(--ink);
    }
    .field textarea {
      min-height: 170px;
      resize: vertical;
      font-family: 'DM Mono', monospace;
      line-height: 1.5;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .result {
      margin-top: 14px;
      border-radius: 14px;
      border: 1px solid var(--cream-border);
      background: #fff;
      padding: 14px;
      font-family: 'DM Mono', monospace;
      font-size: 12px;
      white-space: pre-wrap;
      min-height: 72px;
      color: var(--ink-soft);
    }
    .env-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .env-item {
      border: 1px solid var(--cream-border);
      border-radius: 14px;
      background: white;
      padding: 12px;
    }
    .env-item label {
      display: block;
      margin-bottom: 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--ink-soft);
      font-family: 'DM Mono', monospace;
    }
    .env-item input {
      width: 100%;
      border: 1px solid var(--cream-border);
      border-radius: 10px;
      padding: 10px 11px;
      background: var(--panel);
      color: var(--ink);
      font-family: 'DM Mono', monospace;
      font-size: 12px;
    }
    .log-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-bottom: 12px;
    }
    .log-toolbar select, .log-toolbar input {
      min-width: 180px;
    }
    .log-output {
      min-height: 260px;
      max-height: 420px;
      overflow: auto;
    }
    .button-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .screens {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      min-height: 480px;
    }
    .screen {
      border: 1px solid var(--cream-border);
      border-radius: 16px;
      overflow: hidden;
      background: white;
      display: flex;
      flex-direction: column;
    }
    .screen-bar {
      padding: 10px 12px;
      background: var(--cream-deep);
      border-bottom: 1px solid var(--cream-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      color: var(--ink-soft);
      font-family: 'DM Mono', monospace;
    }
    iframe {
      width: 100%;
      min-height: 400px;
      border: none;
      background: linear-gradient(180deg, #f9f5ee, #f1eadf);
    }
    .screen-empty {
      display: grid;
      place-items: center;
      min-height: 400px;
      padding: 30px;
      text-align: center;
      color: var(--ink-soft);
      font-family: 'DM Mono', monospace;
      background: linear-gradient(180deg, #fbf7ef, #f1eadf);
    }
    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      background: var(--ink);
      color: white;
      padding: 12px 14px;
      border-radius: 12px;
      box-shadow: var(--shadow);
      opacity: 0;
      transform: translateY(10px);
      transition: opacity .18s ease, transform .18s ease;
      pointer-events: none;
      max-width: 340px;
      font-size: 13px;
    }
    .toast.visible {
      opacity: 1;
      transform: translateY(0);
    }
    @media (max-width: 1100px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--cream-border); }
      .wizard-grid, .metrics, .wizard-steps, .preset-grid, .form-grid, .screens, .env-list, .button-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">F</div>
        <div class="brand-copy">
          <h1>Fitaly</h1>
          <p>Deploy Center</p>
        </div>
      </div>
      <div class="section-label">Servicios</div>
      <div id="serviceList" class="service-list"></div>
    </aside>
    <main class="main">
      <section class="topbar">
        <div>
          <h2>${escapeHtml(args.projectName)}</h2>
          <p>Configura el store, prueba el catálogo y levanta el stack retail desde una sola pantalla.</p>
        </div>
        <div class="actions">
          <button class="btn btn-ghost" id="reloadButton">Actualizar</button>
          <button class="btn btn-ghost" id="stopButton">Stop All</button>
          <button class="btn btn-amber" id="deployButton">Deploy All</button>
        </div>
      </section>

      <section class="card">
        <h3>Resumen</h3>
        <div class="metrics" id="metrics"></div>
      </section>

      <section class="card" id="wizardSection">
        <h3>Wizard De Deploy</h3>
        <div class="wizard-grid">
          <div>
            <div id="wizardSteps" class="wizard-steps"></div>
            <div class="toolbar">
              <button class="btn btn-amber" id="wizardDeployButton">Guardar Todo y Deploy</button>
              <button class="btn btn-ghost" id="wizardSaveAllButton">Guardar Todo</button>
              <button class="btn btn-ghost" id="wizardLogsButton">Ver Logs Runtime</button>
            </div>
          </div>
          <div class="wizard-panel">
            <div class="service-meta">Recomendación actual</div>
            <p>Este flujo prepara preset, archivo .env, config y deploy en el orden más corto para una tienda nueva o una demo rápida.</p>
            <div id="wizardSummary" class="result" style="margin-top:0;">Cargando estado del wizard...</div>
          </div>
        </div>
      </section>

      <section class="card" id="presetSection">
        <h3>Presets Guiados</h3>
        <div id="presetList" class="preset-grid"></div>
        <div id="presetResult" class="result">Aún no se ha aplicado ningún preset guiado.</div>
      </section>

      <section class="grid" id="configSection">
        <div class="card" style="grid-column: span 6;">
          <h3>Store Config</h3>
          <div class="form-grid">
            <div class="field">
              <label for="storeId">Store ID</label>
              <input id="storeId" />
            </div>
            <div class="field">
              <label for="storeName">Nombre</label>
              <input id="storeName" />
            </div>
            <div class="field">
              <label for="storeLocale">Locale</label>
              <input id="storeLocale" />
            </div>
            <div class="field">
              <label for="storeTimezone">Timezone</label>
              <input id="storeTimezone" />
            </div>
            <div class="field">
              <label for="serviceMode">Service Mode</label>
              <select id="serviceMode">
                <option value="express-checkout">express-checkout</option>
                <option value="assisted-retail">assisted-retail</option>
                <option value="premium-concierge">premium-concierge</option>
                <option value="customer-support-desk">customer-support-desk</option>
              </select>
            </div>
            <div class="field">
              <label for="customerDisplayEnabled">Customer Display</label>
              <select id="customerDisplayEnabled">
                <option value="true">enabled</option>
                <option value="false">disabled</option>
              </select>
            </div>
          </div>
          <div class="toolbar">
            <button class="btn btn-amber" id="saveConfigButton">Guardar Config</button>
          </div>
        </div>

        <div class="card" style="grid-column: span 6;">
          <h3>Productos e Inventario</h3>
          <div class="form-grid">
            <div class="field">
              <label for="productsDriver">Products Driver</label>
              <select id="productsDriver">
                <option value="mock">mock</option>
                <option value="rest">rest</option>
                <option value="sqlite">sqlite</option>
              </select>
            </div>
            <div class="field">
              <label for="inventoryDriver">Inventory Driver</label>
              <select id="inventoryDriver">
                <option value="mock">mock</option>
                <option value="rest">rest</option>
                <option value="sqlite">sqlite</option>
              </select>
            </div>
            <div class="field">
              <label for="productsUrl">Products URL</label>
              <input id="productsUrl" placeholder="https://api.tienda.local/products" />
            </div>
            <div class="field">
              <label for="inventoryUrl">Inventory URL</label>
              <input id="inventoryUrl" placeholder="https://api.tienda.local/inventory" />
            </div>
            <div class="field">
              <label for="productsDb">Products DB</label>
              <input id="productsDb" placeholder="./catalog/products.db" />
            </div>
            <div class="field">
              <label for="inventoryDb">Inventory DB</label>
              <input id="inventoryDb" placeholder="./catalog/products.db" />
            </div>
            <div class="field" style="grid-column: span 2;">
              <label for="testQuery">Consulta de prueba</label>
              <input id="testQuery" placeholder="ej: zapatillas" />
            </div>
          </div>
          <div class="toolbar">
            <button class="btn btn-ghost" id="testProductsButton">Probar Conector</button>
          </div>
          <div id="connectorResult" class="result">Aún no se ha probado el conector.</div>
        </div>

        <div class="card" style="grid-column: span 6;">
          <h3>Clientes, Órdenes y Pagos</h3>
          <div class="form-grid">
            <div class="field">
              <label for="customersDriver">Customers Driver</label>
              <select id="customersDriver">
                <option value="mock">mock</option>
                <option value="rest">rest</option>
                <option value="sqlite">sqlite</option>
              </select>
            </div>
            <div class="field">
              <label for="ordersDriver">Orders Driver</label>
              <select id="ordersDriver">
                <option value="mock">mock</option>
                <option value="rest">rest</option>
                <option value="sqlite">sqlite</option>
              </select>
            </div>
            <div class="field">
              <label for="customersUrl">Customers URL</label>
              <input id="customersUrl" placeholder="https://api.tienda.local/customers" />
            </div>
            <div class="field">
              <label for="ordersUrl">Orders URL</label>
              <input id="ordersUrl" placeholder="https://api.tienda.local/orders" />
            </div>
            <div class="field">
              <label for="customersDb">Customers DB</label>
              <input id="customersDb" placeholder="./retail/customers.db" />
            </div>
            <div class="field">
              <label for="ordersDb">Orders DB</label>
              <input id="ordersDb" placeholder="./retail/orders.db" />
            </div>
            <div class="field">
              <label for="paymentsDriver">Payments Driver</label>
              <select id="paymentsDriver">
                <option value="mock">mock</option>
              </select>
            </div>
            <div class="field" style="grid-column: span 1;">
              <label>Payments Status</label>
              <input value="mock only por ahora" disabled />
            </div>
          </div>
          <div class="result">El runtime actual soporta <code>customers</code> y <code>orders</code> por <code>mock/rest/sqlite</code>. <code>payments</code> sigue en <code>mock</code>, pero ya se puede validar desde este playground con una orden preview local.</div>
        </div>
      </section>

      <section class="grid" id="envSection">
        <div class="card" style="grid-column: span 6;">
          <h3>Variables De Entorno</h3>
          <div id="envSummary" class="service-meta" style="margin-bottom:12px;"></div>
          <div id="envList" class="env-list"></div>
          <div class="toolbar">
            <button class="btn btn-amber" id="saveEnvButton">Guardar .env</button>
          </div>
        </div>

        <div class="card" style="grid-column: span 6;">
          <h3>Logs</h3>
          <div class="log-toolbar">
            <select id="logsServiceSelect"></select>
            <input id="logsTailInput" type="number" min="20" max="500" value="120" />
            <button class="btn btn-ghost" id="loadLogsButton">Cargar Logs</button>
          </div>
          <div id="logsResult" class="result log-output">Aún no se han cargado logs.</div>
        </div>
      </section>

      <section class="grid">
        <div class="card" style="grid-column: span 6;">
          <h3>Test Customers</h3>
          <div class="form-grid">
            <div class="field">
              <label for="customerAction">Action</label>
              <select id="customerAction">
                <option value="lookup">lookup</option>
                <option value="register">register</option>
              </select>
            </div>
            <div class="field" style="grid-column: span 2;">
              <label for="customerPayload">Payload JSON</label>
              <textarea id="customerPayload"></textarea>
            </div>
          </div>
          <div class="toolbar">
            <button class="btn btn-ghost" id="testCustomersButton">Probar Customers</button>
          </div>
          <div id="customerConnectorResult" class="result">Aún no se ha probado el conector de customers.</div>
        </div>

        <div class="card" style="grid-column: span 6;">
          <h3>Test Orders</h3>
          <div class="form-grid">
            <div class="field">
              <label for="orderAction">Action</label>
              <select id="orderAction">
                <option value="create">create</option>
                <option value="update">update</option>
                <option value="confirm">confirm</option>
              </select>
            </div>
            <div class="field" style="grid-column: span 2;">
              <label for="orderPayload">Payload JSON</label>
              <textarea id="orderPayload"></textarea>
            </div>
          </div>
          <div class="toolbar">
            <button class="btn btn-ghost" id="testOrdersButton">Probar Orders</button>
          </div>
          <div id="orderConnectorResult" class="result">Aún no se ha probado el conector de orders.</div>
        </div>
      </section>

      <section class="grid">
        <div class="card" style="grid-column: span 12;">
          <h3>Test Payments</h3>
          <div class="result" style="margin-bottom:12px;">La prueba actual usa <code>create_intent</code> sobre el driver <code>mock</code>. Si la orden indicada no existe, el deploy center crea una orden preview local para ejecutar el cobro de prueba.</div>
          <div class="form-grid">
            <div class="field" style="grid-column: span 2;">
              <label for="paymentPayload">Payload JSON</label>
              <textarea id="paymentPayload"></textarea>
            </div>
          </div>
          <div class="toolbar">
            <button class="btn btn-ghost" id="testPaymentsButton">Probar Payments</button>
          </div>
          <div id="paymentConnectorResult" class="result">Aún no se ha probado el conector de payments.</div>
        </div>
      </section>

      <section class="card" id="screensSection">
        <h3>Pantallas</h3>
        <div class="screens" id="screens"></div>
      </section>
    </main>
  </div>
  <div id="toast" class="toast"></div>

  <script>
    const state = {
      dashboard: null,
      rawConfig: null,
      envState: null,
      formDirty: false,
      envDirty: false,
    }

    const serviceList = document.getElementById('serviceList')
    const metrics = document.getElementById('metrics')
    const wizardSteps = document.getElementById('wizardSteps')
    const wizardSummary = document.getElementById('wizardSummary')
    const presetList = document.getElementById('presetList')
    const presetResult = document.getElementById('presetResult')
    const screens = document.getElementById('screens')
    const toast = document.getElementById('toast')
    const connectorResult = document.getElementById('connectorResult')
    const customerConnectorResult = document.getElementById('customerConnectorResult')
    const orderConnectorResult = document.getElementById('orderConnectorResult')
    const paymentConnectorResult = document.getElementById('paymentConnectorResult')
    const envSummary = document.getElementById('envSummary')
    const envList = document.getElementById('envList')
    const logsResult = document.getElementById('logsResult')
    const logsServiceSelect = document.getElementById('logsServiceSelect')
    const customerSamples = {
      lookup: {
        query: 'Ana',
        limit: 5,
      },
      register: {
        name: 'María López',
        locale: 'es-CR',
        metadata: {
          loyalty_tier: 'bronze',
          visits: 1,
        },
      },
    }
    const orderSamples = {
      create: {
        customer_id: 'cust_demo_001',
        items: [
          {
            product_id: 'sku_nike_air_42',
            quantity: 1,
            price: 129.99,
          },
        ],
      },
      update: {
        order_id: 'ord_demo_replace_me',
        add_items: [
          {
            product_id: 'sku_adidas_daily',
            quantity: 1,
            price: 89.5,
          },
        ],
      },
      confirm: {
        order_id: 'ord_demo_replace_me',
      },
    }
    const paymentSample = {
      order_id: 'ord_demo_payment',
      amount: 219.49,
      payment_method: 'card',
    }

    async function fetchJson(url, options = {}) {
      const response = await fetch(url, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || 'Request failed')
      }
      return response.json()
    }

    function showToast(message) {
      toast.textContent = message
      toast.classList.add('visible')
      window.clearTimeout(showToast._timeout)
      showToast._timeout = window.setTimeout(() => {
        toast.classList.remove('visible')
      }, 2800)
    }

    function renderServices(services) {
      serviceList.innerHTML = services.map((service) => \`
        <div class="service-item">
          <div class="service-title">
            <strong>\${escapeHtml(service.label)}</strong>
            <span class="status-pill status-\${service.status}">\${escapeHtml(service.status)}</span>
          </div>
          <div class="service-meta">\${escapeHtml(service.service_name)}</div>
          \${service.error ? \`<div class="service-meta" style="margin-top:6px;color:var(--rust)">\${escapeHtml(service.error)}</div>\` : ''}
          <div class="button-row">
            <button class="btn btn-ghost" onclick="startService('\${service.id}')">Start</button>
            <button class="btn btn-ghost" onclick="stopService('\${service.id}')">Stop</button>
            <button class="btn btn-ghost" onclick="restartService('\${service.id}')">Restart</button>
            <button class="btn btn-ghost" onclick="openLogs('\${service.id}')">Logs</button>
          </div>
        </div>
      \`).join('')
    }

    function renderMetrics(dashboard) {
      const running = dashboard.services.filter((service) => service.status === 'running').length
      const enabled = dashboard.services.filter((service) => service.enabled).length
      metrics.innerHTML = [
        ['Servicios vivos', String(running)],
        ['Servicios activos', String(enabled)],
        ['Driver productos', dashboard.connectors.products.driver],
        ['Driver órdenes', dashboard.connectors.orders.driver],
        ['Pagos', dashboard.connectors.payments.driver],
        ['Env configuradas', String(dashboard.env_summary.configured) + '/' + String(dashboard.env_summary.total)],
      ].map(([label, value]) => \`
        <div class="metric">
          <span>\${escapeHtml(label)}</span>
          <strong>\${escapeHtml(value)}</strong>
        </div>
      \`).join('')
    }

    function renderDeployWizard(dashboard, envState) {
      const steps = buildWizardSteps(dashboard, envState)
      wizardSteps.innerHTML = steps.map((step) => \`
        <div class="wizard-step step-\${escapeHtml(step.status)}">
          <div class="wizard-step-head">
            <div class="wizard-step-index">\${escapeHtml(step.index)}</div>
            <span class="wizard-status wizard-status-\${escapeHtml(step.status)}">\${escapeHtml(step.statusLabel)}</span>
          </div>
          <div class="wizard-step-copy">
            <h4 class="wizard-step-title">\${escapeHtml(step.title)}</h4>
            <div class="wizard-step-detail">\${escapeHtml(step.detail)}</div>
          </div>
          <div class="toolbar" style="margin-top:auto;">
            <button class="btn btn-ghost" onclick="runWizardAction('\${escapeHtml(step.action)}')">\${escapeHtml(step.actionLabel)}</button>
          </div>
        </div>
      \`).join('')
      wizardSummary.textContent = buildWizardSummary(steps, dashboard, envState)
    }

    function renderConnectorPresets(presets) {
      presetList.innerHTML = presets.map((preset) => \`
        <div class="preset-card">
          <div>
            <h4>\${escapeHtml(preset.label)}</h4>
          </div>
          <div class="preset-summary">\${escapeHtml(preset.summary)}</div>
          <p>\${escapeHtml(preset.description)}</p>
          <div class="preset-badges">
            \${preset.badges.map((badge) => \`<span class="preset-badge">\${escapeHtml(badge)}</span>\`).join('')}
          </div>
          <div class="toolbar" style="margin-top:auto;">
            <button class="btn btn-ghost" onclick="applyConnectorPreset('\${escapeHtml(preset.id)}')">Aplicar Preset</button>
          </div>
        </div>
      \`).join('')
    }

    function renderScreens(screenList) {
      screens.innerHTML = screenList.filter((screen) => screen.enabled).slice(0, 2).map((screen) => {
        if (!screen.url) {
          return \`
            <div class="screen">
              <div class="screen-bar">
                <span>\${escapeHtml(screen.label)}</span>
                <span>sin URL</span>
              </div>
              <div class="screen-empty">Define la URL de esta pantalla en el deploy center config para embederla aquí.</div>
            </div>
          \`
        }

        return \`
          <div class="screen">
            <div class="screen-bar">
              <span>\${escapeHtml(screen.label)}</span>
              <a href="\${escapeHtml(screen.url)}" target="_blank" rel="noreferrer">abrir</a>
            </div>
            <iframe src="\${escapeHtml(screen.url)}" loading="lazy"></iframe>
          </div>
        \`
      }).join('')
    }

    function renderEnvEditor(envState) {
      envSummary.textContent = 'Archivo: ' + envState.path + ' · Fuente: ' + envState.source
      envList.innerHTML = envState.entries.map((entry) => \`
        <div class="env-item">
          <label for="env-\${escapeHtml(entry.key)}">\${escapeHtml(entry.key)}</label>
          <input
            id="env-\${escapeHtml(entry.key)}"
            data-env-key="\${escapeHtml(entry.key)}"
            type="\${entry.secret ? 'password' : 'text'}"
            value="\${escapeHtml(entry.value)}"
            placeholder="\${entry.secret ? '••••••••' : ''}"
          />
        </div>
      \`).join('')
    }

    function renderLogsToolbar(services, preferredServiceId) {
      const enabledServices = services.filter((service) => service.enabled)
      logsServiceSelect.innerHTML = enabledServices.map((service) => \`
        <option value="\${escapeHtml(service.id)}">\${escapeHtml(service.label)}</option>
      \`).join('')

      if (preferredServiceId && enabledServices.some((service) => service.id === preferredServiceId)) {
        logsServiceSelect.value = preferredServiceId
      } else if (enabledServices[0]) {
        logsServiceSelect.value = enabledServices[0].id
      }
    }

    function populateForm(dashboard) {
      document.getElementById('storeId').value = dashboard.store.store_id
      document.getElementById('storeName').value = dashboard.store.name
      document.getElementById('storeLocale').value = dashboard.store.locale
      document.getElementById('storeTimezone').value = dashboard.store.timezone
      document.getElementById('serviceMode').value = dashboard.retail.service_mode
      document.getElementById('customerDisplayEnabled').value = String(dashboard.retail.customer_display_enabled)
      document.getElementById('productsDriver').value = dashboard.connectors.products.driver
      document.getElementById('inventoryDriver').value = dashboard.connectors.inventory.driver
      document.getElementById('customersDriver').value = dashboard.connectors.customers.driver
      document.getElementById('ordersDriver').value = dashboard.connectors.orders.driver
      document.getElementById('paymentsDriver').value = dashboard.connectors.payments.driver
      document.getElementById('productsUrl').value = dashboard.connectors.products.url || ''
      document.getElementById('inventoryUrl').value = dashboard.connectors.inventory.url || ''
      document.getElementById('customersUrl').value = dashboard.connectors.customers.url || ''
      document.getElementById('ordersUrl').value = dashboard.connectors.orders.url || ''
      document.getElementById('productsDb').value = dashboard.connectors.products.database || dashboard.connectors.products.connection_string || ''
      document.getElementById('inventoryDb').value = dashboard.connectors.inventory.database || dashboard.connectors.inventory.connection_string || ''
      document.getElementById('customersDb').value = dashboard.connectors.customers.database || dashboard.connectors.customers.connection_string || ''
      document.getElementById('ordersDb').value = dashboard.connectors.orders.database || dashboard.connectors.orders.connection_string || ''
    }

    async function loadDashboard() {
      const [dashboard, rawConfig, envState] = await Promise.all([
        fetchJson('/api/state'),
        fetchJson('/api/store-config'),
        fetchJson('/api/env'),
      ])

      state.dashboard = dashboard
      state.rawConfig = rawConfig
      state.envState = envState
      state.formDirty = false
      state.envDirty = false
      renderServices(dashboard.services)
      renderMetrics(dashboard)
      renderDeployWizard(dashboard, envState)
      renderConnectorPresets(dashboard.connector_presets)
      renderEnvEditor(envState)
      renderLogsToolbar(dashboard.services, logsServiceSelect.value)
      renderScreens(dashboard.screens)
      populateForm(dashboard)
    }

    async function applyConnectorPreset(presetId) {
      const preset = state.dashboard?.connector_presets?.find((entry) => entry.id === presetId)
      if (!preset) {
        throw new Error('No encontré el preset solicitado.')
      }

      presetResult.textContent = 'Aplicando preset ' + preset.label + '...'
      await fetchJson('/api/store-config', {
        method: 'PATCH',
        body: JSON.stringify(preset.patch),
      })
      await loadDashboard()
      presetResult.textContent = 'Preset aplicado: ' + preset.label + '. Revisa los campos y ajusta URLs o rutas si hace falta antes del deploy.'
      showToast('Preset aplicado: ' + preset.label)
    }

    async function saveConfig(options = {}) {
      const { reload = true, toast = true } = options
      const patch = {
        store: {
          store_id: document.getElementById('storeId').value.trim(),
          name: document.getElementById('storeName').value.trim(),
          locale: document.getElementById('storeLocale').value.trim(),
          timezone: document.getElementById('storeTimezone').value.trim(),
        },
        retail: {
          service_mode: document.getElementById('serviceMode').value,
          customer_display_enabled: document.getElementById('customerDisplayEnabled').value === 'true',
        },
        connectors: {
          products: buildConnectorPatch('products'),
          inventory: buildConnectorPatch('inventory'),
          customers: buildConnectorPatch('customers'),
          orders: buildConnectorPatch('orders'),
          payments: buildMockConnectorPatch('payments'),
        },
      }

      await fetchJson('/api/store-config', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })

      state.formDirty = false
      if (reload) {
        await loadDashboard()
      } else if (state.dashboard && state.envState) {
        renderDeployWizard(state.dashboard, state.envState)
      }
      if (toast) {
        showToast('Config guardada y validada.')
      }
    }

    async function saveEnv(options = {}) {
      const { reload = true, toast = true } = options
      const values = {}
      document.querySelectorAll('[data-env-key]').forEach((input) => {
        values[input.getAttribute('data-env-key')] = input.value
      })

      await fetchJson('/api/env', {
        method: 'PATCH',
        body: JSON.stringify({ values }),
      })

      state.envDirty = false
      if (reload) {
        await loadDashboard()
      } else if (state.dashboard && state.envState) {
        renderDeployWizard(state.dashboard, state.envState)
      }
      if (toast) {
        showToast('.env guardado.')
      }
    }

    function buildConnectorPatch(prefix) {
      const driver = document.getElementById(prefix + 'Driver').value
      const url = document.getElementById(prefix + 'Url').value.trim()
      const database = document.getElementById(prefix + 'Db').value.trim()
      const patch = {
        driver,
        url: url || null,
        database: database || null,
        connection_string: database || null,
        headers: {},
        health_timeout_ms: 3000,
        retry_policy: { max_attempts: 3, backoff_ms: 250 },
        options: {},
      }
      return patch
    }

    function buildMockConnectorPatch(prefix) {
      return {
        driver: document.getElementById(prefix + 'Driver').value,
        url: null,
        database: null,
        connection_string: null,
        headers: {},
        health_timeout_ms: 3000,
        retry_policy: { max_attempts: 3, backoff_ms: 250 },
        options: {},
      }
    }

    async function testProductsConnector() {
      const query = document.getElementById('testQuery').value.trim() || 'Nike'
      connectorResult.textContent = 'Probando conector...'
      const result = await fetchJson('/api/connectors/products/test', {
        method: 'POST',
        body: JSON.stringify({ query }),
      })
      connectorResult.textContent = JSON.stringify(result, null, 2)
      showToast('Conector de productos probado.')
    }

    async function testCustomersConnector() {
      const action = document.getElementById('customerAction').value
      const input = parseJsonObjectField('customerPayload', 'Payload de customers')
      customerConnectorResult.textContent = 'Probando conector de customers...'
      const result = await fetchJson('/api/connectors/customers/test', {
        method: 'POST',
        body: JSON.stringify({ action, input }),
      })
      customerConnectorResult.textContent = JSON.stringify(result, null, 2)
      showToast('Conector de customers probado.')
    }

    async function testOrdersConnector() {
      const action = document.getElementById('orderAction').value
      const input = parseJsonObjectField('orderPayload', 'Payload de orders')
      orderConnectorResult.textContent = 'Probando conector de orders...'
      const result = await fetchJson('/api/connectors/orders/test', {
        method: 'POST',
        body: JSON.stringify({ action, input }),
      })
      orderConnectorResult.textContent = JSON.stringify(result, null, 2)
      showToast('Conector de orders probado.')
    }

    async function testPaymentsConnector() {
      const input = parseJsonObjectField('paymentPayload', 'Payload de payments')
      paymentConnectorResult.textContent = 'Probando conector de payments...'
      const result = await fetchJson('/api/connectors/payments/test', {
        method: 'POST',
        body: JSON.stringify({ input }),
      })
      paymentConnectorResult.textContent = JSON.stringify(result, null, 2)
      showToast('Conector de payments probado.')
    }

    async function deployAll(options = {}) {
      const { reload = true, toast = true } = options
      const result = await fetchJson('/api/deploy/up', { method: 'POST' })
      if (toast) {
        showToast(result.ok ? 'Stack lanzado.' : 'Docker compose respondió con error.')
      }
      if (reload) {
        await loadDashboard()
      }
    }

    async function stopAll() {
      const result = await fetchJson('/api/deploy/down', { method: 'POST' })
      showToast(result.ok ? 'Stack detenido.' : 'Docker compose respondió con error.')
      await loadDashboard()
    }

    async function saveAll() {
      wizardSummary.textContent = 'Guardando store config y .env...'
      await saveConfig({ reload: false, toast: false })
      await saveEnv({ reload: false, toast: false })
      await loadDashboard()
      wizardSummary.textContent = 'Config y .env guardados. Si el preset y las variables ya están listos, puedes desplegar el stack.'
      showToast('Config y .env guardados.')
    }

    async function saveAllAndDeploy() {
      wizardSummary.textContent = 'Guardando config, escribiendo .env y lanzando el stack...'
      await saveConfig({ reload: false, toast: false })
      await saveEnv({ reload: false, toast: false })
      await deployAll({ reload: true, toast: false })
      wizardSummary.textContent = 'Wizard completado. El stack fue lanzado y el panel ya refleja el estado actualizado de los servicios.'
      showToast('Config, .env y deploy ejecutados.')
    }

    async function restartService(serviceId) {
      const result = await fetchJson('/api/services/' + serviceId + '/restart', { method: 'POST' })
      showToast(result.ok ? 'Servicio reiniciado.' : 'No se pudo reiniciar el servicio.')
      await loadDashboard()
    }

    async function startService(serviceId) {
      const result = await fetchJson('/api/services/' + serviceId + '/start', { method: 'POST' })
      showToast(result.ok ? 'Servicio iniciado.' : 'No se pudo iniciar el servicio.')
      await loadDashboard()
    }

    async function stopService(serviceId) {
      const result = await fetchJson('/api/services/' + serviceId + '/stop', { method: 'POST' })
      showToast(result.ok ? 'Servicio detenido.' : 'No se pudo detener el servicio.')
      await loadDashboard()
    }

    async function loadLogs(serviceId = logsServiceSelect.value) {
      const tail = document.getElementById('logsTailInput').value.trim() || '120'
      logsResult.textContent = 'Cargando logs...'
      const result = await fetchJson('/api/services/' + serviceId + '/logs?tail=' + encodeURIComponent(tail))
      logsServiceSelect.value = serviceId
      logsResult.textContent = [result.stdout || '', result.stderr || ''].filter(Boolean).join('\n') || 'No hubo salida para este servicio.'
    }

    function openLogs(serviceId) {
      renderLogsToolbar(state.dashboard.services, serviceId)
      loadLogs(serviceId).catch((error) => handleError(error, logsResult))
    }

    function buildWizardSteps(dashboard, envState) {
      const currentPresetId = detectPresetId(dashboard.connectors)
      const currentPreset = dashboard.connector_presets.find((preset) => preset.id === currentPresetId)
      const envTotal = envState.entries.length
      const envConfigured = envState.entries.filter((entry) => entry.value.trim().length > 0).length
      const enabledServices = dashboard.services.filter((service) => service.enabled)
      const runningServices = enabledServices.filter((service) => service.status === 'running')

      return [
        {
          index: '01',
          title: 'Elegir preset',
          status: currentPreset ? 'done' : 'active',
          statusLabel: currentPreset ? 'listo' : 'revisar',
          detail: currentPreset
            ? 'Preset actual: ' + currentPreset.label
            : 'Modo actual: configuración manual o mezcla custom de conectores.',
          action: 'presets',
          actionLabel: 'Abrir presets',
        },
        {
          index: '02',
          title: 'Completar .env',
          status:
            envTotal === 0 || envConfigured === envTotal
              ? 'done'
              : envConfigured > 0
                ? 'active'
                : 'pending',
          statusLabel:
            envTotal === 0 || envConfigured === envTotal
              ? 'listo'
              : envConfigured > 0
                ? 'revisar'
                : 'pendiente',
          detail:
            envTotal === 0
              ? 'No hay variables cargadas desde .env o .env.example.'
              : String(envConfigured) + '/' + String(envTotal) + ' variables con valor.',
          action: 'env',
          actionLabel: 'Editar .env',
        },
        {
          index: '03',
          title: 'Guardar cambios',
          status: state.formDirty || state.envDirty ? 'active' : 'done',
          statusLabel: state.formDirty || state.envDirty ? 'revisar' : 'listo',
          detail:
            state.formDirty || state.envDirty
              ? describeUnsavedChanges()
              : 'No hay cambios locales pendientes en config ni .env.',
          action: state.formDirty || state.envDirty ? 'save-all' : 'config',
          actionLabel: state.formDirty || state.envDirty ? 'Guardar todo' : 'Revisar config',
        },
        {
          index: '04',
          title: 'Desplegar stack',
          status:
            enabledServices.length > 0 && runningServices.length === enabledServices.length
              ? 'done'
              : runningServices.length > 0
                ? 'active'
                : 'pending',
          statusLabel:
            enabledServices.length > 0 && runningServices.length === enabledServices.length
              ? 'arriba'
              : runningServices.length > 0
                ? 'parcial'
                : 'pendiente',
          detail:
            enabledServices.length === 0
              ? 'No hay servicios habilitados en este deploy center.'
              : String(runningServices.length) + '/' + String(enabledServices.length) + ' servicios en running.',
          action:
            enabledServices.length > 0 && runningServices.length === enabledServices.length
              ? 'logs'
              : 'deploy',
          actionLabel:
            enabledServices.length > 0 && runningServices.length === enabledServices.length
              ? 'Ver logs runtime'
              : 'Guardar y deploy',
        },
      ]
    }

    function buildWizardSummary(steps, dashboard, envState) {
      const firstActionable = steps.find((step) => step.status !== 'done')
      if (!firstActionable) {
        return 'Todo el flujo del wizard está en buen estado. El stack ya parece levantado o listo para usarse.'
      }

      if (firstActionable.action === 'env') {
        return 'Siguiente recomendado: completa las variables faltantes de .env y guárdalas antes de desplegar.'
      }

      if (firstActionable.action === 'save-all') {
        return 'Siguiente recomendado: guarda config y .env para que el deploy use exactamente lo que ves en pantalla.'
      }

      if (firstActionable.action === 'deploy') {
        return 'Siguiente recomendado: usa "Guardar Todo y Deploy" para levantar el stack con el preset y la configuración actual.'
      }

      return 'Siguiente recomendado: revisa el paso "' + firstActionable.title + '" para completar el flujo de deploy.'
    }

    function detectPresetId(connectors) {
      const drivers = [
        connectors.products.driver,
        connectors.inventory.driver,
        connectors.customers.driver,
        connectors.orders.driver,
        connectors.payments.driver,
      ]

      if (drivers.every((driver) => driver === 'mock')) {
        return 'demo-local-mock'
      }

      if (
        connectors.products.driver === 'sqlite' &&
        connectors.inventory.driver === 'sqlite' &&
        connectors.customers.driver === 'sqlite' &&
        connectors.orders.driver === 'sqlite' &&
        connectors.payments.driver === 'mock'
      ) {
        return 'sqlite-local-retail'
      }

      if (
        connectors.products.driver === 'rest' &&
        connectors.inventory.driver === 'rest' &&
        connectors.customers.driver === 'rest' &&
        connectors.orders.driver === 'rest' &&
        connectors.payments.driver === 'mock'
      ) {
        return 'rest-backoffice'
      }

      return null
    }

    function describeUnsavedChanges() {
      if (state.formDirty && state.envDirty) {
        return 'Hay cambios pendientes tanto en store config como en .env.'
      }

      if (state.formDirty) {
        return 'Hay cambios pendientes en store config.'
      }

      if (state.envDirty) {
        return 'Hay cambios pendientes en .env.'
      }

      return 'No hay cambios pendientes.'
    }

    function scrollToSection(sectionId) {
      const element = document.getElementById(sectionId)
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }

    async function runWizardAction(action) {
      switch (action) {
        case 'presets':
          scrollToSection('presetSection')
          break
        case 'env':
          scrollToSection('envSection')
          break
        case 'config':
          scrollToSection('configSection')
          break
        case 'save-all':
          await saveAll()
          break
        case 'deploy':
          await saveAllAndDeploy()
          break
        case 'logs':
          openRuntimeLogs()
          break
        default:
          throw new Error('Acción de wizard no soportada: ' + action)
      }
    }

    function openRuntimeLogs() {
      const runtimeService = state.dashboard?.services?.find((service) =>
        service.kind === 'runtime' || service.id === 'store-runtime' || service.service_name === 'store-runtime'
      )

      if (!runtimeService) {
        throw new Error('No encontré un servicio runtime para mostrar logs.')
      }

      scrollToSection('envSection')
      openLogs(runtimeService.id)
    }

    function parseJsonObjectField(id, label) {
      const raw = document.getElementById(id).value.trim()
      if (!raw) {
        return {}
      }

      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(label + ': JSON inválido. ' + (error instanceof Error ? error.message : String(error)))
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(label + ': debe ser un objeto JSON.')
      }

      return parsed
    }

    function applyPayloadSample(selectId, textareaId, samples, force = false) {
      const select = document.getElementById(selectId)
      const textarea = document.getElementById(textareaId)
      if (!force && textarea.value.trim()) {
        return
      }

      textarea.value = JSON.stringify(samples[select.value], null, 2)
    }

    function applyJsonSample(textareaId, sample, force = false) {
      const textarea = document.getElementById(textareaId)
      if (!force && textarea.value.trim()) {
        return
      }

      textarea.value = JSON.stringify(sample, null, 2)
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
    }

    window.startService = startService
    window.stopService = stopService
    window.restartService = restartService
    window.openLogs = openLogs
    window.applyConnectorPreset = applyConnectorPreset
    window.runWizardAction = (action) => runWizardAction(action).catch((error) => handleError(error, wizardSummary))
    document.querySelectorAll('#configSection input, #configSection select').forEach((element) => {
      element.addEventListener('input', () => {
        state.formDirty = true
        if (state.dashboard && state.envState) {
          renderDeployWizard(state.dashboard, state.envState)
        }
      })
      element.addEventListener('change', () => {
        state.formDirty = true
        if (state.dashboard && state.envState) {
          renderDeployWizard(state.dashboard, state.envState)
        }
      })
    })
    envList.addEventListener('input', () => {
      state.envDirty = true
      if (state.dashboard && state.envState) {
        renderDeployWizard(state.dashboard, state.envState)
      }
    })
    document.getElementById('reloadButton').addEventListener('click', () => loadDashboard().catch((error) => handleError(error)))
    document.getElementById('wizardSaveAllButton').addEventListener('click', () => saveAll().catch((error) => handleError(error, wizardSummary)))
    document.getElementById('wizardDeployButton').addEventListener('click', () => saveAllAndDeploy().catch((error) => handleError(error, wizardSummary)))
    document.getElementById('wizardLogsButton').addEventListener('click', () => {
      try {
        openRuntimeLogs()
      } catch (error) {
        handleError(error, wizardSummary)
      }
    })
    document.getElementById('saveConfigButton').addEventListener('click', () => saveConfig().catch((error) => handleError(error)))
    document.getElementById('saveEnvButton').addEventListener('click', () => saveEnv().catch((error) => handleError(error)))
    document.getElementById('testProductsButton').addEventListener('click', () => testProductsConnector().catch((error) => handleError(error, connectorResult)))
    document.getElementById('testCustomersButton').addEventListener('click', () => testCustomersConnector().catch((error) => handleError(error, customerConnectorResult)))
    document.getElementById('testOrdersButton').addEventListener('click', () => testOrdersConnector().catch((error) => handleError(error, orderConnectorResult)))
    document.getElementById('testPaymentsButton').addEventListener('click', () => testPaymentsConnector().catch((error) => handleError(error, paymentConnectorResult)))
    document.getElementById('deployButton').addEventListener('click', () => deployAll().catch((error) => handleError(error)))
    document.getElementById('stopButton').addEventListener('click', () => stopAll().catch((error) => handleError(error)))
    document.getElementById('loadLogsButton').addEventListener('click', () => loadLogs().catch((error) => handleError(error, logsResult)))
    document.getElementById('customerAction').addEventListener('change', () => applyPayloadSample('customerAction', 'customerPayload', customerSamples, true))
    document.getElementById('orderAction').addEventListener('change', () => applyPayloadSample('orderAction', 'orderPayload', orderSamples, true))

    function handleError(error, target) {
      const message = error instanceof Error ? error.message : String(error)
      if (target) {
        target.textContent = message
      }
      showToast(error instanceof Error ? error.message : String(error))
    }

    applyPayloadSample('customerAction', 'customerPayload', customerSamples, true)
    applyPayloadSample('orderAction', 'orderPayload', orderSamples, true)
    applyJsonSample('paymentPayload', paymentSample, true)
    loadDashboard().catch((error) => handleError(error))
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
