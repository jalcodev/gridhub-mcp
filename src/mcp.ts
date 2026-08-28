import { Hono } from "hono";
import { Env } from "../lib/store";
import { ZONES } from "../lib/zones";

// MCP (Model Context Protocol) server for GridHub, mounted at /mcp.
//
// Design:
//  - Stateless Streamable HTTP. One JSON-RPC message per POST, one JSON
//    object back. No sessions, no SSE, no Durable Objects — each call is an
//    ordinary Worker request, so cost scales 1:1 with tool calls.
//  - Speaks the 2026-07-28 protocol (no handshake; Mcp-Method / Mcp-Name
//    headers mirrored from the body) AND the 2025-xx protocols (initialize
//    handshake, optional Mcp-Session-Id which we ignore and never mint).
//  - Tool calls are dispatched THROUGH the main Hono app as internal
//    requests to /v1/*. The caller's Authorization / X-PAYMENT headers are
//    forwarded verbatim, so key auth, quotas, sample mode, 402 payment
//    requirements and x402 settlement all behave exactly as they do over
//    REST. Nothing here touches auth or payment code, and an in-process
//    app.fetch is not a billable subrequest.
//  - No credentials → the tool runs in ?sample=true mode and the result
//    tells the agent how to get a free key. Nothing ever runs on the partner
//    key, so a runaway client is capped by the same limits as anyone else.

const SERVER_NAME = "gridhub";
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const DEFAULT_LEGACY_VERSION = "2025-06-18";

const META_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

// Hard ceiling on rows a tool call will pull into an LLM context. The REST
// API allows 5000; nobody wants 5000 rows of JSON in a chat transcript.
const MCP_HISTORY_MAX = 1000;
const MCP_HISTORY_DEFAULT = 200;

const ZONE_IDS = ZONES.map((z) => z.id);
const METRICS = ["price", "demand", "generation", "carbon-intensity", "interchange", "capacity"] as const;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const zoneProp = {
  type: "string",
  enum: ZONE_IDS,
  description:
    "Zone id. US ISOs: US-CAISO, US-ERCOT, US-PJM, US-MISO, US-NYISO, US-ISONE, US-SPP. " +
    "Europe: DE-LU, FR, ES, IT-NO, NL, BE, PL, SE-3, NO-2, DK-1, AT, CH. " +
    "Great Britain: GB. Australia (NEM): AU-NSW, AU-QLD, AU-VIC, AU-SA, AU-TAS. " +
    "Call list_zones for names, sources, currencies and licences.",
};

const apiKeyProp = {
  type: "string",
  description:
    "Optional GridHub API key (ghk_...). Prefer sending it as an 'Authorization: Bearer <key>' HTTP header " +
    "on the MCP connection; use this argument only if your client cannot set headers. " +
    "Without a key the tool runs in free sample mode (truncated output).",
};

const AUTH_NOTE =
  "Authentication: send 'Authorization: Bearer <ghk_key>' on the MCP connection (free key, 500 requests/day, " +
  "instant email signup at https://grid-hub.app/developers), or pay per call with x402 (USDC on Base) via the " +
  "X-PAYMENT header. With no credentials, data tools run in free sample mode: real, current data but truncated " +
  "(history capped at 50 rows; brief returns one context block). Sample results are clearly marked.";

