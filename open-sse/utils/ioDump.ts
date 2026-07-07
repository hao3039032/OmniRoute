import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type IoDumpSession = {
  requestId: string;
  startedAt: string;
  meta: Record<string, unknown>;
  input: {
    clientHeaders?: Record<string, string>;
    clientBody?: unknown;
    clientBodyRaw?: string;
    providerUrl?: string;
    providerHeaders?: Record<string, string>;
    providerBody?: unknown;
    providerBodyString?: string;
  };
  output: {
    providerWire: string;
    clientWire: string;
  };
  finalizedAt?: string;
  finalizeMeta?: Record<string, unknown>;
};

const sessions = new Map<string, IoDumpSession>();
const finalized = new Set<string>();

const SENSITIVE_HEADER_KEYS = ["authorization", "x-api-key", "cookie", "token"];

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("x-ratelimit-")) {
      masked[key] = value;
      continue;
    }
    if (SENSITIVE_HEADER_KEYS.some((candidate) => lower.includes(candidate))) {
      masked[key] = value.length > 20 ? `${value.slice(0, 10)}...${value.slice(-5)}` : "[REDACTED]";
      continue;
    }
    masked[key] = value;
  }
  return masked;
}

export function isIoDumpEnabled(): boolean {
  const flag = process.env.OMNIROUTE_IO_DUMP;
  return flag === "1" || flag === "true";
}

/** When set, only dump requests whose User-Agent contains this substring. */
export function shouldDumpRequest(headers: Headers | Record<string, string> | null | undefined): boolean {
  if (!isIoDumpEnabled()) return false;
  if (process.env.OMNIROUTE_IO_DUMP_ALL === "1" || process.env.OMNIROUTE_IO_DUMP_ALL === "true") {
    return true;
  }
  const filter = process.env.OMNIROUTE_IO_DUMP_UA ?? "Cursor";
  if (!filter) return true;
  const ua =
    headers instanceof Headers
      ? headers.get("user-agent") ?? ""
      : String((headers as Record<string, string> | undefined)?.["user-agent"] ?? "");
  return ua.includes(filter);
}

function dumpDir(): string {
  const base = process.env.DATA_DIR || path.join(os.homedir(), ".omniroute");
  return path.join(base, "io-dumps");
}

function getOrCreateSession(requestId: string): IoDumpSession {
  let session = sessions.get(requestId);
  if (!session) {
    session = {
      requestId,
      startedAt: new Date().toISOString(),
      meta: {},
      input: {},
      output: { providerWire: "", clientWire: "" },
    };
    sessions.set(requestId, session);
  }
  return session;
}

function summarizeParsedBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const messages = record.messages;
  const tools = record.tools;
  return {
    model: record.model ?? null,
    stream: record.stream ?? null,
    messageCount: Array.isArray(messages) ? messages.length : null,
    toolCount: Array.isArray(tools) ? tools.length : null,
    hasToolMessages: Array.isArray(messages)
      ? messages.some(
          (m) =>
            m &&
            typeof m === "object" &&
            ((m as Record<string, unknown>).role === "tool" ||
              Array.isArray((m as Record<string, unknown>).tool_calls))
        )
      : false,
  };
}

export async function captureRouteRawBody(request: Request): Promise<string> {
  const buf = await request.clone().arrayBuffer();
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export function startIoDump(
  requestId: string,
  data: {
    path?: string;
    headers?: Headers | Record<string, string>;
    body?: unknown;
    bodyRaw?: string;
    captureSource?: string;
  }
): void {
  if (!isIoDumpEnabled()) return;
  const session = getOrCreateSession(requestId);
  if (data.path) session.meta.path = data.path;
  if (data.captureSource) session.meta.captureSource = data.captureSource;
  if (data.headers) {
    const raw =
      data.headers instanceof Headers
        ? Object.fromEntries(data.headers.entries())
        : { ...data.headers };
    session.input.clientHeaders = maskHeaders(raw);
    session.meta.userAgent = raw["user-agent"] ?? raw["User-Agent"] ?? null;
  }
  if (data.bodyRaw != null) session.input.clientBodyRaw = data.bodyRaw;
  if (data.body !== undefined) {
    session.input.clientBody = data.body;
    session.meta.clientBodySummary = summarizeParsedBody(data.body);
  }
  if (data.bodyRaw != null && data.body === undefined) {
    try {
      session.meta.clientBodySummary = summarizeParsedBody(JSON.parse(data.bodyRaw));
    } catch {
      session.meta.clientBodySummary = { parseError: true, rawBytes: data.bodyRaw.length };
    }
  }
}

export function recordIoDumpProviderRequest(
  requestId: string,
  data: { url: string; headers: Record<string, string>; body: unknown; bodyString?: string }
): void {
  if (!isIoDumpEnabled()) return;
  const session = getOrCreateSession(requestId);
  session.input.providerUrl = data.url;
  session.input.providerHeaders = maskHeaders(data.headers);
  session.input.providerBody = data.body;
  if (data.bodyString) session.input.providerBodyString = data.bodyString;
}

export function appendIoDumpProviderWire(requestId: string, chunk: string): void {
  if (!isIoDumpEnabled() || !chunk) return;
  getOrCreateSession(requestId).output.providerWire += chunk;
}

export function appendIoDumpClientWire(requestId: string, chunk: string): void {
  if (!isIoDumpEnabled() || !chunk) return;
  getOrCreateSession(requestId).output.clientWire += chunk;
}

function parseSseSummary(wire: string): Record<string, unknown> {
  const finishReasons: string[] = [];
  let sawToolCallDelta = false;
  let frameCount = 0;
  const frames: unknown[] = [];
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
    if (!raw || raw === "[DONE]") continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      frameCount += 1;
      if (frames.length < 200) frames.push(parsed);
      const choices = parsed.choices;
      if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
        const choice = choices[0] as Record<string, unknown>;
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (delta?.tool_calls && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          sawToolCallDelta = true;
        }
        if (choice.finish_reason != null && String(choice.finish_reason).length > 0) {
          finishReasons.push(String(choice.finish_reason));
        }
      }
    } catch {
      // ignore malformed frames in summary
    }
  }
  const lastFinishReason = finishReasons.length > 0 ? finishReasons[finishReasons.length - 1] : null;
  return {
    frameCount,
    sawToolCallDelta,
    finishReasons: finishReasons.slice(-10),
    lastFinishReason,
    needsSyntheticFinish:
      sawToolCallDelta && lastFinishReason !== "tool_calls" && lastFinishReason !== "function_call",
    sampleFrames: frames.slice(0, 20),
  };
}

