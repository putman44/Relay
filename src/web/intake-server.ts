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
  renderResearchStatus,
  RESEARCH_CONFIRM_VALUE,
  RESEARCH_PROSPECT_FIELD,
  RESEARCH_START_PATH,
  RESEARCH_STATUS_PATH,
  researchStatusPath,
  type IntakeFormValues,
  type LocalResearchRun,
  type ResearchOffer,
  type ResearchSummary,
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
  | { event: "research_requested"; prospectId: string }
  | { event: "research_finished"; prospectId: string; status: string }
  | { event: "research_stopped"; prospectId: string; error: string }
  | { event: "assessment_requested" | "assessment_finished"; prospectId: string }
  | { event: "assessment_stopped"; prospectId: string; error: string }
  | { event: "request_failed"; error: string };

export type IntakeResearchDependencies = {
  // Settles when the whole research workflow ends; the server never awaits it inside a request.
  start: (prospectId: string) => Promise<ResearchSummary>;
  getRequest: (prospectId: string) => Promise<ResearchSummary | null>;
};

type DashboardProspectView = {
  id: string;
  companyName: string;
  website: string | null;
  industry: string | null;
  contactName: string | null;
  contactEmail: string | null;
  stage: string;
  embeddedChunks: number;
  websiteIndexStatus?: string | null;
};

export type IntakeServerDependencies = {
  createProspect: (input: ProspectIntakeInput) => Promise<ProspectIntakeResult>;
  // Without this the UI offers no research action and serves no research routes.
  research?: IntakeResearchDependencies;
  dashboard?: {
    listProspects: () => Promise<DashboardProspectView[]>;
    // The assessment value is opaque here: this module must not import assessment code.
    // A method signature, so a renderer that expects the concrete history type is assignable.
    render(prospects: readonly DashboardProspectView[], selected: DashboardProspectView | undefined, askId: string, saved: "created" | "existing" | null, inline?: { content: string; refresh: boolean } | null, assessment?: unknown): string;
    csp: string;
    askHandler: (getServer: () => Server) => ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & {
      inlineAnswer: (prospectId: string, askId: string) => { content: string; refresh: boolean } | null;
    };
    researchIndex?: (prospectId: string) => Promise<void>;
    // Without these the dashboard shows no assessment and serves no assessment route.
    loadAssessment?: (prospectId: string) => Promise<unknown>;
    generateAssessment?: (prospectId: string) => Promise<unknown>;
  };
  generateRequestId?: () => string;
  log?: (event: IntakeServerEvent) => void;
};

type Route = {
  method: "GET" | "POST";
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    host: string,
  ) => Promise<void> | void;
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
const CONFIRMED_FORM_FIELDS = new Set<string>([
  ...INTAKE_FIELDS,
  INTAKE_CONFIRM_FIELD,
]);
const RESEARCH_FORM_FIELDS = new Set<string>([
  RESEARCH_PROSPECT_FIELD,
  INTAKE_CONFIRM_FIELD,
]);
// Literals, not imports from assessment-pages: the intake-only process must not
// load assessment code. A web test pins them to the exported constants.
const ASSESSMENT_PATH = "/assessment";
const ASSESSMENT_CONFIRM_VALUE = "generate-assessment";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  const type = req.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
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
    req.on("close", () =>
      settle(() => reject(new Error("Request body was not completed."))),
    );
  });
}

