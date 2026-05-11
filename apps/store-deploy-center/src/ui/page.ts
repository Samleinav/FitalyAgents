export function renderDeployCenterHtml(args: { projectName: string }): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(args.projectName)}</title>
<style>
:root{--bg:#0d1117;--s1:#161b27;--s2:#1e2535;--b:#2a3347;--text:#cdd6f4;--dim:#6b7a99;--g:#a6e3a1;--gbg:rgba(166,227,161,.12);--r:#f38ba8;--rbg:rgba(243,139,168,.12);--y:#f9e2af;--ybg:rgba(249,226,175,.12);--bl:#89b4fa;--blbg:rgba(137,180,250,.1);--mono:'JetBrains Mono','Fira Code',ui-monospace,monospace;--sans:'Inter',system-ui,-apple-system,sans-serif;--r8:8px;--r6:6px;--r4:4px}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:var(--sans);font-size:13px;background:var(--bg);color:var(--text);display:flex;flex-direction:column;height:100vh;overflow:hidden}
.hdr{display:flex;align-items:center;gap:12px;padding:0 16px;height:46px;background:var(--s1);border-bottom:1px solid var(--b);flex-shrink:0}
.brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;white-space:nowrap}
.logo{width:26px;height:26px;background:var(--bl);color:#0d1117;border-radius:var(--r6);display:grid;place-items:center;font-weight:700;font-size:13px}
.svc-pills{display:flex;gap:5px;flex:1;overflow:hidden}
.svc-pill{display:flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;font-size:11px;font-family:var(--mono);background:var(--s2);border:1px solid var(--b);white-space:nowrap}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.dot-running{background:var(--g)}.dot-down{background:var(--r)}.dot-unverified{background:var(--y)}.dot-disabled{background:var(--dim)}
.hdr-actions{display:flex;gap:5px;margin-left:auto}
.btn{border:none;cursor:pointer;border-radius:var(--r6);padding:5px 11px;font-size:12px;font-family:var(--sans);font-weight:500;transition:background .15s,opacity .15s;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.btn:disabled{opacity:.45;cursor:not-allowed}
.primary{background:var(--bl);color:#0d1117}.primary:hover:not(:disabled){background:#a6c8ff}
.ghost{background:var(--s2);color:var(--text);border:1px solid var(--b)}.ghost:hover:not(:disabled){background:var(--b)}
.danger{background:var(--rbg);color:var(--r);border:1px solid rgba(243,139,168,.3)}
.xs{padding:3px 8px;font-size:11px}
.banner{display:none;align-items:center;gap:10px;padding:7px 16px;background:var(--ybg);border-bottom:1px solid rgba(249,226,175,.2);font-size:12px;color:var(--y);flex-shrink:0}
.banner.on{display:flex}.banner-btns{display:flex;gap:5px;margin-left:auto}
.tab-nav{display:flex;gap:2px;padding:8px 16px 0;background:var(--s1);border-bottom:1px solid var(--b);flex-shrink:0}
.tab{background:none;border:none;cursor:pointer;padding:5px 13px;font-size:12px;font-family:var(--sans);color:var(--dim);border-radius:var(--r6) var(--r6) 0 0;border-bottom:2px solid transparent;transition:color .15s}
.tab:hover{color:var(--text)}.tab.active{color:var(--bl);border-bottom-color:var(--bl)}
.tab-panel{display:none;flex:1;overflow-y:auto;padding:12px 16px}
.tab-panel.active{display:block}
.metrics-row{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
.metric-chip{display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--s1);border:1px solid var(--b);border-radius:var(--r6);font-size:12px}
.metric-chip .lbl{color:var(--dim)}.metric-chip .val{font-family:var(--mono);font-weight:600}
.ov-grid{display:grid;grid-template-columns:1fr 360px;gap:12px;align-items:start}
.panel{background:var(--s1);border:1px solid var(--b);border-radius:var(--r8);overflow:hidden}
.ph{padding:8px 12px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--b)}
.svc-grid{padding:6px;display:flex;flex-direction:column;gap:3px}
.svc-row{display:grid;grid-template-columns:8px 1fr auto auto;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--r6);background:var(--s2);border:1px solid transparent}
.svc-row:hover{border-color:var(--b)}
.svc-name{font-size:12px;font-family:var(--mono)}
.svc-meta{font-size:10px;color:var(--dim);margin-top:1px}
.svc-btns{display:flex;gap:3px}
.svc-btn{background:var(--s1);border:1px solid var(--b);border-radius:var(--r4);padding:3px 7px;font-size:10px;color:var(--dim);cursor:pointer}
.svc-btn:hover{color:var(--text);background:var(--b)}
.wiz-steps{padding:8px;display:flex;flex-direction:column;gap:5px}
.wiz-step{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:var(--r6);background:var(--s2);border:1px solid var(--b)}
.step-n{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-family:var(--mono);font-weight:700;flex-shrink:0}
.step-done .step-n{background:var(--gbg);color:var(--g)}.step-active .step-n{background:var(--ybg);color:var(--y)}.step-pending .step-n{background:var(--s1);color:var(--dim)}
.step-info{flex:1;min-width:0}
.step-title{font-size:12px;font-weight:500}
.step-detail{font-size:10px;color:var(--dim);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.step-badge{font-size:10px;font-family:var(--mono);padding:2px 6px;border-radius:999px}
.step-done .step-badge{background:var(--gbg);color:var(--g)}.step-active .step-badge{background:var(--ybg);color:var(--y)}.step-pending .step-badge{background:var(--s1);color:var(--dim)}
.wiz-summary{padding:7px 12px;font-size:11px;color:var(--dim);min-height:28px}
.btn-row{display:flex;gap:6px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--b)}
.btn-row.bare{border:none;padding:0;margin-top:10px}
.cfg-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.cfg-grid .span2{grid-column:span 2}
.fg{padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.field{display:flex;flex-direction:column;gap:4px}
.field span,.field>label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.field input,.field select,.field textarea{background:var(--s2);border:1px solid var(--b);border-radius:var(--r6);padding:6px 9px;color:var(--text);font-family:var(--mono);font-size:12px;width:100%}
.field textarea{resize:vertical;min-height:100px}
.field input:focus,.field select:focus,.field textarea:focus{outline:1px solid var(--bl);border-color:var(--bl)}
.conn-table{width:100%;border-collapse:collapse}
.conn-table th{text-align:left;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);padding:7px 10px;border-bottom:1px solid var(--b)}
.conn-table td{padding:5px 10px;border-bottom:1px solid var(--b);vertical-align:middle;font-size:12px}
.conn-table td:first-child{color:var(--dim);font-size:11px;font-family:var(--mono);width:90px}
.conn-table tr:last-child td{border-bottom:none}
.conn-table select,.conn-table input{background:var(--s2);border:1px solid var(--b);border-radius:var(--r4);padding:4px 7px;color:var(--text);font-family:var(--mono);font-size:11px;width:100%}
.conn-table select{width:auto}
.env-grid{padding:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:7px}
.env-item label{display:block;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-bottom:3px;font-family:var(--mono)}
.env-item input{width:100%;background:var(--s2);border:1px solid var(--b);border-radius:var(--r6);padding:5px 8px;color:var(--text);font-family:var(--mono);font-size:11px}
.preset-row{padding:8px;display:flex;flex-wrap:wrap;gap:8px}
.preset-card{flex:1;min-width:160px;background:var(--s2);border:1px solid var(--b);border-radius:var(--r8);padding:10px}
.preset-card h4{font-size:12px;margin-bottom:4px}
.preset-card p{font-size:11px;color:var(--dim);margin-bottom:8px;line-height:1.4}
.test-tabs{display:flex;gap:3px;margin-bottom:12px;background:var(--s1);border:1px solid var(--b);border-radius:var(--r8);padding:3px;width:fit-content}
.sub-tab{background:none;border:none;cursor:pointer;padding:4px 12px;font-size:12px;color:var(--dim);border-radius:var(--r6);transition:color .15s,background .15s}
.sub-tab.active{background:var(--s2);color:var(--text)}
.sub-panel{display:none}.sub-panel.active{display:block}
.logs-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.svc-seg{display:flex;gap:4px;flex-wrap:wrap}
.seg-btn{display:flex;align-items:center;gap:5px;padding:4px 10px;background:var(--s2);border:1px solid var(--b);border-radius:var(--r6);font-size:11px;font-family:var(--mono);color:var(--dim);cursor:pointer;transition:color .15s,background .15s}
.seg-btn:hover,.seg-btn.active{background:var(--b);color:var(--text)}
.log-out{background:var(--s1);border:1px solid var(--b);border-radius:var(--r8);padding:10px 12px;font-family:var(--mono);font-size:11px;color:var(--dim);white-space:pre-wrap;overflow:auto;min-height:60px}
.logs-full{height:calc(100vh - 178px);min-height:200px}
.screens-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;height:calc(100vh - 128px)}
.screen-panel{background:var(--s1);border:1px solid var(--b);border-radius:var(--r8);overflow:hidden;display:flex;flex-direction:column}
.screen-bar{padding:6px 12px;font-size:11px;color:var(--dim);border-bottom:1px solid var(--b);display:flex;justify-content:space-between;background:var(--s2)}
.screen-bar a{color:var(--bl);text-decoration:none;font-size:11px}
iframe{flex:1;border:none;background:#fff;width:100%;height:100%}
.screen-empty{flex:1;display:grid;place-items:center;font-size:11px;color:var(--dim);font-family:var(--mono)}
.toast-el{position:fixed;bottom:14px;right:14px;background:var(--s2);border:1px solid var(--b);color:var(--text);padding:7px 12px;border-radius:var(--r8);font-size:12px;opacity:0;transform:translateY(6px);transition:opacity .18s,transform .18s;pointer-events:none;max-width:300px;z-index:100;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.toast-el.on{opacity:1;transform:translateY(0)}
.dim{color:var(--dim)}
@keyframes spin{to{transform:rotate(360deg)}}
.spin{display:inline-block;width:11px;height:11px;border:2px solid rgba(13,17,23,.3);border-top-color:#0d1117;border-radius:50%;animation:spin .6s linear infinite}
.ti{background:var(--s2);border:1px solid var(--b);border-radius:var(--r6);padding:4px 8px;color:var(--text);font-family:var(--mono);font-size:12px;width:70px}
</style>
</head>
<body>

<header class="hdr">
  <div class="brand"><span class="logo">F</span><span>${escapeHtml(args.projectName)}</span></div>
  <div id="headerServices" class="svc-pills"></div>
  <div class="hdr-actions">
    <button class="btn ghost" id="reloadButton">⟳ Sync</button>
    <button class="btn ghost" id="restartRuntimeButton">↺ Runtime</button>
    <button class="btn ghost" id="stopButton">■ Stop</button>
    <button class="btn primary" id="deployButton">▶ Deploy</button>
  </div>
</header>

<div id="configBanner" class="banner">
  <span>&#9888; Config guardada — el runtime usa la version anterior hasta que lo reinicies.</span>
  <div class="banner-btns">
    <button class="btn xs primary" id="bannerRestartButton">Reiniciar</button>
    <button class="btn xs ghost" id="bannerDismissButton">x</button>
  </div>
</div>

<nav class="tab-nav">
  <button class="tab active" data-tab="overview">Overview</button>
  <button class="tab" data-tab="config">Config</button>
  <button class="tab" data-tab="test">Test Connectors</button>
  <button class="tab" data-tab="logs">Logs</button>
  <button class="tab" data-tab="screens">Screens</button>
</nav>

<div id="toast" class="toast-el"></div>

<section class="tab-panel active" id="tab-overview">
  <div class="metrics-row" id="metricsRow"></div>
  <div class="ov-grid">
    <div class="panel">
      <div class="ph">Servicios</div>
      <div id="serviceGrid" class="svc-grid"></div>
    </div>
    <div class="panel">
      <div class="ph">Wizard</div>
      <div id="wizardSteps" class="wiz-steps"></div>
      <div id="wizardSummary" class="wiz-summary"></div>
      <div class="btn-row">
        <button class="btn primary" id="wizardDeployButton">Guardar y Deploy</button>
        <button class="btn ghost" id="wizardSaveAllButton">Guardar Todo</button>
        <button class="btn ghost" id="wizardLogsButton">Logs Runtime</button>
      </div>
    </div>
  </div>
</section>

<section class="tab-panel" id="tab-config">
  <div class="cfg-grid">
    <div class="panel">
      <div class="ph">Store</div>
      <div class="fg">
        <div class="field"><span>Store ID</span><input id="storeId"></div>
        <div class="field"><span>Nombre</span><input id="storeName"></div>
        <div class="field"><span>Locale</span><input id="storeLocale"></div>
        <div class="field"><span>Timezone</span><input id="storeTimezone"></div>
        <div class="field"><span>Service Mode</span>
          <select id="serviceMode">
            <option value="express-checkout">express-checkout</option>
            <option value="assisted-retail">assisted-retail</option>
            <option value="premium-concierge">premium-concierge</option>
            <option value="customer-support-desk">customer-support-desk</option>
          </select>
        </div>
        <div class="field"><span>Customer Display</span>
          <select id="customerDisplayEnabled">
            <option value="true">enabled</option>
            <option value="false">disabled</option>
          </select>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" id="saveConfigButton">Guardar Store</button>
      </div>
    </div>

    <div class="panel">
      <div class="ph">Conectores</div>
      <table class="conn-table">
        <thead><tr><th>Conector</th><th>Driver</th><th>URL / Ruta DB</th></tr></thead>
        <tbody>
          <tr>
            <td>Products</td>
            <td><select id="productsDriver"><option value="mock">mock</option><option value="rest">rest</option><option value="sqlite">sqlite</option></select></td>
            <td><input id="productsUrl" placeholder="URL o ruta .db"></td>
          </tr>
          <tr>
            <td>Inventory</td>
            <td><select id="inventoryDriver"><option value="mock">mock</option><option value="rest">rest</option><option value="sqlite">sqlite</option></select></td>
            <td><input id="inventoryUrl" placeholder="URL o ruta .db"></td>
          </tr>
          <tr>
            <td>Customers</td>
            <td><select id="customersDriver"><option value="mock">mock</option><option value="rest">rest</option><option value="sqlite">sqlite</option></select></td>
            <td><input id="customersUrl" placeholder="URL o ruta .db"></td>
          </tr>
          <tr>
            <td>Orders</td>
            <td><select id="ordersDriver"><option value="mock">mock</option><option value="rest">rest</option><option value="sqlite">sqlite</option></select></td>
            <td><input id="ordersUrl" placeholder="URL o ruta .db"></td>
          </tr>
          <tr>
            <td>Payments</td>
            <td><select id="paymentsDriver"><option value="mock">mock</option></select></td>
            <td><span class="dim">mock only</span></td>
          </tr>
        </tbody>
      </table>
      <div class="btn-row">
        <button class="btn primary" id="saveConnectorsButton">Guardar Conectores</button>
      </div>
    </div>

    <div class="panel span2">
      <div class="ph">Variables de Entorno &nbsp;<span id="envSummary" class="dim" style="font-weight:400;text-transform:none;letter-spacing:0"></span></div>
      <div id="envList" class="env-grid"></div>
      <div class="btn-row">
        <button class="btn primary" id="saveEnvButton">Guardar .env</button>
      </div>
    </div>

    <div class="panel span2">
      <div class="ph">Presets Rapidos</div>
      <div id="presetList" class="preset-row"></div>
      <div id="presetResult" class="log-out" style="min-height:32px;margin:8px;"></div>
    </div>
  </div>
</section>

<section class="tab-panel" id="tab-test">
  <div class="test-tabs">
    <button class="sub-tab active" data-subtab="products">Products</button>
    <button class="sub-tab" data-subtab="customers">Customers</button>
    <button class="sub-tab" data-subtab="orders">Orders</button>
    <button class="sub-tab" data-subtab="payments">Payments</button>
  </div>
  <div class="sub-panel active" id="sub-products">
    <div style="max-width:460px">
      <div class="field"><span>Search Query</span><input id="testQuery" placeholder="ej: zapatillas Nike"></div>
      <div class="btn-row bare"><button class="btn primary" id="testProductsButton">Probar Products</button></div>
    </div>
    <pre id="connectorResult" class="log-out" style="margin-top:10px">-</pre>
  </div>
  <div class="sub-panel" id="sub-customers">
    <div style="max-width:460px">
      <div class="field" style="margin-bottom:8px"><span>Action</span>
        <select id="customerAction"><option value="lookup">lookup</option><option value="register">register</option></select>
      </div>
      <div class="field"><span>Payload JSON</span><textarea id="customerPayload" rows="7"></textarea></div>
      <div class="btn-row bare"><button class="btn primary" id="testCustomersButton">Probar Customers</button></div>
    </div>
    <pre id="customerConnectorResult" class="log-out" style="margin-top:10px">-</pre>
  </div>
  <div class="sub-panel" id="sub-orders">
    <div style="max-width:460px">
      <div class="field" style="margin-bottom:8px"><span>Action</span>
        <select id="orderAction"><option value="create">create</option><option value="update">update</option><option value="confirm">confirm</option></select>
      </div>
      <div class="field"><span>Payload JSON</span><textarea id="orderPayload" rows="7"></textarea></div>
      <div class="btn-row bare"><button class="btn primary" id="testOrdersButton">Probar Orders</button></div>
    </div>
    <pre id="orderConnectorResult" class="log-out" style="margin-top:10px">-</pre>
  </div>
  <div class="sub-panel" id="sub-payments">
    <div style="max-width:460px">
      <div class="field"><span>Payload JSON</span><textarea id="paymentPayload" rows="7"></textarea></div>
      <div class="btn-row bare"><button class="btn primary" id="testPaymentsButton">Probar Payments</button></div>
    </div>
    <pre id="paymentConnectorResult" class="log-out" style="margin-top:10px">-</pre>
  </div>
</section>

<section class="tab-panel" id="tab-logs">
  <div class="logs-toolbar">
    <div id="logsServiceSelect" class="svc-seg"></div>
    <input id="logsTailInput" type="number" value="120" min="20" max="500" class="ti">
    <button class="btn ghost" id="loadLogsButton">Cargar</button>
    <button class="btn ghost" id="autoRefreshButton">Auto &#9675;</button>
  </div>
  <pre id="logsResult" class="log-out logs-full">Selecciona un servicio y carga logs.</pre>
</section>

<section class="tab-panel" id="tab-screens">
  <div id="screens" class="screens-grid"></div>
</section>

<script>
(function() {
  var S = {
    dashboard: null, rawConfig: null, envState: null,
    formDirty: false, envDirty: false,
    deployInProgress: false, configNeedsRestart: false,
    pollingTimer: null, logsAutoTimer: null, logsAutoRefresh: false,
  }

  function q(id) { return document.getElementById(id) }
  function qs(sel) { return document.querySelector(sel) }
  function qsa(sel) { return document.querySelectorAll(sel) }

  var customerSamples = {
    lookup: { query: 'Ana', limit: 5 },
    register: { name: 'Maria Lopez', locale: 'es-CR', metadata: { loyalty_tier: 'bronze', visits: 1 } },
  }
  var orderSamples = {
    create: { customer_id: 'cust_demo_001', items: [{ product_id: 'sku_nike_air_42', quantity: 1, price: 129.99 }] },
    update: { order_id: 'ord_demo_replace_me', add_items: [{ product_id: 'sku_adidas_daily', quantity: 1, price: 89.5 }] },
    confirm: { order_id: 'ord_demo_replace_me' },
  }
  var paymentSample = { order_id: 'ord_demo_payment', amount: 219.49, payment_method: 'card' }

  function esc(v) {
    return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
  }

  function api(url, opts) {
    return fetch(url, Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {}))
      .then(function(r) {
        if (!r.ok) return r.text().then(function(t) { throw new Error(t || 'Request failed') })
        return r.json()
      })
  }

  var toastTimer
  function toast(msg) {
    var el = q('toast')
    el.textContent = msg
    el.classList.add('on')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function() { el.classList.remove('on') }, 2800)
  }

  function errShow(error, target) {
    var msg = error instanceof Error ? error.message : String(error)
    if (target) target.textContent = msg
    toast(msg)
  }

  function parseJson(id, label) {
    var raw = q(id).value.trim()
    if (!raw) return {}
    var p
    try { p = JSON.parse(raw) } catch(e) { throw new Error(label + ': JSON invalido. ' + e.message) }
    if (p && typeof p === 'object' && !Array.isArray(p)) return p
    throw new Error(label + ': debe ser un objeto JSON.')
  }

  // ── tabs ──
  function switchTab(id) {
    qsa('.tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === id) })
    qsa('.tab-panel').forEach(function(p) { p.classList.toggle('active', p.id === 'tab-' + id) })
  }

  function switchSubTab(id) {
    qsa('.sub-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.subtab === id) })
    qsa('.sub-panel').forEach(function(p) { p.classList.toggle('active', p.id === 'sub-' + id) })
  }

  // ── render ──
  function renderHeader(services) {
    q('headerServices').innerHTML = services.filter(function(s) { return s.enabled }).map(function(s) {
      return '<div class="svc-pill"><span class="dot dot-' + esc(s.status) + '"></span>' + esc(s.label) + '</div>'
    }).join('')
  }

  function renderServiceGrid(services) {
    q('serviceGrid').innerHTML = services.map(function(s) {
      return '<div class="svc-row" data-svc="' + esc(s.id) + '">' +
        '<span class="dot dot-' + esc(s.status) + '"></span>' +
        '<div><div class="svc-name">' + esc(s.label) + '</div>' +
        '<div class="svc-meta">' + esc(s.service_name) + ' &middot; ' + esc(s.status) + (s.error ? ' &middot; ' + esc(s.error) : '') + '</div></div>' +
        '<div class="svc-btns">' +
          '<button class="svc-btn" data-action="start">&#9654;</button>' +
          '<button class="svc-btn" data-action="stop">&#9646;&#9646;</button>' +
          '<button class="svc-btn" data-action="restart">&#8634;</button>' +
        '</div>' +
        '<button class="svc-btn" data-action="logs">logs</button>' +
      '</div>'
    }).join('')
  }

  function renderMetrics(d) {
    var running = d.services.filter(function(s) { return s.status === 'running' }).length
    var total = d.services.filter(function(s) { return s.enabled }).length
    var chips = [
      ['Servicios', running + '/' + total + ' running'],
      ['Products', d.connectors.products.driver],
      ['Orders', d.connectors.orders.driver],
      ['Payments', d.connectors.payments.driver],
      ['Env', d.env_summary.configured + '/' + d.env_summary.total],
    ]
    q('metricsRow').innerHTML = chips.map(function(c) {
      return '<div class="metric-chip"><span class="lbl">' + esc(c[0]) + '</span><span class="val">' + esc(c[1]) + '</span></div>'
    }).join('')
  }

  function buildWizardSteps(d, envState) {
    var drivers = [d.connectors.products.driver, d.connectors.inventory.driver, d.connectors.customers.driver, d.connectors.orders.driver, d.connectors.payments.driver]
    var presetId = drivers.every(function(dr) { return dr === 'mock' }) ? 'demo-local-mock'
      : (d.connectors.products.driver === 'sqlite' && d.connectors.customers.driver === 'sqlite') ? 'sqlite-local-retail'
      : (d.connectors.products.driver === 'rest' && d.connectors.customers.driver === 'rest') ? 'rest-backoffice' : null
    var preset = d.connector_presets.find(function(p) { return p.id === presetId })
    var envTotal = envState.entries.length
    var envOk = envState.entries.filter(function(e) { return e.value.trim().length > 0 }).length
    var enabled = d.services.filter(function(s) { return s.enabled })
    var running = enabled.filter(function(s) { return s.status === 'running' })
    return [
      { n:'01', title:'Preset', status: preset ? 'done' : 'active', badge: preset ? preset.label : 'pendiente', detail: preset ? 'Preset activo: ' + preset.label : 'Sin preset — config manual.' },
      { n:'02', title:'.env', status: envTotal === 0 || envOk === envTotal ? 'done' : envOk > 0 ? 'active' : 'pending', badge: envTotal === 0 ? 'n/a' : envOk + '/' + envTotal, detail: envTotal === 0 ? 'Sin variables.' : envOk + '/' + envTotal + ' configuradas.' },
      { n:'03', title:'Cambios', status: S.formDirty || S.envDirty ? 'active' : 'done', badge: S.formDirty || S.envDirty ? 'sin guardar' : 'guardado', detail: S.formDirty && S.envDirty ? 'Config y .env sin guardar.' : S.formDirty ? 'Store config sin guardar.' : S.envDirty ? '.env sin guardar.' : 'Sin cambios pendientes.' },
      { n:'04', title:'Stack', status: enabled.length > 0 && running.length === enabled.length ? 'done' : running.length > 0 ? 'active' : 'pending', badge: running.length + '/' + enabled.length + ' up', detail: running.length + '/' + enabled.length + ' servicios corriendo.' },
    ]
  }

  function renderWizard(d, envState) {
    var steps = buildWizardSteps(d, envState)
    q('wizardSteps').innerHTML = steps.map(function(s) {
      return '<div class="wiz-step step-' + esc(s.status) + '">' +
        '<span class="step-n">' + esc(s.n) + '</span>' +
        '<div class="step-info"><div class="step-title">' + esc(s.title) + '</div><div class="step-detail">' + esc(s.detail) + '</div></div>' +
        '<span class="step-badge">' + esc(s.badge) + '</span>' +
      '</div>'
    }).join('')
    var first = steps.find(function(s) { return s.status !== 'done' })
    q('wizardSummary').textContent = !first ? 'Stack completo.' :
      first.n === '02' ? 'Completa las variables de .env.' :
      first.n === '03' ? 'Guarda los cambios pendientes.' :
      first.n === '04' ? 'Usa Guardar y Deploy para levantar el stack.' :
      'Revisa el paso ' + first.n + ': ' + first.title
  }

  function renderPresets(presets) {
    q('presetList').innerHTML = presets.map(function(p) {
      return '<div class="preset-card"><h4>' + esc(p.label) + '</h4><p>' + esc(p.description) + '</p>' +
        '<button class="btn ghost xs" data-preset="' + esc(p.id) + '">Aplicar</button></div>'
    }).join('')
    q('presetList').querySelectorAll('[data-preset]').forEach(function(btn) {
      btn.addEventListener('click', function() { applyPreset(btn.dataset.preset) })
    })
  }

  function renderEnv(envState) {
    var configured = envState.entries.filter(function(e) { return e.value.trim().length > 0 }).length
    q('envSummary').textContent = configured + '/' + envState.entries.length + ' vars · ' + envState.source
    q('envList').innerHTML = envState.entries.map(function(e) {
      return '<div class="env-item"><label for="env-' + esc(e.key) + '">' + esc(e.key) + '</label>' +
        '<input id="env-' + esc(e.key) + '" data-env-key="' + esc(e.key) + '" type="' + (e.secret ? 'password' : 'text') + '" value="' + esc(e.value) + '"></div>'
    }).join('')
  }

  function renderLogsSvcSelect(services, activeSvcId) {
    q('logsServiceSelect').innerHTML = services.filter(function(s) { return s.enabled }).map(function(s) {
      return '<button class="seg-btn' + (s.id === activeSvcId ? ' active' : '') + '" data-svc="' + esc(s.id) + '">' +
        '<span class="dot dot-' + esc(s.status) + '"></span>' + esc(s.label) + '</button>'
    }).join('')
    q('logsServiceSelect').querySelectorAll('.seg-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        q('logsServiceSelect').querySelectorAll('.seg-btn').forEach(function(b) { b.classList.remove('active') })
        btn.classList.add('active')
      })
    })
  }

  function renderScreens(screenList) {
    q('screens').innerHTML = screenList.filter(function(s) { return s.enabled }).slice(0, 2).map(function(s) {
      return '<div class="screen-panel"><div class="screen-bar"><span>' + esc(s.label) + '</span>' +
        (s.url ? '<a href="' + esc(s.url) + '" target="_blank">abrir &#8599;</a>' : '<span>sin URL</span>') + '</div>' +
        (s.url ? '<iframe src="' + esc(s.url) + '" loading="lazy"></iframe>' : '<div class="screen-empty">URL no configurada</div>') +
      '</div>'
    }).join('')
  }

  function populateForm(d) {
    q('storeId').value = d.store.store_id
    q('storeName').value = d.store.name
    q('storeLocale').value = d.store.locale
    q('storeTimezone').value = d.store.timezone
    q('serviceMode').value = d.retail.service_mode
    q('customerDisplayEnabled').value = String(d.retail.customer_display_enabled)
    q('productsDriver').value = d.connectors.products.driver
    q('inventoryDriver').value = d.connectors.inventory.driver
    q('customersDriver').value = d.connectors.customers.driver
    q('ordersDriver').value = d.connectors.orders.driver
    q('paymentsDriver').value = d.connectors.payments.driver
    q('productsUrl').value = d.connectors.products.url || d.connectors.products.database || d.connectors.products.connection_string || ''
    q('inventoryUrl').value = d.connectors.inventory.url || d.connectors.inventory.database || d.connectors.inventory.connection_string || ''
    q('customersUrl').value = d.connectors.customers.url || d.connectors.customers.database || d.connectors.customers.connection_string || ''
    q('ordersUrl').value = d.connectors.orders.url || d.connectors.orders.database || d.connectors.orders.connection_string || ''
  }

  // ── load ──
  function load() {
    return Promise.all([api('/api/state'), api('/api/store-config'), api('/api/env')])
      .then(function(results) {
        var d = results[0], raw = results[1], env = results[2]
        S.dashboard = d; S.rawConfig = raw; S.envState = env
        S.formDirty = false; S.envDirty = false
        renderHeader(d.services)
        renderServiceGrid(d.services)
        renderMetrics(d)
        renderWizard(d, env)
        renderPresets(d.connector_presets)
        renderEnv(env)
        var activeSegBtn = q('logsServiceSelect').querySelector('.seg-btn.active')
        renderLogsSvcSelect(d.services, activeSegBtn ? activeSegBtn.dataset.svc : null)
        renderScreens(d.screens)
        populateForm(d)
        startPolling()
      })
  }

  function refreshStatus() {
    return api('/api/state').then(function(d) {
      S.dashboard = d
      renderHeader(d.services)
      renderServiceGrid(d.services)
      renderMetrics(d)
      if (S.envState) renderWizard(d, S.envState)
      var activeSegBtn = q('logsServiceSelect').querySelector('.seg-btn.active')
      renderLogsSvcSelect(d.services, activeSegBtn ? activeSegBtn.dataset.svc : null)
    }).catch(function() {})
  }

  function startPolling() {
    if (S.pollingTimer) return
    S.pollingTimer = setInterval(refreshStatus, 5000)
  }

  function stopPolling() { clearInterval(S.pollingTimer); S.pollingTimer = null }

  // ── banner ──
  function showBanner() {
    var runtimeUp = S.dashboard && S.dashboard.services.some(function(s) {
      return (s.kind === 'runtime' || s.id === 'store-runtime') && s.status === 'running'
    })
    if (!runtimeUp) return
    S.configNeedsRestart = true
    q('configBanner').classList.add('on')
  }

  function hideBanner() { S.configNeedsRestart = false; q('configBanner').classList.remove('on') }

  function setDeployBtn(loading) {
    var btn = q('deployButton')
    btn.disabled = loading
    btn.innerHTML = loading ? '<span class="spin"></span> Desplegando...' : '&#9654; Deploy'
  }

  // ── actions ──
  function deploy(opts) {
    var reload = !opts || opts.reload !== false
    var silent = opts && opts.silent
    S.deployInProgress = true; setDeployBtn(true); stopPolling()
    var fastPoll = setInterval(refreshStatus, 3000)
    return api('/api/deploy/up', { method: 'POST' })
      .then(function(r) {
        if (!silent) toast(r.ok ? 'Stack lanzado.' : 'Docker respondio con error.')
        if (reload) return load()
      })
      .finally(function() {
        clearInterval(fastPoll); S.deployInProgress = false; setDeployBtn(false); startPolling()
      })
  }

  function stopAll() {
    return api('/api/deploy/down', { method: 'POST' }).then(function(r) {
      toast(r.ok ? 'Stack detenido.' : 'Error al detener.')
      return load()
    })
  }

  function buildConnPatch(prefix) {
    var driver = q(prefix + 'Driver').value
    var urlOrDb = (q(prefix + 'Url') ? q(prefix + 'Url').value.trim() : '')
    return { driver: driver, url: urlOrDb || null, database: urlOrDb || null, connection_string: urlOrDb || null, headers: {}, health_timeout_ms: 3000, retry_policy: { max_attempts: 3, backoff_ms: 250 }, options: {} }
  }

  function saveConfig(opts) {
    var reload = !opts || opts.reload !== false
    var silent = opts && opts.silent
    var patch = {
      store: { store_id: q('storeId').value.trim(), name: q('storeName').value.trim(), locale: q('storeLocale').value.trim(), timezone: q('storeTimezone').value.trim() },
      retail: { service_mode: q('serviceMode').value, customer_display_enabled: q('customerDisplayEnabled').value === 'true' },
      connectors: {
        products: buildConnPatch('products'), inventory: buildConnPatch('inventory'),
        customers: buildConnPatch('customers'), orders: buildConnPatch('orders'),
        payments: { driver: q('paymentsDriver').value, url: null, database: null, connection_string: null, headers: {}, health_timeout_ms: 3000, retry_policy: { max_attempts: 3, backoff_ms: 250 }, options: {} },
      },
    }
    return api('/api/store-config', { method: 'PATCH', body: JSON.stringify(patch) })
      .then(function() {
        S.formDirty = false
        if (!silent) toast('Config guardada.')
        if (reload) return load()
        else if (S.dashboard && S.envState) renderWizard(S.dashboard, S.envState)
      })
      .then(function() { showBanner() })
  }

  function saveEnv(opts) {
    var reload = !opts || opts.reload !== false
    var silent = opts && opts.silent
    var values = {}
    document.querySelectorAll('[data-env-key]').forEach(function(inp) { values[inp.dataset.envKey] = inp.value })
    return api('/api/env', { method: 'PATCH', body: JSON.stringify({ values: values }) })
      .then(function() {
        S.envDirty = false
        if (!silent) toast('.env guardado.')
        if (reload) return load()
        else if (S.dashboard && S.envState) renderWizard(S.dashboard, S.envState)
      })
  }

  function saveAll() {
    return saveConfig({ reload: false, silent: true })
      .then(function() { return saveEnv({ reload: false, silent: true }) })
      .then(function() { return load() })
      .then(function() { toast('Config y .env guardados.') })
  }

  function saveAllAndDeploy() {
    return saveConfig({ reload: false, silent: true })
      .then(function() { return saveEnv({ reload: false, silent: true }) })
      .then(function() { hideBanner(); return deploy({ reload: true }) })
  }

  function restartRuntime() {
    var btn = q('restartRuntimeButton')
    var orig = btn.textContent
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'
    return api('/api/deploy/restart-runtime', { method: 'POST' })
      .then(function(r) { toast(r.ok ? 'Runtime reiniciado.' : 'No se pudo reiniciar.'); hideBanner(); return refreshStatus() })
      .catch(function(e) { errShow(e) })
      .finally(function() { btn.disabled = false; btn.textContent = orig })
  }

  function startSvc(id) { return api('/api/services/' + id + '/start', { method: 'POST' }).then(function(r) { toast(r.ok ? 'Iniciado.' : 'Error.'); return refreshStatus() }) }
  function stopSvc(id) { return api('/api/services/' + id + '/stop', { method: 'POST' }).then(function(r) { toast(r.ok ? 'Detenido.' : 'Error.'); return refreshStatus() }) }
  function restartSvc(id) { return api('/api/services/' + id + '/restart', { method: 'POST' }).then(function(r) { toast(r.ok ? 'Reiniciado.' : 'Error.'); return refreshStatus() }) }

  function loadLogs() {
    var activeBtn = q('logsServiceSelect').querySelector('.seg-btn.active')
    var svcId = activeBtn ? activeBtn.dataset.svc : null
    if (!svcId) { q('logsResult').textContent = 'Selecciona un servicio.'; return Promise.resolve() }
    var tail = q('logsTailInput').value || '120'
    q('logsResult').textContent = 'Cargando...'
    return api('/api/services/' + svcId + '/logs?tail=' + encodeURIComponent(tail))
      .then(function(r) {
        q('logsResult').textContent = [r.stdout, r.stderr].filter(Boolean).join('\\n') || 'Sin salida.'
        q('logsResult').scrollTop = q('logsResult').scrollHeight
      })
  }

  function openLogs(svcId) {
    switchTab('logs')
    q('logsServiceSelect').querySelectorAll('.seg-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.svc === svcId) })
    loadLogs().catch(function(e) { errShow(e, q('logsResult')) })
  }

  function toggleAutoRefresh() {
    S.logsAutoRefresh = !S.logsAutoRefresh
    q('autoRefreshButton').textContent = S.logsAutoRefresh ? 'Auto ●' : 'Auto ○'
    if (S.logsAutoRefresh) { S.logsAutoTimer = setInterval(function() { loadLogs().catch(function() {}) }, 4000) }
    else { clearInterval(S.logsAutoTimer) }
  }

  function applyPreset(id) {
    var preset = S.dashboard && S.dashboard.connector_presets.find(function(p) { return p.id === id })
    if (!preset) return
    q('presetResult').textContent = 'Aplicando ' + preset.label + '...'
    api('/api/store-config', { method: 'PATCH', body: JSON.stringify(preset.patch) })
      .then(function() { return load() })
      .then(function() { q('presetResult').textContent = 'Preset aplicado: ' + preset.label; toast('Preset: ' + preset.label) })
      .catch(function(e) { errShow(e, q('presetResult')) })
  }

  function testProducts() {
    var el = q('connectorResult')
    el.textContent = 'Probando...'
    return api('/api/connectors/products/test', { method: 'POST', body: JSON.stringify({ query: q('testQuery').value.trim() || 'Nike' }) })
      .then(function(r) { el.textContent = JSON.stringify(r, null, 2); toast('Products OK.') })
  }

  function testCustomers() {
    var el = q('customerConnectorResult'); el.textContent = 'Probando...'
    var input = parseJson('customerPayload', 'Customers payload')
    return api('/api/connectors/customers/test', { method: 'POST', body: JSON.stringify({ action: q('customerAction').value, input: input }) })
      .then(function(r) { el.textContent = JSON.stringify(r, null, 2); toast('Customers OK.') })
  }

  function testOrders() {
    var el = q('orderConnectorResult'); el.textContent = 'Probando...'
    var input = parseJson('orderPayload', 'Orders payload')
    return api('/api/connectors/orders/test', { method: 'POST', body: JSON.stringify({ action: q('orderAction').value, input: input }) })
      .then(function(r) { el.textContent = JSON.stringify(r, null, 2); toast('Orders OK.') })
  }

  function testPayments() {
    var el = q('paymentConnectorResult'); el.textContent = 'Probando...'
    var input = parseJson('paymentPayload', 'Payments payload')
    return api('/api/connectors/payments/test', { method: 'POST', body: JSON.stringify({ input: input }) })
      .then(function(r) { el.textContent = JSON.stringify(r, null, 2); toast('Payments OK.') })
  }

  // ── event wiring ──
  qsa('.tab').forEach(function(t) { t.addEventListener('click', function() { switchTab(t.dataset.tab) }) })
  qsa('.sub-tab').forEach(function(t) { t.addEventListener('click', function() { switchSubTab(t.dataset.subtab) }) })

  q('reloadButton').addEventListener('click', function() { load().catch(function(e) { errShow(e) }) })
  q('restartRuntimeButton').addEventListener('click', function() { restartRuntime() })
  q('stopButton').addEventListener('click', function() { stopAll().catch(function(e) { errShow(e) }) })
  q('deployButton').addEventListener('click', function() { deploy().catch(function(e) { errShow(e) }) })
  q('bannerRestartButton').addEventListener('click', function() { restartRuntime() })
  q('bannerDismissButton').addEventListener('click', hideBanner)
  q('saveConfigButton').addEventListener('click', function() { saveConfig().catch(function(e) { errShow(e) }) })
  q('saveConnectorsButton').addEventListener('click', function() { saveConfig().catch(function(e) { errShow(e) }) })
  q('saveEnvButton').addEventListener('click', function() { saveEnv().catch(function(e) { errShow(e) }) })
  q('wizardDeployButton').addEventListener('click', function() { saveAllAndDeploy().catch(function(e) { errShow(e) }) })
  q('wizardSaveAllButton').addEventListener('click', function() { saveAll().catch(function(e) { errShow(e) }) })
  q('wizardLogsButton').addEventListener('click', function() {
    var rt = S.dashboard && S.dashboard.services.find(function(s) { return s.kind === 'runtime' || s.id === 'store-runtime' })
    if (rt) openLogs(rt.id)
  })
  q('testProductsButton').addEventListener('click', function() { testProducts().catch(function(e) { errShow(e, q('connectorResult')) }) })
  q('testCustomersButton').addEventListener('click', function() { testCustomers().catch(function(e) { errShow(e, q('customerConnectorResult')) }) })
  q('testOrdersButton').addEventListener('click', function() { testOrders().catch(function(e) { errShow(e, q('orderConnectorResult')) }) })
  q('testPaymentsButton').addEventListener('click', function() { testPayments().catch(function(e) { errShow(e, q('paymentConnectorResult')) }) })
  q('loadLogsButton').addEventListener('click', function() { loadLogs().catch(function(e) { errShow(e, q('logsResult')) }) })
  q('autoRefreshButton').addEventListener('click', toggleAutoRefresh)

  q('customerAction').addEventListener('change', function() {
    q('customerPayload').value = JSON.stringify(customerSamples[q('customerAction').value], null, 2)
  })
  q('orderAction').addEventListener('change', function() {
    q('orderPayload').value = JSON.stringify(orderSamples[q('orderAction').value], null, 2)
  })

  var dirtyIds = ['storeId','storeName','storeLocale','storeTimezone','serviceMode','customerDisplayEnabled','productsDriver','inventoryDriver','customersDriver','ordersDriver','paymentsDriver','productsUrl','inventoryUrl','customersUrl','ordersUrl']
  dirtyIds.forEach(function(id) {
    var el = q(id); if (!el) return
    var mark = function() { S.formDirty = true; if (S.dashboard && S.envState) renderWizard(S.dashboard, S.envState) }
    el.addEventListener('input', mark); el.addEventListener('change', mark)
  })
  q('envList').addEventListener('input', function() { S.envDirty = true; if (S.dashboard && S.envState) renderWizard(S.dashboard, S.envState) })

  q('serviceGrid').addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]')
    if (!btn) return
    var row = btn.closest('[data-svc]')
    if (!row) return
    var svcId = row.dataset.svc
    var action = btn.dataset.action
    if (action === 'start') startSvc(svcId)
    else if (action === 'stop') stopSvc(svcId)
    else if (action === 'restart') restartSvc(svcId)
    else if (action === 'logs') openLogs(svcId)
  })

  // init
  q('customerPayload').value = JSON.stringify(customerSamples.lookup, null, 2)
  q('orderPayload').value = JSON.stringify(orderSamples.create, null, 2)
  q('paymentPayload').value = JSON.stringify(paymentSample, null, 2)
  load().catch(function(e) { errShow(e) })
})()
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
