CREATE TABLE IF NOT EXISTS customers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  locale       TEXT DEFAULT 'es',
  metadata     TEXT DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,
  approval_limits TEXT DEFAULT '{}',
  voice_id        TEXT,
  loaded_from     TEXT DEFAULT 'config',
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  tool_id      TEXT NOT NULL,
  params       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  safety_level TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  draft_id     TEXT REFERENCES drafts(id),
  tool_id      TEXT NOT NULL,
  params       TEXT NOT NULL,
  result       TEXT DEFAULT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id              TEXT PRIMARY KEY,
  draft_id        TEXT REFERENCES drafts(id),
  session_id      TEXT NOT NULL,
  action          TEXT NOT NULL,
  required_role   TEXT NOT NULL,
  strategy        TEXT NOT NULL DEFAULT 'parallel',
  quorum_required INTEGER DEFAULT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  approvers       TEXT DEFAULT '[]',
  context         TEXT DEFAULT '{}',
  timeout_ms      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS session_summaries (
  session_id   TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER DEFAULT NULL,
  summary      TEXT DEFAULT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT DEFAULT NULL,
  created_at   INTEGER NOT NULL,
  sent_at      INTEGER DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,
  timestamp    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  params_hash  TEXT NOT NULL,
  safety_level TEXT NOT NULL,
  decision     TEXT NOT NULL,
  approvers    TEXT DEFAULT '[]',
  chain_hash   TEXT NOT NULL,
  metadata     TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  wing        TEXT NOT NULL,
  room        TEXT NOT NULL,
  embedding   BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  price       REAL NOT NULL,
  stock       INTEGER NOT NULL DEFAULT 0,
  metadata    TEXT DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drafts_session_status
  ON drafts (session_id, status);

CREATE INDEX IF NOT EXISTS idx_orders_session_status
  ON orders (session_id, status);

CREATE INDEX IF NOT EXISTS idx_approvals_status_role
  ON approval_requests (status, required_role);

CREATE INDEX IF NOT EXISTS idx_memory_scope
  ON memory_entries (wing, room);

CREATE INDEX IF NOT EXISTS idx_products_name
  ON products (name);

INSERT OR IGNORE INTO products (
  id,
  name,
  description,
  price,
  stock,
  metadata,
  created_at,
  updated_at
) VALUES
  (
    'sku_nike_air_42',
    'Nike Air Runner 42',
    'Tenis de running ligeros, talla 42',
    129.99,
    6,
    '{}',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'sku_adidas_daily',
    'Adidas Daily Street',
    'Tenis casuales para uso diario',
    89.50,
    12,
    '{}',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'sku_puma_train_pro',
    'Puma Train Pro',
    'Tenis de entrenamiento de alto soporte',
    109.00,
    4,
    '{}',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  );
