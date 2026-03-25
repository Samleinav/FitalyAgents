/**
 * Approval Bridge Server
 *
 * This is the adapter between FitalyAgents and any external system.
 *
 * Responsibilities:
 *  1. Subscribe to bus:APPROVAL_WEBHOOK_REQUEST — store each pending approval
 *  2. Optionally forward it as an HTTP POST to an external URL (push mode)
 *  3. Serve GET /pending — so any app can poll for pending approvals
 *  4. Handle POST /approve and POST /reject — publish bus:APPROVAL_WEBHOOK_RESPONSE
 *
 * An external app (mobile, web, POS, existing system) only needs to:
 *  - Receive the notification (push or pull /pending)
 *  - POST to /approve or /reject
 *  - Nothing else — it doesn't need to know anything about FitalyAgents internals.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IEventBus } from 'fitalyagents'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingApproval {
  request_id: string
  draft_id: string
  action: string
  amount?: number
  required_role: string
  session_id: string
  received_at: number
}

export interface ApprovalServerConfig {
  /** Port to listen on. Default: 3456 */
  port?: number
  /**
   * Optional: if set, the server will also forward approval requests
   * as an HTTP POST to this URL (push mode for existing systems).
   *
   * The external system receives:
   *   POST externalPushUrl
   *   { request_id, action, amount, required_role, session_id,
   *     approve_url: "http://localhost:{port}/approve",
   *     reject_url:  "http://localhost:{port}/reject" }
   *
   * Then it POSTs back to approve_url or reject_url to complete the flow.
   */
  externalPushUrl?: string
}

// ── Server ────────────────────────────────────────────────────────────────────

export function createApprovalServer(bus: IEventBus, config: ApprovalServerConfig = {}) {
  const port = config.port ?? 3456
  const pending = new Map<string, PendingApproval>()

  // 1. Subscribe to approval requests from the bus
  bus.subscribe('bus:APPROVAL_WEBHOOK_REQUEST', (data) => {
    const req = data as Omit<PendingApproval, 'received_at'>

    const approval: PendingApproval = {
      request_id: req.request_id,
      draft_id: req.draft_id,
      action: req.action,
      amount: req.amount,
      required_role: req.required_role,
      session_id: req.session_id,
      received_at: Date.now(),
    }

    pending.set(req.request_id, approval)

    console.log(`\n[approval-server] New request: ${req.request_id}`)
    console.log(`  Action:        ${req.action}`)
    if (req.amount !== undefined) console.log(`  Amount:        $${req.amount}`)
    console.log(`  Required role: ${req.required_role}`)
    console.log(`  Open http://localhost:${port} to approve or reject\n`)

    // 2. Optional push to external system
    if (config.externalPushUrl) {
      void forwardToExternal(config.externalPushUrl, approval, port)
    }
  })

  // 3. HTTP server
  const server = createServer(async (req, res) => {
    setCors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`)

    // Serve the approver web UI
    if (req.method === 'GET' && url.pathname === '/') {
      try {
        const html = readFileSync(join(__dirname, '../public/index.html'), 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(500)
        res.end('Could not load index.html')
      }
      return
    }

    // GET /pending — list of pending approvals (for polling by external app)
    if (req.method === 'GET' && url.pathname === '/pending') {
      json(res, 200, Array.from(pending.values()))
      return
    }

    // POST /approve
    if (req.method === 'POST' && url.pathname === '/approve') {
      const body = await readBody(req)
      let parsed: { request_id: string; approver_id?: string }
      try {
        parsed = JSON.parse(body)
      } catch {
        json(res, 400, { error: 'Invalid JSON' })
        return
      }

      const { request_id, approver_id } = parsed
      if (!request_id || !pending.has(request_id)) {
        json(res, 404, { error: `No pending approval with id: ${request_id}` })
        return
      }

      pending.delete(request_id)
      await bus.publish('bus:APPROVAL_WEBHOOK_RESPONSE', {
        event: 'APPROVAL_WEBHOOK_RESPONSE',
        request_id,
        approved: true,
        approver_id: approver_id ?? 'web_approver',
      })

      console.log(`[approval-server] APPROVED: ${request_id} by ${approver_id ?? 'web_approver'}`)
      json(res, 200, { ok: true, request_id, action: 'approved' })
      return
    }

    // POST /reject
    if (req.method === 'POST' && url.pathname === '/reject') {
      const body = await readBody(req)
      let parsed: { request_id: string; reason?: string }
      try {
        parsed = JSON.parse(body)
      } catch {
        json(res, 400, { error: 'Invalid JSON' })
        return
      }

      const { request_id, reason } = parsed
      if (!request_id || !pending.has(request_id)) {
        json(res, 404, { error: `No pending approval with id: ${request_id}` })
        return
      }

      pending.delete(request_id)
      await bus.publish('bus:APPROVAL_WEBHOOK_RESPONSE', {
        event: 'APPROVAL_WEBHOOK_RESPONSE',
        request_id,
        approved: false,
        approver_id: 'web_approver',
        reason: reason ?? 'Rejected via web',
      })

      console.log(`[approval-server] REJECTED: ${request_id}, reason: ${reason ?? 'no reason'}`)
      json(res, 200, { ok: true, request_id, action: 'rejected' })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  server.listen(port, () => {
    console.log(`[approval-server] Approver UI at http://localhost:${port}`)
    if (config.externalPushUrl) {
      console.log(`[approval-server] Push mode: forwarding requests to ${config.externalPushUrl}`)
    }
  })

  return server
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function setCors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
    })
    req.on('end', () => resolve(data))
  })
}

/**
 * Forward the approval request to an external URL (push mode).
 * The external system only needs to POST back to /approve or /reject.
 */
async function forwardToExternal(
  url: string,
  approval: PendingApproval,
  localPort: number,
): Promise<void> {
  try {
    const payload = {
      ...approval,
      // Tell the external system exactly where to respond
      approve_url: `http://localhost:${localPort}/approve`,
      reject_url: `http://localhost:${localPort}/reject`,
    }
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    console.log(`[approval-server] Forwarded to external system: ${url}`)
  } catch (err) {
    console.warn(`[approval-server] Failed to forward to ${url}:`, err)
  }
}
