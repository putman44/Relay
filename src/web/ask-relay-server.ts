import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { IndexedProspect } from "../data/research-embeddings.js";
import type { AskRelayResult } from "../research/ask-relay.js";
import {
  ANSWER_PATH,
  answerPath,
  ASK_CONFIRM_FIELD,
  ASK_CONFIRM_VALUE,
  ASK_ID_FIELD,
  ASK_PAGE_CSP,
  ASK_PATH,
  ASK_PROSPECT_FIELD,
  ASK_QUESTION_FIELD,
  MAX_QUESTION_CHARS,
  renderAskAnswer,
  renderAskErrorPage,
  renderAskFailed,
  renderAskForm,
  renderAskPending,
  type AskSummary,
} from "./ask-relay-pages.js";

// A loopback-only demo tool; the bind address is deliberately not configurable.
export const ASK_UI_HOST = "127.0.0.1";
export const DEFAULT_ASK_UI_PORT = 4311;
export const MAX_ASK_FORM_BYTES = 8 * 1024;
// Bounds paid calls in flight and answers kept in memory.
export const MAX_RUNNING_ASKS = 2;
export const MAX_STORED_ASKS = 50;

export type AskServerEvent =
  | { event: "ask_started"; askId: string; prospectId: string }
  | {
      event: "ask_finished";
      askId: string;
      status: AskRelayResult["status"];
      reason: AskRelayResult["reason"];
    }
  | { event: "ask_failed"; askId: string; error: string }
  | { event: "request_failed"; error: string };

export type AskServerDependencies = {
  // Prospects with embedded research; the only ones a question may target.
  listProspects: () => Promise<IndexedProspect[]>;
  ask: (input: {
    prospectId: string;
    question: string;
  }) => Promise<AskRelayResult>;
  generateAskId?: () => string;
  log?: (event: AskServerEvent) => void;
};

type AskRun = { summary: AskSummary } & (
  | { state: "running" }
  | { state: "done"; result: AskRelayResult }
  | { state: "failed" }
);
type Route = {
  method: "GET" | "POST";
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    host: string,
  ) => Promise<void> | void;
};

const PAGE_HEADERS: OutgoingHttpHeaders = {
  "cache-control": "no-store",
  "content-security-policy": ASK_PAGE_CSP,
  // Not "no-referrer": under it, browsers send `Origin: null` on form posts,
  // which the same-origin check rightly refuses.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const ASK_FORM_FIELDS = new Set([
  ASK_ID_FIELD,
  ASK_PROSPECT_FIELD,
  ASK_QUESTION_FIELD,
  ASK_CONFIRM_FIELD,
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseAskUiPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_ASK_UI_PORT;
  const port = /^[1-9]\d{0,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!(port <= 65535))
    throw new Error("RELAY_ASK_UI_PORT must be an integer from 1 to 65535.");
  return port;
}

// The trimmed question, or the reason it cannot be asked.
export function validateQuestion(
  raw: string,
): { question: string } | { error: string } {
  const question = raw.trim();
  if (!question) return { error: "Enter a question." };
  if (question.length > MAX_QUESTION_CHARS)
    return {
      error: `Questions can be at most ${MAX_QUESTION_CHARS} characters.`,
    };
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(question))
    return { error: "The question contains characters Relay cannot accept." };
  return { question };
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
  sendPage(res, status, renderAskErrorPage(title, message), headers);
}

// Names and codes only: provider and driver messages can quote content.
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

function readBody(req: IncomingMessage): Promise<Buffer | "too_large"> {
  if (Number(req.headers["content-length"] ?? 0) > MAX_ASK_FORM_BYTES)
    return Promise.resolve("too_large");
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
      if (size > MAX_ASK_FORM_BYTES) settle(() => resolve("too_large"));
      else chunks.push(chunk);
    });
    req.on("end", () => settle(() => resolve(Buffer.concat(chunks, size))));
    req.on("error", (error) => settle(() => reject(error)));
    req.on("close", () =>
      settle(() => reject(new Error("Request body was not completed."))),
    );
  });
}

