import { describe, expect, it } from "vitest";
import { isJsonRpcMessage, normalizeJsonRpcId } from "../src/jsonrpc.ts";

describe("jsonrpc helpers", () => {
  it("normalizes valid ids", () => {
    expect(normalizeJsonRpcId("abc")).toBe("abc");
    expect(normalizeJsonRpcId(42)).toBe("42");
    expect(normalizeJsonRpcId("")).toBeNull();
  });

  it("accepts messages without explicit jsonrpc version", () => {
    expect(isJsonRpcMessage({ id: "1", result: { ok: true } })).toBe(true);
    expect(isJsonRpcMessage({ jsonrpc: "2.0", method: "ping" })).toBe(true);
    expect(isJsonRpcMessage({ jsonrpc: "1.0", method: "ping" })).toBe(false);
  });
});
