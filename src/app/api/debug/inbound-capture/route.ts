import { generateRequestId } from "@/shared/utils/requestId";
import {
  dumpInboundMirror,
  isIoDumpEnabled,
  shouldDumpRequest,
} from "@omniroute/open-sse/utils/ioDump.ts";

/**
 * Loopback-only inbound body capture (nginx mirror target).
 * Dumps the raw POST body to DATA_DIR/io-dumps without touching the chat pipeline.
 */
export async function POST(request: Request) {
  if (!isIoDumpEnabled() || !shouldDumpRequest(request.headers)) {
    return new Response(null, { status: 204 });
  }

  const requestId = request.headers.get("x-correlation-id") || generateRequestId();
  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {
    rawBody = "";
  }

  dumpInboundMirror({
    requestId,
    headers: Object.fromEntries(request.headers.entries()),
    rawBody,
    source: request.headers.get("x-capture-source") ?? "inbound-capture",
  });

  return new Response(null, {
    status: 204,
    headers: { "X-Correlation-Id": requestId },
  });
}
