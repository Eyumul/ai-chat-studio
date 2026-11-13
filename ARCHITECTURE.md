# AI Chat Studio — Architecture & Rules

## Core Constraints
- **$0 Cost Only:** No paid DBs, no paid auth services, no mandatory paid APIs.
- **Local-First Persistence:** Conversations, presets, and BYOK API keys are stored client-side in IndexedDB (Dexie.js). Never store user API keys on a server or log them.
- **Hybrid Model Routing:**
  - Cloud providers (OpenRouter, Gemini, Groq, OpenAI, Anthropic) -> stateless Next.js Route Handler (`/api/chat`) to avoid CORS and normalize streams.
  - Local providers (Ollama, LM Studio on localhost) -> direct browser fetch via the client adapter.

## Code Standards
- TypeScript strict mode (`npx tsc --noEmit` must pass).
- All provider integrations must implement the unified adapter interface in `src/lib/adapters/types.ts`.
- UI never handles raw provider-specific SSE formats; `/api/chat` normalizes everything into our internal `StreamChunk` format.
- All new adapter logic must include Vitest unit tests with mocked streams (zero live API calls in tests).