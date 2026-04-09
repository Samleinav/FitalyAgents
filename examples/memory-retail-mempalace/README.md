# Memory Retail MemPalace Example

This example wires FitalyAgents memory to the real MemPalace backend through the
`MemPalaceMemoryStore` adapter.

## Why MemPalace

The in-process `InMemoryMemoryStore` is useful for tests, demos, and embedded
runtime memory. MemPalace is a better fit when you want local persistent search
backed by ChromaDB and the MemPalace palace structure. The PyPI package
documents strong raw/verbatim retrieval results, so the recommended production
shape is:

- use MemPalace raw search as the persistent backend
- keep `memoryScopeResolver` to prevent customer, employee, group, and store
  context from mixing
- prefer MCP for a long-running service
- use CLI for local development, scripts, and prototypes

## Install MemPalace

```bash
python3 -m venv .venv-mempalace
source .venv-mempalace/bin/activate
python -m pip install -U pip
python -m pip install mempalace
mempalace init ~/.mempalace/fitaly-retail
```

## Run With CLI

The CLI transport shells out to `mempalace search` for reads and uses
`mempalace mine` on a temporary conversation file for writes.

```bash
pnpm --filter fitalyagents build
pnpm --filter @fitalyagents/dispatcher build
MEMPALACE_TRANSPORT=cli \
MEMPALACE_PALACE="$HOME/.mempalace/fitaly-retail" \
pnpm --filter memory-retail-mempalace-example run run
```

## Use With MCP

The MCP transport expects an MCP client object from your app. This keeps
`@fitalyagents/dispatcher` free of a hard MCP SDK dependency while still letting
you call MemPalace tools directly.

```ts
import {
  MemPalaceMcpTransport,
  MemPalaceMemoryStore,
  type MemPalaceMcpClient,
} from '@fitalyagents/dispatcher'

const client: MemPalaceMcpClient = {
  callTool: (name, args) => yourMcpClient.callTool(name, args),
}

const memoryStore = new MemPalaceMemoryStore({
  transport: new MemPalaceMcpTransport({ client }),
})
```

By default the adapter calls:

- `mempalace_search` for queries
- `mempalace_add_drawer` for writes

If your MemPalace MCP client exposes slightly different arguments, pass
`toSearchArgs`, `toWriteArgs`, or `parseSearchResponse`.
