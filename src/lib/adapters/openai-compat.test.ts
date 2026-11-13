import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { parseSSEStream } from "./sse";
import { OpenAICompatAdapter } from "./openai-compat";
import type { UnifiedChatRequest } from "./types";

function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collectAsyncGenerator<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

describe("parseSSEStream", () => {
  it("handles a single data JSON line split mid-word across two chunks, plus [DONE]", async () => {
    const chunk1 = 'data: {"id": "1", "choices": [{"delta": {"con';
    const chunk2 = 'tent": "Hello"}}\n\ndata: [DONE]\n\n';

    const stream = createMockStream([chunk1, chunk2]);
    const lines = await collectAsyncGenerator(parseSSEStream(stream));

    expect(lines).toEqual([
      '{"id": "1", "choices": [{"delta": {"content": "Hello"}}',
    ]);
  });

  it("ignores empty lines and comment lines starting with ':'", async () => {
    const chunks = [
      ": keep-alive comment\n\n",
      'data: {"msg": 1}\n\n',
      ": another comment\n",
      "\n",
      'data: {"msg": 2}\n\n',
      "data: [DONE]\n",
    ];

    const stream = createMockStream(chunks);
    const lines = await collectAsyncGenerator(parseSSEStream(stream));

    expect(lines).toEqual(['{"msg": 1}', '{"msg": 2}']);
  });

  it("flushes trailing buffer on stream end without newline", async () => {
    const chunks = ['data: {"trailing": true}'];
    const stream = createMockStream(chunks);
    const lines = await collectAsyncGenerator(parseSSEStream(stream));

    expect(lines).toEqual(['{"trailing": true}']);
  });

  it("handles CRLF (\\r\\n) line endings correctly", async () => {
    const chunks = ['data: {"crlf": true}\r\n\r\ndata: [DONE]\r\n'];
    const stream = createMockStream(chunks);
    const lines = await collectAsyncGenerator(parseSSEStream(stream));

    expect(lines).toEqual(['{"crlf": true}']);
  });

  it("releases reader lock in finally block even on early exit", async () => {
    const stream = createMockStream([
      'data: {"item": 1}\n\n',
      'data: {"item": 2}\n\n',
    ]);

    for await (const line of parseSSEStream(stream)) {
      expect(line).toBe('{"item": 1}');
      break;
    }

    expect(stream.locked).toBe(false);
  });
});