// Strict form contract: unknown, duplicated, or non-UTF-8 fields are malformed.
function parseForm(body: Buffer): Map<string, string> | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  const fields = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(text)) {
    if (!ASK_FORM_FIELDS.has(name) || fields.has(name)) return null;
    fields.set(name, value);
  }
  return fields;
}

async function readFields(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
): Promise<Map<string, string> | null> {
  if (!isSameOriginPost(req, host)) {
    sendError(
      res,
      403,
      "Request rejected",
      "Ask Relay accepts questions only from its own page at a loopback address. Nothing was asked.",
    );
    return null;
  }
  const type = req.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    sendError(
      res,
      415,
      "Unsupported submission",
      "Ask Relay accepts only standard HTML form submissions. Nothing was asked.",
    );
    return null;
  }
  const body = await readBody(req);
  if (body === "too_large") {
    sendError(
      res,
      413,
      "Submission too large",
      "The form submission exceeded the size limit. Nothing was asked.",
      { connection: "close" },
    );
    return null;
  }
  const fields = parseForm(body);
  if (!fields) {
    sendError(
      res,
      400,
      "Submission not accepted",
      "Ask Relay could not read this form submission. Nothing was asked.",
    );
    return null;
  }
  return fields;
}

function createAskRelayServer(dependencies: AskServerDependencies): Server {
  const generateAskId = dependencies.generateAskId ?? randomUUID;
  const log = (event: AskServerEvent) => {
    try {
      dependencies.log?.(event);
    } catch {
      /* Logging must not change the operator's result. */
    }
  };
  // Recent answers, in memory only. Map order is insertion order.
  const runs = new Map<string, AskRun>();

  function remember(askId: string, run: AskRun): void {
    runs.set(askId, run);
    for (const [id, stored] of runs) {
      if (runs.size <= MAX_STORED_ASKS) break;
      if (stored.state !== "running") runs.delete(id);
    }
  }

  // Not awaited: the response redirects at once and the answer page polls.
  function launch(askId: string, summary: AskSummary): void {
    log({ event: "ask_started", askId, prospectId: summary.prospect.id });
    Promise.resolve()
      .then(() =>
        dependencies.ask({
          prospectId: summary.prospect.id,
          question: summary.question,
        }),
      )
      .then(
        (result) => {
          remember(askId, { summary, state: "done", result });
          log({
            event: "ask_finished",
            askId,
            status: result.status,
            reason: result.reason,
          });
        },
        (error: unknown) => {
          remember(askId, { summary, state: "failed" });
          log({ event: "ask_failed", askId, error: errorKind(error) });
        },
      );
  }

  async function ask(
    req: IncomingMessage,
    res: ServerResponse,
    host: string,
  ): Promise<void> {
    const fields = await readFields(req, res, host);
    if (!fields) return;
    if (fields.get(ASK_CONFIRM_FIELD) !== ASK_CONFIRM_VALUE) {
      sendError(
        res,
        400,
        "Confirmation required",
        "Questions are asked only from the Ask Relay button. Nothing was asked.",
      );
      return;
    }
    let askId = fields.get(ASK_ID_FIELD)?.toLowerCase() ?? "";
    if (!UUID.test(askId)) {
      sendError(
        res,
        400,
        "Submission not accepted",
        "This form is missing its ID. Reload the page and ask again. Nothing was asked.",
      );
      return;
    }

    const prospects = await dependencies.listProspects();
    const prospectId = fields.get(ASK_PROSPECT_FIELD)?.toLowerCase() ?? "";
    const prospect = prospects.find((item) => item.id === prospectId);
    const rawQuestion = fields.get(ASK_QUESTION_FIELD) ?? "";
    // Invalid input re-renders the form with the operator's values.
    const invalid = (error: string) =>
      sendPage(
        res,
        422,
        renderAskForm({
          askId,
          prospects,
          ...(prospect ? { selected: prospect.id } : {}),
          question: rawQuestion,
          error,
        }),
      );
    if (!prospect) return invalid("Choose one of the listed prospects.");
    const checked = validateQuestion(rawQuestion);
    if ("error" in checked) return invalid(checked.error);

    // A repeated submission of the same form never asks twice; an edited
    // resubmission of an earlier form is a new question with a fresh ID.
    const existing = runs.get(askId);
    const repeated =
      existing?.summary.prospect.id === prospect.id &&
      existing.summary.question === checked.question;
    if (!repeated) {
      if (existing) askId = generateAskId();
      const running = [...runs.values()].filter(
        (run) => run.state === "running",
      ).length;
      if (running >= MAX_RUNNING_ASKS) {
        sendError(
          res,
          429,
          "Relay is busy",
          "Relay is still answering earlier questions. Wait for them to finish, then ask again. Nothing was asked.",
        );
        return;
      }
      const summary = { prospect, question: checked.question };
      remember(askId, { summary, state: "running" });
      launch(askId, summary);
    }
    res.writeHead(303, {
      ...PAGE_HEADERS,
      "content-length": 0,
      location: answerPath(askId),
    });
    res.end();
  }

  async function answer(req: IncomingMessage, res: ServerResponse) {
    const query = new URLSearchParams((req.url ?? "").split("?", 2)[1] ?? "");
    const askId = query.get("id")?.toLowerCase() ?? "";
    const run = UUID.test(askId) ? runs.get(askId) : undefined;
    if (!run) {
      sendError(
        res,
        404,
        "Answer not available",
        "Ask Relay keeps recent answers in memory only, so this one is not available. Ask the question again.",
      );
      return;
    }
    if (run.state === "running") {
      sendPage(res, 200, renderAskPending(run.summary, askId));
      return;
    }
    const next = {
      askId: generateAskId(),
      prospects: await dependencies.listProspects(),
      selected: run.summary.prospect.id,
    };
    sendPage(
      res,
      200,
      run.state === "done"
        ? renderAskAnswer(run.summary, run.result, next)
        : renderAskFailed(run.summary, next),
    );
  }

  const routes = new Map<string, Route>([
    [
      "/",
      {
        method: "GET",
        handle: async (_req, res) =>
          sendPage(
            res,
            200,
            renderAskForm({
              askId: generateAskId(),
              prospects: await dependencies.listProspects(),
            }),
          ),
      },
    ],
    [
      "/healthz",
      {
        method: "GET",
        handle: (_req, res) => {
          res.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
          });
          res.end("ok\n");
        },
      },
    ],
    [ASK_PATH, { method: "POST", handle: ask }],
    [ANSWER_PATH, { method: "GET", handle: answer }],
  ]);

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const host = req.headers.host?.toLowerCase();
    if (!host || !allowedHosts(server).has(host)) {
      sendError(
        res,
        403,
        "Request rejected",
        "Ask Relay accepts requests only at its loopback address.",
      );
      return;
    }
    // Exact origin-form paths only; absolute-form targets are not routed.
    const route = routes.get((req.url ?? "").split("?", 1)[0] ?? "");
    if (!route) {
      sendError(res, 404, "Page not found", "This page does not exist.");
      return;
    }
    if (req.method !== route.method) {
      sendError(
        res,
        405,
        "Method not allowed",
        "This page does not accept that request method. Nothing was asked.",
        { allow: route.method },
      );
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
      sendError(
        res,
        500,
        "Something went wrong",
        "Ask Relay could not complete this request.",
      );
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

export function startAskRelayServer(
  options: AskServerDependencies & { port: number },
): Promise<Server> {
  const { port, ...dependencies } = options;
  const server = createAskRelayServer(dependencies);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: ASK_UI_HOST, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
