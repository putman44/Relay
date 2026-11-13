import { Client } from "pg";

export const DEV_DATABASE_NAME = "relay_dev";

/** Reject URL overrides (including libpq query parameters) before connecting. */
export function requireDevDatabaseUrl(value: string | undefined): string {
  let url: URL;
  let client: Client;
  try {
    url = new URL(value ?? "");
    client = new Client({ connectionString: value });
  } catch {
    throw new Error("Dev dashboard requires a loopback PostgreSQL URL for relay_dev.");
  }
  const local = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !local.has(url.hostname) || !local.has(client.host) ||
      decodeURIComponent(url.pathname) !== `/${DEV_DATABASE_NAME}` ||
      client.database !== DEV_DATABASE_NAME) {
    throw new Error("Dev dashboard requires a loopback PostgreSQL URL for relay_dev.");
  }
  return value!;
}
