import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  parseProspectIntakePayload,
  ProspectIntakeConflictError,
  type ProspectIntakeInput,
  type ProspectIntakeResult,
} from "../intake/prospect-intake.js";
import {
  INTAKE_CONFIRM_FIELD,
  INTAKE_CONFIRM_VALUE,
  INTAKE_FIELDS,
  INTAKE_PAGE_CSP,
  renderErrorPage,
  renderIntakeConflict,
  renderIntakeForm,
  renderIntakeOutcomeUnknown,
  renderIntakeReview,
  renderIntakeSuccess,
  type IntakeFormValues,
} from "./intake-pages.js";

// v1 is a loopback-only operator tool; the bind address is deliberately not configurable.
export const INTAKE_UI_HOST = "127.0.0.1";
export const DEFAULT_INTAKE_UI_PORT = 4310;
export const MAX_INTAKE_FORM_BYTES = 16 * 1024;

export type IntakeServerEvent =
  | {
      event: "intake_created" | "intake_existing";
      requestId: string;
      prospectId: string;
    }
  | { event: "intake_conflict"; requestId: string }
  | { event: "intake_outcome_unknown"; requestId: string; error: string }
  | { event: "request_failed"; error: string };

export type IntakeServerDependencies = {
  createProspect: (input: ProspectIntakeInput) => Promise<ProspectIntakeResult>;
  generateRequestId?: () => string;
  log?: (event: IntakeServerEvent) => void;
};

type Route = {
  method: "GET" | "POST";
  handle: (req: IncomingMessage, res: ServerResponse, host: string) => Promise<void> | void;
};
type SubmittedForm = { values: IntakeFormValues; confirmed: boolean };

const PAGE_HEADERS: OutgoingHttpHeaders = {
  "cache-control": "no-store",
  "content-security-policy": INTAKE_PAGE_CSP,
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const PROSPECT_FORM_FIELDS = new Set<string>(INTAKE_FIELDS);
const CONFIRMED_FORM_FIELDS = new Set<string>([...INTAKE_FIELDS, INTAKE_CONFIRM_FIELD]);

export function parseIntakeUiPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_INTAKE_UI_PORT;
  const port = /^[1-9]\d{0,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!(port <= 65535)) {
    throw new Error("RELAY_INTAKE_UI_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function sendPage(
  res: ServerResponse,
  status: number,
  html: string,
  headers: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, {
    ...PAGE_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    ...headers,
  });
  res.end(html);
}

// Error pages carry fixed text only: never submitted input or exception messages.
function sendError(
  res: ServerResponse,
  status: number,
  title: string,
  message: string,
  headers: OutgoingHttpHeaders = {},
): void {
  sendPage(res, status, renderErrorPage(title, message), headers);
}

// Names and codes only: driver messages can quote submitted values.
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)
    ? `${error.name} ${code}`
    : error.name;
}

// Checking Host blocks DNS rebinding; POSTs must also come from this exact loopback origin.
function allowedHosts(server: Server): ReadonlySet<string> {
  const address = server.address();
  if (!address || typeof address === "string") return new Set();
  const hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
  if (address.port === 80) hosts.push("127.0.0.1", "localhost");
  return new Set(hosts);
}

function isSameOriginPost(req: IncomingMessage, host: string): boolean {
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin") return false;
  return req.headers.origin === `http://${host}`;
}

function isFormSubmission(req: IncomingMessage): boolean {
  const type = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  return type === "application/x-www-form-urlencoded";
}

function readBody(req: IncomingMessage): Promise<Buffer | "too_large"> {
  if (Number(req.headers["content-length"] ?? 0) > MAX_INTAKE_FORM_BYTES) {
    return Promise.resolve("too_large");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      finish();
    };
    // Past the limit, keep draining without buffering so the 413 reaches the client.
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_INTAKE_FORM_BYTES) settle(() => resolve("too_large"));
      else chunks.push(chunk);
    });
    req.on("end", () => settle(() => resolve(Buffer.concat(chunks, size))));
    req.on("error", (error) => settle(() => reject(error)));
    req.on("close", () => settle(() => reject(new Error("Request body was not completed."))));
  });
}

// Strict form contract: unknown, duplicated, or non-UTF-8 fields are malformed.
function parseForm(body: Buffer, allowed: ReadonlySet<string>): Map<string, string> | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  const fields = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(text)) {
    if (!allowed.has(name) || fields.has(name)) return null;
    fields.set(name, value);
  }
  return fields;
}

