# LangChain Agent Example

Minimal `InteractionAgent` example powered by LangChain chat models.

## What it demonstrates

- Adapting `ChatOpenAI` from LangChain to `IStreamingLLM`
- Running a one-turn `InteractionAgent` with the current v2 runtime
- Keeping framework-specific LLM code outside of the agent core

## Environment

```bash
OPENAI_API_KEY=...
# optional
LANGCHAIN_MODEL=gpt-4o-mini
```

## Run

```bash
pnpm --filter langchain-agent-example run
```
