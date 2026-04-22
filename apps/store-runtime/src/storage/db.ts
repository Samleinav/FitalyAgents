import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const dbInstances = new Map<string, Database.Database>()

export function getDb(dbPath = './data/store.db'): Database.Database {
  const resolvedPath = path.resolve(dbPath)
  const existing = dbInstances.get(resolvedPath)
  if (existing) {
    return existing
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })

  const db = new Database(resolvedPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)

  dbInstances.set(resolvedPath, db)
  return db
}

export function closeDb(dbPath = './data/store.db'): void {
  const resolvedPath = path.resolve(dbPath)
  const db = dbInstances.get(resolvedPath)
  if (!db) {
    return
  }

  db.close()
  dbInstances.delete(resolvedPath)
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)

  const migrationsDir = resolveMigrationsDir(import.meta.url)
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  const hasMigration = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  )

  for (const file of migrationFiles) {
    const alreadyApplied = hasMigration.get(file)
    if (alreadyApplied) {
      continue
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    const transaction = db.transaction(() => {
      db.exec(sql)
      insertMigration.run(file, Date.now())
    })

    transaction()
  }
}

export function resolveMigrationsDir(moduleUrl: string = import.meta.url): string {
  const directPath = fileURLToPath(new URL('./migrations', moduleUrl))
  const candidates = [
    directPath,
    path.resolve(process.cwd(), 'src/storage/migrations'),
    path.resolve(process.cwd(), 'apps/store-runtime/src/storage/migrations'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Could not locate store-runtime migrations directory. Tried: ${candidates.join(', ')}`,
  )
}
