export type ProviderId =
  | "openrouter"
  | "groq"
  | "gemini"
  | "openai"
  | "anthropic"
  | "ollama"
  | "custom";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[] | string;
}

export interface UnifiedChatRequest {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  systemInstruction?: string;
  params?: ChatParams;
  baseUrl?: string;
}

export type StreamChunk =
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "usage"; tokensIn: number; tokensOut: number }
  | { type: "done"; finishReason?: string }
  | { type: "error"; message: string; status?: number };

export interface ProviderAdapter {
  readonly id: string;
  streamChat(
    req: UnifiedChatRequest,
    apiKey: string,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk>;
}

