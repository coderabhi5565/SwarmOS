/**
 * A Server-Sent Events parser for text arriving in arbitrary chunks (the
 * WHATWG event-stream format: `field: value` lines, blank line ends a
 * message, lines starting with ":" are comments).
 */

export interface SseMessage {
  event: string;
  data: string;
  /** The message's id field, when it had one. */
  id: string | null;
}

export interface SseParser {
  /** Feed the next chunk of text; returns the messages it completed. */
  push(chunk: string): SseMessage[];
}

export function createSseParser(): SseParser {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | null = null;

  function line(text: string, out: SseMessage[]) {
    if (text === "") {
      if (data.length > 0) out.push({ event: event || "message", data: data.join("\n"), id });
      event = "";
      data = [];
      id = null;
      return;
    }
    if (text.startsWith(":")) return; // comment: a keepalive, never an event
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
    // "retry" and unknown fields are ignored: reconnection is ours to pace.
  }

  return {
    push(chunk) {
      buffer += chunk;
      const out: SseMessage[] = [];
      // Lines end with \n, \r\n or \r. A trailing \r may be half of a \r\n,
      // so it waits for the next chunk.
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i];
        if (char !== "\n" && char !== "\r") continue;
        if (char === "\r" && i === buffer.length - 1) break;
        line(buffer.slice(start, i), out);
        if (char === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
  };
}