function writeSessionFile(session: IoDumpSession): string | null {
  try {
    const dir = dumpDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = session.finalizedAt?.replace(/[:.]/g, "-") ?? new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(dir, `${stamp}_${session.requestId.slice(0, 8)}.json`);
    const payload = {
      ...session,
      analysis: {
        clientWire: parseSseSummary(session.output.clientWire),
        providerWire: parseSseSummary(session.output.providerWire),
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return filePath;
  } catch (error) {
    console.warn("[IO-DUMP] failed to write dump file:", error);
    return null;
  }
}

export function dumpIoParseFailure(
  requestId: string,
  rawText: string,
  headers?: Record<string, string>
): void {
  if (!isIoDumpEnabled()) return;
  startIoDump(requestId, { headers, bodyRaw: rawText, captureSource: "chat-handler" });
  finalizeIoDump(requestId, { stage: "invalid_json_body", rawBytes: rawText.length });
}

/** Immediate dump for nginx mirror / inbound-capture — every byte hits disk even if main route never runs. */
export function dumpInboundMirror(data: {
  requestId: string;
  headers: Record<string, string>;
  rawBody: string;
  source?: string;
}): string | null {
  if (!isIoDumpEnabled()) return null;
  const session: IoDumpSession = {
    requestId: data.requestId,
    startedAt: new Date().toISOString(),
    meta: {
      captureSource: data.source ?? "nginx-mirror",
      userAgent: data.headers["user-agent"] ?? data.headers["User-Agent"] ?? null,
      path: "/v1/chat/completions",
    },
    input: {
      clientHeaders: maskHeaders(data.headers),
      clientBodyRaw: data.rawBody,
    },
    output: { providerWire: "", clientWire: "" },
    finalizedAt: new Date().toISOString(),
    finalizeMeta: {
      stage: "inbound_mirror",
      rawBytes: data.rawBody.length,
      reachedMainRoute: false,
    },
  };
  try {
    const parsed = JSON.parse(data.rawBody);
    session.input.clientBody = parsed;
    session.meta.clientBodySummary = summarizeParsedBody(parsed);
  } catch {
    session.meta.clientBodySummary = { parseError: true, rawBytes: data.rawBody.length };
  }
  const filePath = writeSessionFile(session);
  if (filePath) {
    console.warn(`[IO-DUMP] inbound mirror wrote ${filePath} rawBytes=${data.rawBody.length}`);
  }
  return filePath;
}

export function dumpRouteRejection(
  requestId: string,
  stage: string,
  meta: Record<string, unknown> = {}
): void {
  if (!isIoDumpEnabled() || !requestId) return;
  finalizeIoDump(requestId, { stage, ...meta, reachedHandleChat: false });
}

export function finalizeIoDump(requestId: string, meta: Record<string, unknown> = {}): void {
  if (!isIoDumpEnabled() || !requestId || finalized.has(requestId)) return;
  finalized.add(requestId);
  const session = sessions.get(requestId);
  if (!session) return;
  session.finalizedAt = new Date().toISOString();
  session.finalizeMeta = meta;
  const filePath = writeSessionFile(session);
  sessions.delete(requestId);
  if (filePath) {
    console.warn(
      `[IO-DUMP] wrote ${filePath} clientWire=${session.output.clientWire.length}B providerWire=${session.output.providerWire.length}B`
    );
    // #region agent log
    fetch("http://127.0.0.1:7296/ingest/675e38f5-7d49-4f89-8bb2-5ded82773c09", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b1de6e" },
      body: JSON.stringify({
        sessionId: "b1de6e",
        location: "ioDump.ts:finalizeIoDump",
        message: "io dump file written",
        timestamp: Date.now(),
        data: {
          requestId,
          filePath,
          clientWireBytes: session.output.clientWire.length,
          providerWireBytes: session.output.providerWire.length,
          analysis: parseSseSummary(session.output.clientWire),
          ...meta,
        },
      }),
    }).catch(() => {});
    // #endregion
  }
}

export function resetIoDumpStateForTests(): void {
  sessions.clear();
  finalized.clear();
}