// Strict form contract: unknown, duplicated, or non-UTF-8 fields are malformed.
function parseForm(
  body: Buffer,
  allowed: ReadonlySet<string>,
): Map<string, string> | null {
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

async function readFields(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  allowed: ReadonlySet<string>,
): Promise<Map<string, string> | null> {
  if (!isSameOriginPost(req, host)) {
    sendError(
      res,
      403,
      "Request rejected",
      "Relay accepts this form only from its own pages at a loopback address. Nothing was created.",
    );
    return null;
  }
  if (!isFormSubmission(req)) {
    sendError(
      res,
      415,
      "Unsupported submission",
      "Relay accepts only standard HTML form submissions here. Nothing was created.",
    );
    return null;
  }
  const body = await readBody(req);
  if (body === "too_large") {
    sendError(
      res,
      413,
      "Submission too large",
      "The form submission exceeded the size limit. Nothing was created.",
      { connection: "close" },
    );
    return null;
  }
  const fields = parseForm(body, allowed);
  if (!fields) {
    sendError(
      res,
      400,
      "Submission not accepted",
      "Relay could not read this form submission. Nothing was created.",
    );
    return null;
  }
  return fields;
}

async function readForm(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  allowed: ReadonlySet<string>,
): Promise<SubmittedForm | null> {
  const fields = await readFields(req, res, host, allowed);
  if (!fields) return null;
  const values: IntakeFormValues = {};
  for (const name of INTAKE_FIELDS) {
    const value = fields.get(name);
    if (value !== undefined) values[name] = value;
  }
  return {
    values,
    confirmed: fields.get(INTAKE_CONFIRM_FIELD) === INTAKE_CONFIRM_VALUE,
  };
}

// Prospect intake performs all validation; a rejection re-renders the form with the same request ID.
function parseOrRenderInvalid(
  values: IntakeFormValues,
  res: ServerResponse,
): ProspectIntakeInput | null {
  try {
    return parseProspectIntakePayload(values);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Prospect intake input is invalid.";
    sendPage(
      res,
      422,
      renderIntakeForm({
        requestId: values.requestId ?? "",
        values,
        error: message,
      }),
    );
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

  async function createProspect(
    input: ProspectIntakeInput,
    res: ServerResponse,
  ): Promise<void> {
    let result: ProspectIntakeResult;
    try {
      result = await dependencies.createProspect(input);
    } catch (error) {
      if (error instanceof ProspectIntakeConflictError) {
        log({ event: "intake_conflict", requestId: input.requestId });
        sendPage(
          res,
          409,
          renderIntakeConflict(input.requestId, error.message),
        );
        return;
      }
      // Anything else may have committed: keep the request ID and direct an unchanged retry.
      log({
        event: "intake_outcome_unknown",
        requestId: input.requestId,
        error: errorKind(error),
      });
      sendPage(res, 500, renderIntakeOutcomeUnknown(input.requestId));
      return;
    }
    log({
      event: result.created ? "intake_created" : "intake_existing",
      requestId: result.requestId,
      prospectId: result.prospectId,
    });
    if (dependencies.dashboard) {
      res.writeHead(303, {
        ...PAGE_HEADERS,
        "content-length": 0,
        location: `/prospect?id=${encodeURIComponent(result.prospectId)}&saved=${result.created ? "created" : "existing"}`,
      });
      res.end();
      return;
    }
    // Only a prospect still awaiting research is offered the action; the start recheck is durable.
    const offer: ResearchOffer = !dependencies.research
      ? "none"
      : result.stage !== "researching"
        ? "status"
        : input.website === null
          ? "no-website"
          : "start";
    sendPage(
      res,
      result.created ? 201 : 200,
      renderIntakeSuccess(result, input.requestId, offer),
    );
  }

  function researchRoutes(
    research: IntakeResearchDependencies,
  ): [string, Route][] {
    // Research this process is running, or whose last start here stopped. Postgres stays authoritative:
    // the workflow's row lock and unique request reject any duplicate this map cannot see.
    const runs = new Map<string, Exclude<LocalResearchRun, "idle">>();

    // Not awaited: the response returns at once and the status page reads the durable request.
    function launch(prospectId: string): void {
      log({ event: "research_requested", prospectId });
      Promise.resolve()
        .then(() => research.start(prospectId))
        .then(
          (request) => {
            runs.delete(prospectId);
            log({
              event: "research_finished",
              prospectId,
              status: request.status,
            });
          },
          (error: unknown) => {
            runs.set(prospectId, "stopped");
            log({
              event: "research_stopped",
              prospectId,
              error: errorKind(error),
            });
          },
        );
    }

    async function startResearch(
      prospectId: string,
      res: ServerResponse,
    ): Promise<void> {
      if (runs.get(prospectId) !== "running") {
        // Claim before the first await so a repeated submission cannot launch twice.
        runs.set(prospectId, "running");
        let existing: ResearchSummary | null;
        try {
          existing = await research.getRequest(prospectId);
        } catch (error) {
          runs.delete(prospectId);
          log({ event: "request_failed", error: errorKind(error) });
          sendError(
            res,
            500,
            "Research not started",
            "Relay could not check this prospect's research state, so research was not started.",
          );
          return;
        }
        if (existing) runs.delete(prospectId);
        else launch(prospectId);
      }
      res.writeHead(303, {
        ...PAGE_HEADERS,
        "content-length": 0,
        location: researchStatusPath(prospectId),
      });
      res.end();
    }

    return [
      [
        RESEARCH_START_PATH,
        {
          method: "POST",
          handle: async (req, res, host) => {
            const fields = await readFields(
              req,
              res,
              host,
              RESEARCH_FORM_FIELDS,
            );
            if (!fields) return;
            if (fields.get(INTAKE_CONFIRM_FIELD) !== RESEARCH_CONFIRM_VALUE) {
              sendError(
                res,
                400,
                "Confirmation required",
                "Research starts only from the Start Research button. Research was not started.",
              );
              return;
            }
            const prospectId =
              fields.get(RESEARCH_PROSPECT_FIELD)?.toLowerCase() ?? "";
            if (!UUID.test(prospectId)) {
              sendError(
                res,
                400,
                "Research not started",
                "This submission does not identify a prospect. Research was not started.",
              );
              return;
            }
            await startResearch(prospectId, res);
          },
        },
      ],
      [
        RESEARCH_STATUS_PATH,
        {
          method: "GET",
          handle: async (req, res) => {
            const query = new URLSearchParams(
              (req.url ?? "").split("?", 2)[1] ?? "",
            );
            const prospectId =
              query.get(RESEARCH_PROSPECT_FIELD)?.toLowerCase() ?? "";
            if (!UUID.test(prospectId)) {
              sendError(
                res,
                400,
                "Research status unavailable",
                "This link does not identify a prospect.",
              );
              return;
            }
            // Read the local run first: the durable read that follows can only be newer.
            const local = runs.get(prospectId) ?? "idle";
            const request = await research.getRequest(prospectId);
            sendPage(
              res,
              200,
              renderResearchStatus({ prospectId, request, local }),
            );
          },
        },
      ],
    ];
  }

  const askHandler = dependencies.dashboard
    ? dependencies.dashboard.askHandler(() => server)
    : undefined;
  const assessmentRuns = new Set<string>();
  const dashboardRoutes: [string, Route][] = dependencies.dashboard ? [
    ["/research-index", { method: "POST", handle: async (req, res, host) => {
      if (!dependencies.dashboard?.researchIndex) return sendError(res, 404, "Unavailable", "Website indexing is unavailable.");
      const fields = await readFields(req, res, host, RESEARCH_FORM_FIELDS);
      if (!fields) return;
      const id = fields.get(RESEARCH_PROSPECT_FIELD)?.toLowerCase() ?? "";
      if (fields.get(INTAKE_CONFIRM_FIELD) !== "research-index" || !UUID.test(id))
        return sendError(res, 400, "Confirmation required", "Website indexing requires an explicit confirmation.");
      const prospect = (await dependencies.dashboard.listProspects()).find((p) => p.id === id);
      if (!prospect || (prospect.embeddedChunks && (!('websiteIndexStatus' in prospect) || prospect.websiteIndexStatus === "ready")))
        return sendError(res, 409, "Research unavailable", "This prospect is already indexed or unavailable.");
      // The durable reservation in researchIndex rejects duplicate starts.
      void dependencies.dashboard.researchIndex(id).catch((error: unknown) =>
        log({ event: "research_stopped", prospectId: id, error: errorKind(error) }));
      res.writeHead(303, { ...PAGE_HEADERS, "content-length": 0, location: `/prospect?id=${encodeURIComponent(id)}` });
      res.end();
    }}],
    [ASSESSMENT_PATH, { method: "POST", handle: async (req, res, host) => {
      const dashboard = dependencies.dashboard!;
      if (!dashboard.generateAssessment) return sendError(res, 404, "Unavailable", "Assessment generation is unavailable.");
      const fields = await readFields(req, res, host, RESEARCH_FORM_FIELDS);
      if (!fields) return;
      const id = fields.get(RESEARCH_PROSPECT_FIELD)?.toLowerCase() ?? "";
      if (fields.get(INTAKE_CONFIRM_FIELD) !== ASSESSMENT_CONFIRM_VALUE || !UUID.test(id))
        return sendError(res, 400, "Confirmation required", "An assessment is generated only from the Generate Assessment button. Nothing was generated.");
      const prospect = (await dashboard.listProspects()).find((p) => p.id === id);
      if (!prospect || !prospect.embeddedChunks || (prospect.websiteIndexStatus && prospect.websiteIndexStatus !== "ready"))
        return sendError(res, 409, "Assessment unavailable", "This prospect has no indexed research to assess. Nothing was generated.");
      // The durable reservation rejects a duplicate paid run; this only avoids a second launch from this process.
      if (!assessmentRuns.has(id)) {
        assessmentRuns.add(id);
        log({ event: "assessment_requested", prospectId: id });
        void Promise.resolve()
          .then(() => dashboard.generateAssessment!(id))
          .then(
            () => log({ event: "assessment_finished", prospectId: id }),
            (error: unknown) => log({ event: "assessment_stopped", prospectId: id, error: errorKind(error) }),
          )
          .finally(() => assessmentRuns.delete(id));
      }
      res.writeHead(303, { ...PAGE_HEADERS, "content-length": 0, location: `/prospect?id=${encodeURIComponent(id)}` });
      res.end();
    }}],
    ["/new", { method: "GET", handle: (_req, res) => sendPage(res, 200, renderIntakeForm({ requestId: generateRequestId() })) }],
    ["/prospect", { method: "GET", handle: async (req, res) => {
      const query = new URLSearchParams((req.url ?? "").split("?", 2)[1] ?? "");
      const id = query.get("id")?.toLowerCase() ?? "";
      if (!UUID.test(id)) return sendError(res, 400, "Prospect unavailable", "This link does not identify a prospect.");
      const prospects = await dependencies.dashboard!.listProspects();
      const selected = prospects.find((p) => p.id === id);
      if (!selected) return sendError(res, 404, "Prospect unavailable", "This prospect was not found.");
      const saved = query.get("saved");
      const answerId = query.get("answer")?.toLowerCase();
      const inline = answerId === undefined ? null : askHandler?.inlineAnswer(id, answerId);
      if (answerId !== undefined && !inline) return sendError(res, 404, "Answer unavailable", "This answer is not available for this prospect.");
      const assessment = dependencies.dashboard!.loadAssessment ? await dependencies.dashboard!.loadAssessment(id) : null;
      sendPage(res, 200, dependencies.dashboard!.render(prospects, selected, randomUUID(), saved === "created" || saved === "existing" ? saved : null, inline, assessment), { "content-security-policy": dependencies.dashboard!.csp });
    }}],
  ] : [];
  const routes = new Map<string, Route>([
    [
      "/",
      {
        method: "GET",
        handle: async (_req, res) =>
          sendPage(
            res,
            200,
            dependencies.dashboard
              ? dependencies.dashboard.render(await dependencies.dashboard.listProspects(), undefined, randomUUID(), null)
              : renderIntakeForm({ requestId: generateRequestId() }),
            dependencies.dashboard ? { "content-security-policy": dependencies.dashboard.csp } : {},
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
    [
      "/review",
      {
        method: "POST",
        handle: async (req, res, host) => {
          const form = await readForm(req, res, host, PROSPECT_FORM_FIELDS);
          const input = form && parseOrRenderInvalid(form.values, res);
          if (input) sendPage(res, 200, renderIntakeReview(input));
        },
      },
    ],
    [
      "/edit",
      {
        method: "POST",
        handle: async (req, res, host) => {
          const form = await readForm(req, res, host, PROSPECT_FORM_FIELDS);
          if (!form) return;
          sendPage(
            res,
            200,
            renderIntakeForm({
              requestId: form.values.requestId ?? "",
              values: form.values,
            }),
          );
        },
      },
    ],
    [
      "/prospects",
      {
        method: "POST",
        handle: async (req, res, host) => {
          const form = await readForm(req, res, host, CONFIRMED_FORM_FIELDS);
          if (!form) return;
          if (!form.confirmed) {
            sendError(
              res,
              400,
              "Confirmation required",
              "Prospects are created only from the review page after you confirm. Nothing was created.",
            );
            return;
          }
          const input = parseOrRenderInvalid(form.values, res);
          if (input) await createProspect(input, res);
        },
      },
    ],
    ...(dependencies.research ? researchRoutes(dependencies.research) : []),
    ...dashboardRoutes,
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
        "Relay accepts requests only at its loopback address. Nothing was created.",
      );
      return;
    }
    const path = (req.url ?? "").split("?", 1)[0] ?? "";
    if (askHandler && (path === "/ask" || path === "/answer")) {
      await askHandler(req, res);
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
        "This page does not accept that request method. Nothing was created.",
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
        "Relay could not complete this request.",
      );
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
