import sqlite3 from 'sqlite3'
import { open, Database } from 'sqlite'

// Simulates the latency of a real external API or remote database.
// This is what makes async parallel execution matter.
const TOOL_LATENCY_MS = 300

export interface Product {
  id: string
  name: string
  price: number
  stock: number
  category: string
}

let dbInstance: Database | null = null

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance

  dbInstance = await open({
    filename: ':memory:', // Using in-memory DB for tests, could be file based too
    driver: sqlite3.Database,
  })

  await initDb(dbInstance)
  return dbInstance
}

export async function initDb(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      stock INTEGER NOT NULL,
      category TEXT NOT NULL
    );
  `)

  // Clear existing if any
  await db.exec('DELETE FROM products;')

  // Seed data
  const statements = [
    `INSERT INTO products (id, name, price, stock, category) VALUES ('P001', 'Nike Air Max', 129.99, 45, 'shoes')`,
    `INSERT INTO products (id, name, price, stock, category) VALUES ('P002', 'Adidas Stan Smith', 89.99, 12, 'shoes')`,
    `INSERT INTO products (id, name, price, stock, category) VALUES ('P003', 'Puma Suede', 79.99, 0, 'shoes')`,
    `INSERT INTO products (id, name, price, stock, category) VALUES ('P004', 'Basic T-Shirt', 19.99, 100, 'clothing')`,
    `INSERT INTO products (id, name, price, stock, category) VALUES ('P005', 'Denim Jeans', 49.99, 30, 'clothing')`,
  ]

  for (const sql of statements) {
    await db.exec(sql)
  }
}

// Helper methods:
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function searchProducts(query: string): Promise<Product[]> {
  const db = await getDb()
  // Split into words so "Nike shoes" matches "Nike Air Max" (category=shoes).
  // Each word must appear in name OR category (AND between words).
  const words = query
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9áéíóúñüÁÉÍÓÚÑÜ]/g, ''))
    .filter(Boolean)
  if (words.length === 0) return []

  const conditions = words
    .map(() => '(name LIKE ? OR category LIKE ?) COLLATE NOCASE')
    .join(' AND ')
  const params = words.flatMap((w) => [`%${w}%`, `%${w}%`])

  const [results] = await Promise.all([
    db.all<Product[]>(`SELECT * FROM products WHERE ${conditions}`, ...params),
    delay(TOOL_LATENCY_MS),
  ])
  return results
}

export async function getProductById(id: string): Promise<Product | null> {
  const db = await getDb()
  const [product] = await Promise.all([
    db.get<Product>('SELECT * FROM products WHERE id = ?', id),
    delay(TOOL_LATENCY_MS),
  ])
  return product ?? null
}