describe("OpenAICompatAdapter", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes reasoning_content, content, usage, done, Authorization header, and systemInstruction prepending", async () => {
    const streamChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"Step 1 reasoning"}}]}\n\n',
      'data: {"id":"c2","choices":[{"index":0,"delta":{"content":"Hello from LLM"}}]}\n\n',
      'data: {"id":"c3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"c4","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}\n\n',
      "data: [DONE]\n\n",
    ];

    fetchSpy.mockResolvedValueOnce(
      new Response(createMockStream(streamChunks), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const adapter = new OpenAICompatAdapter("openai");
    const request: UnifiedChatRequest = {
      provider: "openai",
      model: "gpt-4o",
      systemInstruction: "Always answer concisely.",
      messages: [{ role: "user", content: "Hi" }],
      params: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 500,
        stop: ["\n\n"],
      },
    };

    const chunks = await collectAsyncGenerator(
      adapter.streamChat(request, "sk-test-key-123")
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe("https://api.openai.com/v1/chat/completions");

    const headers = calledInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const parsedBody = JSON.parse(
      calledInit?.body as string
    ) as Record<string, unknown>;
    expect(parsedBody.model).toBe("gpt-4o");
    expect(parsedBody.stream).toBe(true);
    expect(parsedBody.stream_options).toEqual({ include_usage: true });
    expect(parsedBody.temperature).toBe(0.7);
    expect(parsedBody.top_p).toBe(0.9);
    expect(parsedBody.max_tokens).toBe(500);
    expect(parsedBody.stop).toEqual(["\n\n"]);

    expect(parsedBody.messages).toEqual([
      { role: "system", content: "Always answer concisely." },
      { role: "user", content: "Hi" },
    ]);

    expect(chunks).toEqual([
      { type: "reasoning", text: "Step 1 reasoning" },
      { type: "delta", text: "Hello from LLM" },
      { type: "usage", tokensIn: 12, tokensOut: 34 },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("normalizes alternative delta.reasoning field", async () => {
    const streamChunks = [
      'data: {"choices":[{"delta":{"reasoning":"Alternative reasoning text"}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    fetchSpy.mockResolvedValueOnce(
      new Response(createMockStream(streamChunks), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const adapter = new OpenAICompatAdapter("openrouter");
    const request: UnifiedChatRequest = {
      provider: "openrouter",
      model: "deepseek/deepseek-r1",
      messages: [{ role: "user", content: "Solve x + 1 = 2" }],
    };

    const chunks = await collectAsyncGenerator(
      adapter.streamChat(request, "sk-or-key")
    );

    expect(chunks).toEqual([
      { type: "reasoning", text: "Alternative reasoning text" },
      { type: "done" },
    ]);
  });

  it("normalizes HTTP 401 error with provider JSON error body", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "Incorrect API key provided: sk-invalid",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const adapter = new OpenAICompatAdapter("openai");
    const request: UnifiedChatRequest = {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    };

    const chunks = await collectAsyncGenerator(
      adapter.streamChat(request, "invalid-key")
    );

    expect(chunks).toEqual([
      {
        type: "error",
        message: "Incorrect API key provided: sk-invalid",
        status: 401,
      },
    ]);
  });

  it("normalizes HTTP 404 error with string error field", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "model 'llama3' not found",
        }),
        {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const adapter = new OpenAICompatAdapter("ollama");
    const request: UnifiedChatRequest = {
      provider: "ollama",
      model: "llama3",
      messages: [{ role: "user", content: "Hi" }],
    };

    const chunks = await collectAsyncGenerator(adapter.streamChat(request, ""));

    expect(chunks).toEqual([
      {
        type: "error",
        message: "model 'llama3' not found",
        status: 404,
      },
    ]);
  });

  it("normalizes HTTP error with plain text error body", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Bad Gateway", {
        status: 502,
        statusText: "Bad Gateway",
      })
    );

    const adapter = new OpenAICompatAdapter("groq");
    const request: UnifiedChatRequest = {
      provider: "groq",
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "Hi" }],
    };

    const chunks = await collectAsyncGenerator(
      adapter.streamChat(request, "groq-key")
    );

    expect(chunks).toEqual([
      {
        type: "error",
        message: "Bad Gateway",
        status: 502,
      },
    ]);
  });

  it("maps default base URLs correctly for all supported providers", async () => {
    const providerExpectations: Array<{
      provider: UnifiedChatRequest["provider"];
      expectedUrl: string;
    }> = [
      {
        provider: "openrouter",
        expectedUrl: "https://openrouter.ai/api/v1/chat/completions",
      },
      {
        provider: "groq",
        expectedUrl: "https://api.groq.com/openai/v1/chat/completions",
      },
      {
        provider: "gemini",
        expectedUrl:
          "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      },
      {
        provider: "openai",
        expectedUrl: "https://api.openai.com/v1/chat/completions",
      },
      {
        provider: "ollama",
        expectedUrl: "http://localhost:11434/v1/chat/completions",
      },
    ];

    for (const { provider, expectedUrl } of providerExpectations) {
      fetchSpy.mockResolvedValueOnce(
        new Response(createMockStream(["data: [DONE]\n\n"]), { status: 200 })
      );

      const adapter = new OpenAICompatAdapter(provider);
      const request: UnifiedChatRequest = {
        provider,
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await collectAsyncGenerator(adapter.streamChat(request, "key"));
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      expect(lastCall[0]).toBe(expectedUrl);
    }
  });

  it("allows baseUrl override in request", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(createMockStream(["data: [DONE]\n\n"]), { status: 200 })
    );

    const adapter = new OpenAICompatAdapter("openai");
    const request: UnifiedChatRequest = {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      baseUrl: "https://custom-proxy.internal/v1",
    };

    await collectAsyncGenerator(adapter.streamChat(request, "key"));
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    expect(lastCall[0]).toBe("https://custom-proxy.internal/v1/chat/completions");
  });

  it("exits silently without emitting an error chunk when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const adapter = new OpenAICompatAdapter("openai");
    const request: UnifiedChatRequest = {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    };

    const chunks = await collectAsyncGenerator(
      adapter.streamChat(request, "key", controller.signal)
    );

    expect(chunks).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exits silently without emitting an error chunk when fetch throws AbortError", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("This operation was aborted", "AbortError");

    fetchSpy.mockRejectedValueOnce(abortError);

    const adapter = new OpenAICompatAdapter("openai");
    const request: UnifiedChatRequest = {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    };

    const chunks = await collectAsyncGenerator(
      adapter.streamChat(request, "key", controller.signal)
    );

    expect(chunks).toEqual([]);
  });
});
