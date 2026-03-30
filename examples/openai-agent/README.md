# OpenAI Agent Example

Minimal `InteractionAgent` example powered by the official OpenAI Node SDK.

## What it demonstrates

- Adapting `openai` to the `IStreamingLLM` interface from `fitalyagents`
- Running a one-turn `InteractionAgent` with `InMemoryBus` and `InMemoryContextStore`
- Capturing streamed text through `ttsCallback`

## Environment

```bash
OPENAI_API_KEY=...
# optional
OPENAI_MODEL=gpt-4o-mini
```

## Run

```bash
pnpm --filter openai-agent-example run
```
