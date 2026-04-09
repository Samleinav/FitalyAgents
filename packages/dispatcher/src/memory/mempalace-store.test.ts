import { describe, expect, it, vi } from 'vitest'
import {
  MemPalaceCliTransport,
  MemPalaceMcpTransport,
  MemPalaceMemoryStore,
  type MemPalaceCommandRunner,
  type MemPalaceMcpClient,
  type MemPalaceTransport,
} from './mempalace-store.js'

describe('MemPalaceMemoryStore', () => {
  it('delegates writes and normalizes transport search results', async () => {
    const transport: MemPalaceTransport = {
      write: vi.fn(),
      search: vi.fn().mockResolvedValue([
        {
          text: 'customer usually orders decaf coffee',
          wing: 'customer',
          room: 'cust_ana',
          similarity: 0.92,
        },
      ]),
    }
    const store = new MemPalaceMemoryStore({ transport })

    await store.write({
      text: 'customer usually orders decaf coffee',
      wing: 'customer',
      room: 'cust_ana',
    })
    const hits = await store.query('same coffee as before', {
      wing: 'customer',
      room: 'cust_ana',
    })

    expect(transport.write).toHaveBeenCalledWith({
      text: 'customer usually orders decaf coffee',
      wing: 'customer',
      room: 'cust_ana',
    })
    expect(transport.search).toHaveBeenCalledWith({
      text: 'same coffee as before',
      wing: 'customer',
      room: 'cust_ana',
      n: 3,
    })
    expect(hits).toEqual([
      {
        text: 'customer usually orders decaf coffee',
        wing: 'customer',
        room: 'cust_ana',
        similarity: 0.92,
      },
    ])
  })

  it('filters broad transport results by requested scope', async () => {
    const store = new MemPalaceMemoryStore({
      transport: {
        write: vi.fn(),
        search: vi.fn().mockResolvedValue([
          { text: 'customer memory', wing: 'customer', room: 'cust_ana', similarity: 0.8 },
          { text: 'employee memory', wing: 'employee', room: 'staff_luis', similarity: 0.9 },
        ]),
      },
    })

    const hits = await store.query('memory', {
      wing: 'customer',
      room: 'cust_ana',
      n: 5,
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.text).toBe('customer memory')
  })
})

describe('MemPalaceCliTransport', () => {
  it('builds documented search commands with wing, room, and palace filters', async () => {
    const runner: MemPalaceCommandRunner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        {
          text: 'register two is slow',
          similarity: 0.86,
        },
      ]),
      stderr: '',
    })
    const transport = new MemPalaceCliTransport({
      command: 'mempalace',
      palacePath: '/tmp/palace',
      runner,
    })

    const hits = await transport.search({
      text: 'slow register',
      wing: 'store',
      room: 'store_001',
      n: 2,
    })

    expect(runner).toHaveBeenCalledWith(
      'mempalace',
      [
        'search',
        'slow register',
        '--wing',
        'store',
        '--room',
        'store_001',
        '--palace',
        '/tmp/palace',
      ],
      {
        cwd: undefined,
        env: undefined,
        timeoutMs: undefined,
      },
    )
    expect(hits).toEqual([
      {
        text: 'register two is slow',
        similarity: 0.86,
        metadata: {},
      },
    ])
  })

  it('writes through mempalace mine by default', async () => {
    const runner: MemPalaceCommandRunner = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const transport = new MemPalaceCliTransport({
      palacePath: '/tmp/palace',
      runner,
    })

    await transport.write({
      text: 'customer wants decaf coffee',
      wing: 'customer',
      room: 'cust_ana',
    })

    const [, args] = vi.mocked(runner).mock.calls[0]!
    expect(args[0]).toBe('mine')
    expect(args[2]).toBe('--mode')
    expect(args[3]).toBe('convos')
    expect(args).toContain('--wing')
    expect(args).toContain('customer')
    expect(args).toContain('--palace')
    expect(args).toContain('/tmp/palace')
  })
})

describe('MemPalaceMcpTransport', () => {
  it('calls MemPalace MCP search and write tools', async () => {
    const client: MemPalaceMcpClient = {
      callTool: vi.fn().mockImplementation((toolName: string) => {
        if (toolName === 'mempalace_search') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  results: [
                    {
                      text: 'employee checked sneaker inventory',
                      metadata: { wing: 'employee', room: 'staff_luis' },
                      score: 0.81,
                    },
                  ],
                }),
              },
            ],
          }
        }

        return { ok: true }
      }),
    }
    const transport = new MemPalaceMcpTransport({ client })

    const hits = await transport.search({
      text: 'inventory follow-up',
      wing: 'employee',
      room: 'staff_luis',
      n: 3,
    })
    await transport.write({
      text: 'employee checked sneaker inventory',
      wing: 'employee',
      room: 'staff_luis',
    })

    expect(client.callTool).toHaveBeenCalledWith('mempalace_search', {
      query: 'inventory follow-up',
      wing: 'employee',
      room: 'staff_luis',
      limit: 3,
    })
    expect(client.callTool).toHaveBeenCalledWith('mempalace_add_drawer', {
      content: 'employee checked sneaker inventory',
      text: 'employee checked sneaker inventory',
      wing: 'employee',
      room: 'staff_luis',
      metadata: {
        source: 'fitalyagents',
        wing: 'employee',
        room: 'staff_luis',
      },
    })
    expect(hits).toEqual([
      {
        text: 'employee checked sneaker inventory',
        wing: 'employee',
        room: 'staff_luis',
        similarity: 0.81,
        metadata: {
          wing: 'employee',
          room: 'staff_luis',
        },
      },
    ])
  })
})