async function readForm(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  allowed: ReadonlySet<string>,
): Promise<SubmittedForm | null> {
  if (!isSameOriginPost(req, host)) {
    sendError(res, 403, "Request rejected",
      "Relay accepts this form only from its own pages at a loopback address. Nothing was created.");
    return null;
  }
  if (!isFormSubmission(req)) {
    sendError(res, 415, "Unsupported submission",
      "Relay accepts only standard HTML form submissions here. Nothing was created.");
    return null;
  }
  const body = await readBody(req);
  if (body === "too_large") {
    sendError(res, 413, "Submission too large",
      "The form submission exceeded the size limit. Nothing was created.", { connection: "close" });
    return null;
  }
  const fields = parseForm(body, allowed);
  if (!fields) {
    sendError(res, 400, "Submission not accepted",
      "Relay could not read this form submission. Nothing was created.");
    return null;
  }
  const values: IntakeFormValues = {};
  for (const name of INTAKE_FIELDS) {
    const value = fields.get(name);
    if (value !== undefined) values[name] = value;
  }
  return { values, confirmed: fields.get(INTAKE_CONFIRM_FIELD) === INTAKE_CONFIRM_VALUE };
}

// Prospect intake performs all validation; a rejection re-renders the form with the same request ID.
function parseOrRenderInvalid(values: IntakeFormValues, res: ServerResponse): ProspectIntakeInput | null {
  try {
    return parseProspectIntakePayload(values);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prospect intake input is invalid.";
    sendPage(res, 422, renderIntakeForm({ requestId: values.requestId ?? "", values, error: message }));
    return null;
  }
}

function createIntakeServer(dependencies: IntakeServerDependencies): Server {
  const generateRequestId = dependencies.generateRequestId ?? randomUUID;
  const log = (event: IntakeServerEvent) => {
    try {
      dependencies.log?.(event);
    } catch {
      /* Logging must not change the operator's result. */
    }
  };

  async function createProspect(input: ProspectIntakeInput, res: ServerResponse): Promise<void> {
    let result: ProspectIntakeResult;
    try {
      result = await dependencies.createProspect(input);
    } catch (error) {
      if (error instanceof ProspectIntakeConflictError) {
        log({ event: "intake_conflict", requestId: input.requestId });
        sendPage(res, 409, renderIntakeConflict(input.requestId, error.message));
        return;
      }
      // Anything else may have committed: keep the request ID and direct an unchanged retry.
      log({ event: "intake_outcome_unknown", requestId: input.requestId, error: errorKind(error) });
      sendPage(res, 500, renderIntakeOutcomeUnknown(input.requestId));
      return;
    }
    log({
      event: result.created ? "intake_created" : "intake_existing",
      requestId: result.requestId,
      prospectId: result.prospectId,
    });
    sendPage(res, result.created ? 201 : 200, renderIntakeSuccess(result, input.requestId));
  }

  const routes = new Map<string, Route>([
    ["/", {
      method: "GET",
      handle: (_req, res) => sendPage(res, 200, renderIntakeForm({ requestId: generateRequestId() })),
    }],
    ["/healthz", {
      method: "GET",
      handle: (_req, res) => {
        res.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        res.end("ok\n");
      },
    }],
    ["/review", {
      method: "POST",
      handle: async (req, res, host) => {
        const form = await readForm(req, res, host, PROSPECT_FORM_FIELDS);
        const input = form && parseOrRenderInvalid(form.values, res);
        if (input) sendPage(res, 200, renderIntakeReview(input));
      },
    }],
    ["/edit", {
      method: "POST",
      handle: async (req, res, host) => {
        const form = await readForm(req, res, host, PROSPECT_FORM_FIELDS);
        if (!form) return;
        sendPage(res, 200, renderIntakeForm({ requestId: form.values.requestId ?? "", values: form.values }));
      },
    }],
    ["/prospects", {
      method: "POST",
      handle: async (req, res, host) => {
        const form = await readForm(req, res, host, CONFIRMED_FORM_FIELDS);
        if (!form) return;
        if (!form.confirmed) {
          sendError(res, 400, "Confirmation required",
            "Prospects are created only from the review page after you confirm. Nothing was created.");
          return;
        }
        const input = parseOrRenderInvalid(form.values, res);
        if (input) await createProspect(input, res);
      },
    }],
  ]);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host?.toLowerCase();
    if (!host || !allowedHosts(server).has(host)) {
      sendError(res, 403, "Request rejected",
        "Relay accepts requests only at its loopback address. Nothing was created.");
      return;
    }
    // Exact origin-form paths only; absolute-form targets are not routed.
    const route = routes.get((req.url ?? "").split("?", 1)[0] ?? "");
    if (!route) {
      sendError(res, 404, "Page not found", "This page does not exist.");
      return;
    }
    if (req.method !== route.method) {
      sendError(res, 405, "Method not allowed",
        "This page does not accept that request method. Nothing was created.", { allow: route.method });
      return;
    }
    await route.handle(req, res, host);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log({ event: "request_failed", error: errorKind(error) });
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      sendError(res, 500, "Something went wrong", "Relay could not complete this request.");
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

export function startIntakeServer(
  options: IntakeServerDependencies & { port: number },
): Promise<Server> {
  const { port, ...dependencies } = options;
  const server = createIntakeServer(dependencies);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: INTAKE_UI_HOST, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
