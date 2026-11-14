export type WebsiteDiagnosticKind =
  | "request_not_sent"
  | "provider_failed"
  | "provider_uncertain"
  | "response_invalid"
  | "persistence_failed"
  | "embedding_failed";

export type WebsiteDiagnostic = {
  version: 1;
  kind: WebsiteDiagnosticKind;
  stage: "collection" | "persistence" | "embedding";
  requestId: string;
  timestamp: string;
  providerRequestId?: string;
  httpStatus?: number;
};

export function parseWebsiteDiagnostic(value: string | null | undefined): WebsiteDiagnostic | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const item = parsed as Partial<WebsiteDiagnostic>;
    if (item.version !== 1 || !["request_not_sent", "provider_failed", "provider_uncertain", "response_invalid", "persistence_failed", "embedding_failed"].includes(item.kind ?? "") ||
      !["collection", "persistence", "embedding"].includes(item.stage ?? "") ||
      typeof item.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(item.requestId) ||
      typeof item.timestamp !== "string" || !Number.isFinite(Date.parse(item.timestamp))) return null;
    return item as WebsiteDiagnostic;
  } catch { return null; }
}
