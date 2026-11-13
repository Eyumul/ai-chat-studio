import type {
  ChatMessage,
  ProviderAdapter,
  StreamChunk,
  UnifiedChatRequest,
} from "./types";
import { parseSSEStream } from "./sse";

export const DEFAULT_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openai: "https://api.openai.com/v1",
  ollama: "http://localhost:11434/v1",
};

export class OpenAICompatAdapter implements ProviderAdapter {
  readonly id: string;

  constructor(id: string = "openai") {
    this.id = id;
  }

  async *streamChat(
    req: UnifiedChatRequest,
    apiKey: string,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk> {
    if (signal?.aborted) {
      return;
    }

    const rawBaseUrl =
      req.baseUrl ||
      DEFAULT_BASE_URLS[req.provider] ||
      DEFAULT_BASE_URLS[this.id] ||
      "https://api.openai.com/v1";

    const cleanBaseUrl = rawBaseUrl.replace(/\/+$/, "");
    const url = cleanBaseUrl.endsWith("/chat/completions")
      ? cleanBaseUrl
      : `${cleanBaseUrl}/chat/completions`;

    const messages: ChatMessage[] = [];
    if (req.systemInstruction) {
      messages.push({
        role: "system",
        content: req.systemInstruction,
      });
    }
    messages.push(...req.messages);

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      stream_options: {
        include_usage: true,
      },
    };

    if (req.params?.temperature !== undefined) {
      body.temperature = req.params.temperature;
    }
    if (req.params?.topP !== undefined) {
      body.top_p = req.params.topP;
    }
    if (req.params?.maxTokens !== undefined) {
      body.max_tokens = req.params.maxTokens;
    }
    if (req.params?.stop !== undefined) {
      body.stop = req.params.stop;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    let res: Response;
    try {
      if (signal?.aborted) {
        return;
      }

      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error: unknown) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        return;
      }
      const message = error instanceof Error ? error.message : "Failed to fetch";
      yield { type: "error", message };
      return;
    }

    if (signal?.aborted) {
      return;
    }

    if (!res.ok) {
      let message = `HTTP ${res.status}: ${res.statusText || "Request failed"}`;
      try {
        const errorText = await res.text();
        if (errorText) {
          try {
            const parsed = JSON.parse(errorText) as unknown;
            if (typeof parsed === "object" && parsed !== null) {
              const record = parsed as Record<string, unknown>;
              if (typeof record.error === "string") {
                message = record.error;
              } else if (
                typeof record.error === "object" &&
                record.error !== null &&
                "message" in record.error &&
                typeof (record.error as Record<string, unknown>).message === "string"
              ) {
                message = (record.error as Record<string, unknown>).message as string;
              } else if (typeof record.message === "string") {
                message = record.message;
              }
            }
          } catch {
            if (errorText.length < 500) {
              message = errorText;
            }
          }
        }
      } catch {
        // Ignore response text read error
      }
      yield { type: "error", message, status: res.status };
      return;
    }

    if (!res.body) {
      yield { type: "error", message: "Response body is empty", status: res.status };
      return;
    }

    let finishReason: string | undefined;

    try {
      for await (const raw of parseSSEStream(res.body)) {
        if (signal?.aborted) {
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }

        if (typeof parsed !== "object" || parsed === null) {
          continue;
        }

        const chunk = parsed as Record<string, unknown>;

        if ("error" in chunk && chunk.error) {
          let errMessage = "Stream error";
          if (typeof chunk.error === "string") {
            errMessage = chunk.error;
          } else if (
            typeof chunk.error === "object" &&
            chunk.error !== null &&
            "message" in chunk.error &&
            typeof (chunk.error as Record<string, unknown>).message === "string"
          ) {
            errMessage = (chunk.error as Record<string, unknown>).message as string;
          }
          yield { type: "error", message: errMessage };
          return;
        }

        if (Array.isArray(chunk.choices)) {
          for (const choice of chunk.choices) {
            if (typeof choice !== "object" || choice === null) {
              continue;
            }
            const choiceRecord = choice as Record<string, unknown>;
            if (typeof choiceRecord.finish_reason === "string") {
              finishReason = choiceRecord.finish_reason;
            }

            const delta = choiceRecord.delta;
            if (typeof delta === "object" && delta !== null) {
              const deltaRecord = delta as Record<string, unknown>;

              const reasoning =
                typeof deltaRecord.reasoning_content === "string"
                  ? deltaRecord.reasoning_content
                  : typeof deltaRecord.reasoning === "string"
                    ? deltaRecord.reasoning
                    : undefined;

              if (reasoning !== undefined && reasoning.length > 0) {
                yield { type: "reasoning", text: reasoning };
              }

              if (typeof deltaRecord.content === "string" && deltaRecord.content.length > 0) {
                yield { type: "delta", text: deltaRecord.content };
              }
            }
          }
        }

        if (typeof chunk.usage === "object" && chunk.usage !== null) {
          const usageRecord = chunk.usage as Record<string, unknown>;
          const tokensIn =
            typeof usageRecord.prompt_tokens === "number"
              ? usageRecord.prompt_tokens
              : typeof usageRecord.input_tokens === "number"
                ? usageRecord.input_tokens
                : 0;
          const tokensOut =
            typeof usageRecord.completion_tokens === "number"
              ? usageRecord.completion_tokens
              : typeof usageRecord.output_tokens === "number"
                ? usageRecord.output_tokens
                : 0;

          yield {
            type: "usage",
            tokensIn,
            tokensOut,
          };
        }
      }

      if (signal?.aborted) {
        return;
      }

      yield finishReason ? { type: "done", finishReason } : { type: "done" };
    } catch (error: unknown) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        return;
      }
      const message = error instanceof Error ? error.message : "Stream processing error";
      yield { type: "error", message };
    }
  }
}

