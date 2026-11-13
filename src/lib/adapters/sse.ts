interface ProcessedLine {
  type: "yield" | "done" | "skip";
  data: string;
}

function processSSELine(rawLine: string): ProcessedLine {
  let line = rawLine;
  if (line.endsWith("\r")) {
    line = line.slice(0, -1);
  }

  // Ignore empty lines
  if (!line) {
    return { type: "skip", data: "" };
  }

  // Ignore SSE comments
  if (line.startsWith(":")) {
    return { type: "skip", data: "" };
  }

  // Strip 'data:' prefix
  if (line.startsWith("data:")) {
    let data = line.slice(5);
    if (data.startsWith(" ")) {
      data = data.slice(1);
    }
    if (data.trim() === "[DONE]") {
      return { type: "done", data: "" };
    }
    return { type: "yield", data };
  }

  return { type: "skip", data: "" };
}

export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        const result = processSSELine(rawLine);
        if (result.type === "done") {
          return;
        }
        if (result.type === "yield") {
          yield result.data;
        }
      }
    }

    // Flush any pending decoded characters from TextDecoder
    buffer += decoder.decode();

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      const result = processSSELine(rawLine);
      if (result.type === "done") {
        return;
      }
      if (result.type === "yield") {
        yield result.data;
      }
    }

    // Flush any trailing buffer without newline
    if (buffer.length > 0) {
      const result = processSSELine(buffer);
      buffer = "";
      if (result.type === "done") {
        return;
      }
      if (result.type === "yield") {
        yield result.data;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore if lock was already released
    }
  }
}

