import type { IApprovalQueue } from 'fitalyagents'

/**
 * Incoming webhook payload for order approvals.
 */
export interface ApprovalWebhookBody {
    action: 'approve' | 'reject'
    draft_id: string
    /** Required when action is 'approve' */
    approver_id?: string
    /** Required when action is 'reject' */
    reason?: string
}

/**
 * Minimal request/response types compatible with Express and Hono.
 */
export interface WebhookRequest {
    body: ApprovalWebhookBody
}

export interface WebhookResponse {
    status(code: number): WebhookResponse
    json(data: unknown): void
}

/**
 * Creates an Express/Hono-compatible webhook handler for order approvals.
 *
 * Mount at `POST /webhook/approval` in your HTTP server:
 *
 * @example Express:
 * ```typescript
 * const approvalQueue = new InMemoryApprovalQueue({ bus })
 * app.post('/webhook/approval', createApprovalWebhookHandler(approvalQueue))
 * ```
 *
 * @example Hono:
 * ```typescript
 * const handler = createApprovalWebhookHandler(approvalQueue)
 * app.post('/webhook/approval', async (c) => {
 *   const body = await c.req.json()
 *   const req = { body }
 *   let statusCode = 200
 *   let responseData: unknown
 *   const res = {
 *     status: (code: number) => { statusCode = code; return res },
 *     json: (data: unknown) => { responseData = data },
 *   }
 *   await handler(req, res)
 *   return c.json(responseData, statusCode)
 * })
 * ```
 *
 * Payload schema:
 * ```json
 * { "action": "approve", "draft_id": "draft_001", "approver_id": "manager_alice" }
 * { "action": "reject",  "draft_id": "draft_001", "reason": "Insufficient stock" }
 * ```
 */
export function createApprovalWebhookHandler(queue: IApprovalQueue) {
    return async (req: WebhookRequest, res: WebhookResponse): Promise<void> => {
        const { action, draft_id, approver_id, reason } = req.body

        if (!draft_id) {
            res.status(400).json({ error: 'draft_id is required' })
            return
        }

        try {
            if (action === 'approve') {
                if (!approver_id) {
                    res.status(400).json({ error: 'approver_id is required for approve action' })
                    return
                }
                await queue.approve(draft_id, approver_id)
                res.status(200).json({ ok: true, draft_id, action: 'approved' })
            } else if (action === 'reject') {
                const rejectReason = reason ?? 'No reason provided'
                await queue.reject(draft_id, rejectReason)
                res.status(200).json({ ok: true, draft_id, action: 'rejected' })
            } else {
                res.status(400).json({ error: `Invalid action: ${String(action)}. Must be 'approve' or 'reject'.` })
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const isNotFound = message.includes('No pending approval')
            const isAlreadyResolved = message.includes('already resolved')
            const statusCode = isNotFound ? 404 : isAlreadyResolved ? 409 : 500
            res.status(statusCode).json({ error: message })
        }
    }
}