type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  /** Whether the underlying route sits behind the auth gate (key / x402 / sample). */
  gated: boolean;
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const TOOLS: ToolDef[] = [
  {
    name: "list_zones",
    title: "List zones",
    description:
      "List the 25 electricity grid zones GridHub covers, with id, name, data source (EIA, ENTSO-E, NESO, AEMO), " +
      "timezone, currency, licence and required attribution. Free, no credentials needed. Call this first if you " +
      "are unsure which zone id to use.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnly,
    gated: false,
  },
  {
    name: "get_status",
    title: "Data freshness",
    description:
      "Ingestion health per source and zone: last successful fetch timestamp and last error, if any. Free. Use it " +
      "to explain stale or missing values before drawing conclusions from them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnly,
    gated: false,
  },
  {
    name: "get_latest",
    title: "Latest values for a zone",
    description:
      "The most recent value of every metric one zone publishes (price, demand, carbon intensity, generation by " +
      "fuel, interchange), each with unit and timestamp. This is the right tool for 'what is the price/demand/" +
      "carbon intensity in X right now'. Note: some European sources publish day-ahead prices, so the price " +
      "timestamp can be up to ~36h in the future; use get_zone_brief for a strictly at-or-before-now value " +
      "with historical context. " + AUTH_NOTE,
    inputSchema: {
      type: "object",
      properties: { zone: zoneProp, api_key: apiKeyProp },
      required: ["zone"],
      additionalProperties: false,
    },
    annotations: readOnly,
    gated: true,
  },
  {
    name: "get_zone_brief",
    title: "Zone brief (current state in context)",
    description:
      "Composite, interpretation-ready snapshot of one zone: current price / demand / carbon intensity (strictly " +
      "at-or-before now), each ranked against that zone's own last ~30 days (percentile, vs-median %, min/max, " +
      "sample count and the actual data window), a 24h trend per metric, the full generation mix, and a one-" +
      "sentence plain-English summary. Best tool for questions like 'is electricity cheap/clean in X right now' " +
      "or 'is this a good time to run a flexible workload'. A raw price means little without this context. " +
      AUTH_NOTE,
    inputSchema: {
      type: "object",
      properties: { zone: zoneProp, api_key: apiKeyProp },
      required: ["zone"],
      additionalProperties: false,
    },
    annotations: readOnly,
    gated: true,
  },
  {
    name: "get_history",
    title: "Historical time series",
    description:
      "Time series for one metric in one zone over a start/end window (Unix seconds). Rows are returned oldest-" +
      "first and the 'limit' truncates from the OLDEST end, so a small limit over a wide window returns old data, " +
      "not recent data — for 'the latest N points' set start close to now, or use get_latest / get_zone_brief for " +
      "current values. Default window is the last 24h (last ~400 days for capacity, which is annual). Max window " +
      "31 days per call (400 for capacity); paginate with start/end for more. Metrics: price (wholesale, local " +
      "currency per MWh), demand (MW), generation (per fuel, 'fuel' field set; % or MW depending on zone), " +
      "carbon-intensity (gCO2/kWh), interchange (net imports, MW), capacity (installed MW per fuel; European " +
      "zones only). " + AUTH_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        zone: zoneProp,
        metric: { type: "string", enum: [...METRICS], description: "Which series to fetch." },
        start: { type: "integer", description: "Window start, Unix seconds. Default: end minus 24h." },
        end: { type: "integer", description: "Window end, Unix seconds. Default: now." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MCP_HISTORY_MAX,
          description: `Max rows (default ${MCP_HISTORY_DEFAULT}, max ${MCP_HISTORY_MAX} via MCP; sample mode caps at 50).`,
        },
        api_key: apiKeyProp,
      },
      required: ["zone", "metric"],
      additionalProperties: false,
    },
    annotations: readOnly,
    gated: true,
  },
  {
    name: "get_map_snapshot",
    title: "All zones right now",
    description:
      "Current headline values for all 25 zones in one call — the cheapest way to compare zones (e.g. 'which " +
      "European zone has the lowest carbon intensity right now', 'rank US ISOs by price'). Rebuilt every 5 " +
      "minutes. " + AUTH_NOTE,
    inputSchema: {
      type: "object",
      properties: { api_key: apiKeyProp },
      additionalProperties: false,
    },
    annotations: readOnly,
    gated: true,
  },
];

// Public view of a tool (drop the internal `gated` flag).
const publicTool = ({ gated: _g, ...t }: ToolDef) => t;

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, any> };

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

const E_PARSE = -32700;
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
const E_INTERNAL = -32603;
const E_HEADER_MISMATCH = -32020; // 2026-07-28: mirrored header ≠ body
const E_UNSUPPORTED_VERSION = -32021; // 2026-07-28: UnsupportedProtocolVersionError

