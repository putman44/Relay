import { Client } from "pg";

// The isolated Ask Relay demo database: loopback only, named relay_demo.
export const DEMO_DATABASE_NAME = "relay_demo";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class DemoDatabaseError extends Error {
  constructor() {
    super(
      "Ask Relay demo tools connect only to a loopback database named relay_demo.",
    );
    this.name = "DemoDatabaseError";
  }
}

// Returns the URL unchanged when it can only reach the local demo database.
// Both the URL text and the host and database pg would actually use are
// checked, so query parameters such as ?host= cannot redirect the connection.
export function requireDemoDatabaseUrl(value: string | undefined): string {
  let url: URL;
  let client: Client;
  try {
    url = new URL(value ?? "");
    client = new Client({ connectionString: value });
  } catch {
    throw new DemoDatabaseError();
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    decodeURIComponent(url.pathname) !== `/${DEMO_DATABASE_NAME}` ||
    !LOOPBACK_HOSTS.has(client.host) ||
    client.database !== DEMO_DATABASE_NAME
  )
    throw new DemoDatabaseError();
  return value!;
}
