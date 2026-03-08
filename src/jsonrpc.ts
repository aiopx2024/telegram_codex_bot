import { isRecord } from "./shared.ts";

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

export function normalizeJsonRpcId(id: unknown): string | null {
  if (typeof id === "string" && id.trim()) {
    return id;
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  return null;
}

export function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  if ("jsonrpc" in value && value.jsonrpc !== "2.0") {
    return false;
  }
  return true;
}