/** Decode the `=?base64?...?=` sentinel format used for non-ASCII header values. */
function decodeHeaderValue(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  if (v.startsWith("=?base64?") && v.endsWith("?=")) {
    try {
      return new TextDecoder().decode(
        Uint8Array.from(atob(v.slice(9, -2)), (ch) => ch.charCodeAt(0))
      );
    } catch {
      return v;
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// Internal dispatch through the main app
// ---------------------------------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

const FORWARD_HEADERS = ["authorization", "x-payment", "cf-connecting-ip", "x-forwarded-for", "user-agent", "accept-language"];

async function callApi(
  app: Hono<{ Bindings: Env }>,
  c: any,
  path: string,
  query: Record<string, string | number | undefined>,
  apiKeyArg?: string
): Promise<ToolResult> {
  const origin = new URL(c.req.url).origin;
  const url = new URL(`/v1${path}`, origin);

  const headers = new Headers();
  for (const h of FORWARD_HEADERS) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }
  // Key passed as a tool argument: only used when no header credential exists.
  if (apiKeyArg && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${apiKeyArg}`);
  }
  const hasCreds = headers.has("authorization") || headers.has("x-payment");
  if (!hasCreds) url.searchParams.set("sample", "true");

  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  headers.set("accept", "application/json");

  let res: Response;
  try {
    // In-process dispatch: runs the same middleware chain (CORS, rate limit,
    // requireAuth, x402) as an external request, without a network hop.
    res = await app.fetch(new Request(url.toString(), { method: "GET", headers }), c.env, c.executionCtx);
  } catch (err) {
    return {
      content: [{ type: "text", text: `GridHub internal dispatch failed: ${(err as Error).message}` }],
      isError: true,
    };
  }

  const raw = await res.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON body: keep as text */
  }

  const notes: string[] = [];
  const settlement = res.headers.get("X-PAYMENT-RESPONSE");
  if (settlement) notes.push(`x402 settlement (X-PAYMENT-RESPONSE): ${settlement}`);

  if (res.ok) {
    if (!hasCreds) {
      notes.push(
        "SAMPLE MODE: no credentials were supplied, so this is the free, truncated sample response. " +
          "For full data, send 'Authorization: Bearer <ghk_key>' on the MCP connection — free key at " +
          "https://grid-hub.app/developers — or pay per call with x402."
      );
    }
    return {
      content: [
        ...notes.map((t) => ({ type: "text" as const, text: t })),
        { type: "text", text: typeof body === "string" ? body : JSON.stringify(body) },
      ],
      structuredContent: typeof body === "object" && body !== null ? body : undefined,
    };
  }

  // Non-2xx: surface the API's own error/402/429 body so the agent (or a
  // paying agent runtime) can act on it. isError lets the model reason about
  // it instead of treating it as data.
  const label =
    res.status === 402
      ? "Payment required. The JSON below is the x402 payment requirements for this call; an x402-capable " +
        "client can retry with an X-PAYMENT header. Alternatively get a free API key at https://grid-hub.app/developers."
      : res.status === 429
        ? "Quota exceeded for this API key."
        : res.status === 401
          ? "Credentials were rejected."
          : `GridHub API returned HTTP ${res.status}.`;

  return {
    content: [
      ...notes.map((t) => ({ type: "text" as const, text: t })),
      { type: "text", text: label },
      { type: "text", text: typeof body === "string" ? body : JSON.stringify(body) },
    ],
    structuredContent: typeof body === "object" && body !== null ? { http_status: res.status, ...body as object } : undefined,
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function runTool(
  app: Hono<{ Bindings: Env }>,
  c: any,
  name: string,
  args: Record<string, any>
): Promise<ToolResult | { rpcErrorCode: number; message: string }> {
  const str = (k: string) => (typeof args[k] === "string" ? args[k].trim() : undefined);
  const int = (k: string) => {
    const v = args[k];
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : NaN;
  };

  const requireZone = () => {
    const z = str("zone");
    if (!z) return { rpcErrorCode: E_INVALID_PARAMS, message: "zone is required" };
    if (!ZONE_IDS.some((id) => id.toLowerCase() === z.toLowerCase())) {
      return { rpcErrorCode: E_INVALID_PARAMS, message: `unknown zone '${z}'; call list_zones` };
    }
    return z;
  };

  switch (name) {
    case "list_zones":
      return callApi(app, c, "/zones", {});
    case "get_status":
      return callApi(app, c, "/status", {});
    case "get_latest": {
      const z = requireZone();
      if (typeof z !== "string") return z;
      return callApi(app, c, `/latest/${encodeURIComponent(z)}`, {}, str("api_key"));
    }
    case "get_zone_brief": {
      const z = requireZone();
      if (typeof z !== "string") return z;
      return callApi(app, c, `/brief/${encodeURIComponent(z)}`, {}, str("api_key"));
    }
    case "get_map_snapshot":
      return callApi(app, c, "/map/snapshot", {}, str("api_key"));
    case "get_history": {
      const z = requireZone();
      if (typeof z !== "string") return z;
      const metric = str("metric");
      if (!metric || !(METRICS as readonly string[]).includes(metric)) {
        return { rpcErrorCode: E_INVALID_PARAMS, message: `metric must be one of ${METRICS.join(", ")}` };
      }
      const start = int("start");
      const end = int("end");
      const limitRaw = int("limit");
      if ([start, end, limitRaw].some((v) => Number.isNaN(v))) {
        return { rpcErrorCode: E_INVALID_PARAMS, message: "start, end and limit must be integers" };
      }
      const limit = Math.min(limitRaw ?? MCP_HISTORY_DEFAULT, MCP_HISTORY_MAX);
      return callApi(
        app,
        c,
        `/${metric}/${encodeURIComponent(z)}`,
        { start, end, limit },
        str("api_key")
      );
    }
    default:
      return { rpcErrorCode: E_INVALID_PARAMS, message: `unknown tool '${name}'` };
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function mcpRoutes(app: Hono<{ Bindings: Env }>) {
  const mcp = new Hono<{ Bindings: Env }>();

  const serverInfo = (c: any) => ({
    name: SERVER_NAME,
    title: "GridHub Electricity Market Data",
    version: c.env.API_VERSION ?? "1",
  });

  const instructions =
    "GridHub provides live and historical electricity market data — wholesale prices, demand, generation mix, " +
    "carbon intensity, interconnector flows and installed capacity — for 25 grid zones across the US, Europe, " +
    "Great Britain and Australia, in one normalised JSON schema. Every response carries its source attribution " +
    "and licence; repeat them when presenting data. Start with get_zone_brief for 'right now' questions and " +
    "get_history for time series. " + AUTH_NOTE;

  // Legacy (2025-xx) clients open a GET stream for server-initiated messages;
  // 2026-07-28 removed it. 405 is the specified answer either way. The body
  // doubles as human/crawler-readable documentation of the endpoint.
  mcp.get("/mcp", (c) => {
    c.header("Allow", "POST, OPTIONS");
    return c.json(
      {
        name: SERVER_NAME,
        transport: "streamable-http",
        endpoint: "https://api.grid-hub.app/mcp",
        protocolVersions: SUPPORTED_VERSIONS,
        usage: "POST a JSON-RPC 2.0 message. Set 'Authorization: Bearer <ghk_key>' for full data; omit for free sample mode.",
        tools: TOOLS.map((t) => t.name),
        free_key: "https://grid-hub.app/developers",
        docs: "https://grid-hub.app/developers",
      },
      405
    );
  });
  mcp.delete("/mcp", (c) => {
    c.header("Allow", "POST, OPTIONS");
    return c.json({ error: "no sessions; nothing to delete" }, 405);
  });

  mcp.post("/mcp", async (c) => {
    // ---- Parse body (single message; legacy batches tolerated) ----
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json(rpcError(null, E_PARSE, "Parse error: body must be JSON"), 400);
    }
    const isBatch = Array.isArray(parsed);
    const messages = (isBatch ? parsed : [parsed]) as JsonRpcRequest[];
    if (messages.length === 0) {
      return c.json(rpcError(null, E_INVALID_REQUEST, "Invalid Request: empty batch"), 400);
    }

    // ---- Protocol version ----
    // Header absent → pre-2025-06-18 client → treat as 2025-03-26 (spec allows this).
    const headerVersion = c.req.header("MCP-Protocol-Version") ?? "2025-03-26";
    if (!SUPPORTED_VERSIONS.includes(headerVersion)) {
      return c.json(
        rpcError(messages[0]?.id ?? null, E_UNSUPPORTED_VERSION, `Unsupported protocol version '${headerVersion}'`, {
          supported: SUPPORTED_VERSIONS,
          requested: headerVersion,
        }),
        400
      );
    }
    const modern = headerVersion === MODERN_VERSION;

    // ---- 2026-07-28 header/body validation ----
    // Only enforced when the client declares the modern version; older
    // clients never send these headers.
    if (modern && !isBatch) {
      const m = messages[0];
      const metaVersion = m.params?._meta?.[META_VERSION_KEY];
      if (metaVersion !== undefined && metaVersion !== headerVersion) {
        return c.json(
          rpcError(m.id ?? null, E_HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match _meta '${metaVersion}'`),
          400
        );
      }
      const hMethod = c.req.header("Mcp-Method");
      if (m.method && (hMethod === undefined || hMethod !== m.method)) {
        return c.json(
          rpcError(m.id ?? null, E_HEADER_MISMATCH, `Header mismatch: Mcp-Method '${hMethod ?? ""}' does not match body method '${m.method}'`),
          400
        );
      }
      if (m.method === "tools/call") {
        const hName = decodeHeaderValue(c.req.header("Mcp-Name"));
        const bName = m.params?.name;
        if (hName === undefined || hName !== bName) {
          return c.json(
            rpcError(m.id ?? null, E_HEADER_MISMATCH, `Header mismatch: Mcp-Name '${hName ?? ""}' does not match body name '${bName ?? ""}'`),
            400
          );
        }
      }
    }

    // ---- Handle each message ----
    const responses: unknown[] = [];
    let methodNotFound = false;

    for (const m of messages) {
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
        responses.push(rpcError((m as any)?.id ?? null, E_INVALID_REQUEST, "Invalid Request"));
        continue;
      }
      const isNotification = m.id === undefined;
      const id = m.id ?? null;

      try {
        switch (m.method) {
          case "initialize": {
            // Legacy handshake. Modern clients don't need it but may send it.
            const requested = m.params?.protocolVersion;
            const negotiated =
              typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested) ? requested : DEFAULT_LEGACY_VERSION;
            responses.push(
              rpcResult(id, {
                protocolVersion: negotiated,
                capabilities: { tools: { listChanged: false } },
                serverInfo: serverInfo(c),
                instructions,
              })
            );
            break;
          }
          case "notifications/initialized":
          case "notifications/cancelled":
          case "notifications/roots/list_changed":
            // Nothing to do for a stateless server.
            break;
          case "ping":
            if (!isNotification) responses.push(rpcResult(id, {}));
            break;
          case "tools/list": {
            const result: Record<string, unknown> = { tools: TOOLS.map(publicTool) };
            if (modern) {
              // SEP-2549: let clients cache the (static) tool list.
              result.ttlMs = 3_600_000;
              result.cacheScope = "public";
            }
            if (!isNotification) responses.push(rpcResult(id, result));
            break;
          }
          case "tools/call": {
            const name = m.params?.name;
            const args = (m.params?.arguments ?? {}) as Record<string, any>;
            if (typeof name !== "string" || !TOOLS.some((t) => t.name === name)) {
              responses.push(rpcError(id, E_INVALID_PARAMS, `Unknown tool '${name}'`));
              break;
            }
            const out = await runTool(app, c, name, args);
            if ("rpcErrorCode" in out) {
              responses.push(rpcError(id, out.rpcErrorCode, out.message));
            } else if (!isNotification) {
              responses.push(rpcResult(id, out));
            }
            break;
          }
          // Capabilities we don't advertise; answer cleanly rather than 404 so
          // clients that probe don't treat the server as broken.
          case "resources/list":
            if (!isNotification) responses.push(rpcResult(id, { resources: [] }));
            break;
          case "resources/templates/list":
            if (!isNotification) responses.push(rpcResult(id, { resourceTemplates: [] }));
            break;
          case "prompts/list":
            if (!isNotification) responses.push(rpcResult(id, { prompts: [] }));
            break;
          default:
            methodNotFound = true;
            responses.push(rpcError(id, E_METHOD_NOT_FOUND, `Method not found: ${m.method}`));
        }
      } catch (err) {
        responses.push(rpcError(id, E_INTERNAL, `Internal error: ${(err as Error).message}`));
      }
    }

    // Never cache: responses depend on Authorization and carry paid data.
    c.header("Cache-Control", "private, no-store");

    if (responses.length === 0) return c.body(null, 202); // notification(s) only
    if (isBatch) return c.json(responses, 200);
    // 2026-07-28: unknown method → 404 with the -32601 body.
    if (methodNotFound && modern) return c.json(responses[0], 404);
    return c.json(responses[0], 200);
  });

  return mcp;
}
