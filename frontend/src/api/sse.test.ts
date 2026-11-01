import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse";

describe("createSseParser", () => {
  it("parses messages with event, id and data", () => {
    const parser = createSseParser();
    expect(parser.push('id: 3\nevent: trace\ndata: {"seq":3}\n\n')).toEqual([
      { event: "trace", data: '{"seq":3}', id: "3" },
    ]);
  });

  it("joins messages split across chunks at any point", () => {
    const text = 'retry: 2000\n\nid: 1\nevent: trace\ndata: {"a":1}\n\nevent: end\ndata: {"b":2}\n\n';
    for (let cut = 1; cut < text.length; cut++) {
      const parser = createSseParser();
      const messages = [...parser.push(text.slice(0, cut)), ...parser.push(text.slice(cut))];
      expect(messages, `cut at ${cut}`).toEqual([
        { event: "trace", data: '{"a":1}', id: "1" },
        { event: "end", data: '{"b":2}', id: null },
      ]);
    }
  });

  it("ignores keepalive comments and retry fields", () => {
    const parser = createSseParser();
    expect(parser.push(": keepalive\n\nretry: 100\n\n: another\n\n")).toEqual([]);
  });

  it("accepts CRLF and CR line endings, including a CRLF split across chunks", () => {
    const parser = createSseParser();
    expect(parser.push("event: trace\r\ndata: x\r")).toEqual([]);
    expect(parser.push("\n\r\nevent: end\rdata: y\r\r")).toEqual([{ event: "trace", data: "x", id: null }]);
    // A final \r may be the first half of \r\n: the message completes with the next character.
    expect(parser.push("\n")).toEqual([{ event: "end", data: "y", id: null }]);
  });

  it("joins multi-line data and defaults the event name", () => {
    const parser = createSseParser();
    expect(parser.push("data: one\ndata: two\n\n")).toEqual([{ event: "message", data: "one\ntwo", id: null }]);
  });

  it("waits for the blank line before emitting", () => {
    const parser = createSseParser();
    expect(parser.push("event: trace\ndata: {}\n")).toEqual([]);
    expect(parser.push("\n")).toHaveLength(1);
  });
});
