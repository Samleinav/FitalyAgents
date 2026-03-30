# Vercel AI SDK Agent Example

Minimal `InteractionAgent` example powered by the Vercel AI SDK.

## What it demonstrates

- Adapting `streamText()` to `IStreamingLLM`
- Streaming text chunks through `InteractionAgent`
- Keeping the example aligned with the current event-driven runtime
- A text-first baseline for AI SDK adapters; extend the message mapper if you need full tool-part roundtrips

## Environment

```bash
OPENAI_API_KEY=...
# optional
VERCEL_AI_MODEL=gpt-4o-mini
```

## Run

```bash
pnpm --filter vercel-ai-sdk-agent-example run
```
