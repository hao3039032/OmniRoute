# Cursor + GLM-5.2 tool-call follow-up failure (investigation log)

**Status:** Open — follow-up requests still fail after partial mitigations (2026-07-08).  
**Environment:** Production proxy at `http://ai-new-api.91prize.com` → nginx → OmniRoute Docker on `lwpredict` (`127.0.0.1:4000`).  
**Base:** OmniRoute v3.8.46 (`92715c8f2`).  
**Client:** Cursor `User-Agent: Cursor/1.0`.  
**Combo:** `GLM-5.2` (later reduced to a single `glm-cn/glm-5.2` target).

This document records runtime evidence from the 2026-07-07/08 debugging session. Every path, env var, and symbol below was verified with `grep` against `src/`, `open-sse/`, or `bin/`.

---

## Symptom

1. First `POST /v1/chat/completions` (tool-call turn) returns **HTTP 200** and streams `finish_reason: tool_calls`.
2. Within ~2 seconds, the follow-up `POST` (messages include `assistant` + `tool` roles) fails from Cursor’s perspective (`ERROR_PROVIDER_ERROR` / “Provider returned error”).
3. nginx access log shows **`400` with `5` bytes** for the follow-up; OmniRoute often has **no** `📥 POST` log for that request.
4. **Replaying** the mirrored follow-up body with `curl` through nginx or direct to OmniRoute returns **HTTP 200**.

LiteLLM on the same domain reportedly worked; nginx-only root cause was **rejected** after replay tests succeeded.

---

## Failure pattern (nginx)

Representative lines from `/var/log/nginx/access.log`:

```text
… "POST /v1/chat/completions HTTP/1.1" 200 10328 "-" "Cursor/1.0"
… "POST /v1/chat/completions HTTP/1.1" 400     5 "-" "Cursor/1.0"
```

Same pattern observed with:

- Multi-target combo (`opencode-go` + others)
- **Single-target combo** (`Trying model 1/1: glm-cn/glm-5.2`) — rules out “wrong combo member” as the sole cause.

---

## I/O capture tooling (session additions)

Uncommitted local instrumentation (not on upstream v3.8.46 tag):

| Layer | File | Role |
| ----- | ---- | ---- |
| Dump core | `open-sse/utils/ioDump.ts` | Writes JSON dumps under `$DATA_DIR/io-dumps/` |
| Route entry | `src/app/api/v1/chat/completions/route.ts` | Captures raw body; dumps early rejections |
| Mirror endpoint | `src/app/api/debug/inbound-capture/route.ts` | Returns 204; persists inbound body |
| Public route gate | `src/shared/constants/publicApiRoutes.ts` | `/api/debug/inbound-capture` public when `OMNIROUTE_IO_DUMP=1` |
| Stream flush | `open-sse/utils/stream.ts` | `finalizeIoDump` on stream end |

**Env (deployed on `lwpredict`):**

```bash
OMNIROUTE_IO_DUMP=1
OMNIROUTE_IO_DUMP_UA=Cursor
```

**nginx mirror** (on server, not in this repo): `location = /v1/chat/completions` uses `mirror /_internal/cursor-io-capture` → `http://127.0.0.1:4000/api/debug/inbound-capture`.

**Inspect dumps:**

```bash
docker exec omniroute ls -lt /app/data/io-dumps/ | head
docker logs omniroute 2>&1 | grep -E 'IO-DUMP|inbound mirror' | tail
```

Mirror dumps set `finalizeMeta.stage = "inbound_mirror"` and `reachedMainRoute: false` when the main request never reached `handleChat`.

---

## Follow-up request body (mirror evidence)

Example: `2026-07-07T19-21-41-753Z_a52da87f.json`

- `rawBytes`: 87830
- JSON **valid**; 5 messages (`system`, `user`×2, `assistant` with `tool_calls`, `tool` with large multipart `content`)
- `assistant.content`: `[]` (empty array)
- `reachedMainRoute`: false

**Replay:** same body → OmniRoute **200**; via nginx **200**.

---

## Hypotheses and verdicts

| ID | Hypothesis | Verdict | Evidence |
| -- | ---------- | ------- | -------- |
| H1 | nginx misconfig is primary cause | **Rejected** | Same domain worked with LiteLLM; valid body replays 200 through nginx |
| H2 | OmniRoute rejects follow-up JSON | **Rejected** | No `📥 POST` on failure; replay 200 |
| H3 | Missing `finish_reason: tool_calls` on first response | **Rejected** | Dumps show `finish_reason: tool_calls`, `needsSyntheticFinish: false` |
| H4 | SSE `: x-omniroute-*` comments break Cursor | **Rejected** | After `shouldInjectOmniRouteSseMetadataComment` skip for Cursor, wire has 0 comment lines; **400/5 persists** |
| H5 | Combo routes to `opencode-go` instead of `glm-cn` | **Rejected as sole cause** | Single-target `glm-cn` only (`Trying model 1/1`) still fails |
| H6 | Upstream provider SSE is malformed | **Rejected by operator** | GLM direct (bypassing OmniRoute) works; not pursued further |
| H7 | OmniRoute rewrites `usage` on finish chunk | **Confirmed** (pre-fix) | See §Usage rewrite; **mitigated** in `cursor-usage-fix` image but **failure persists** |
| H8 | Cursor sends malformed follow-up | **Partially confirmed** | Mirror dump `19-13-55`: body literal `null` (4 bytes); other failures mirror full 87830 B |

---

## First-response stream (glm-cn passthrough)

Example success dump: `2026-07-07T19-21-40-314Z_60a234fe.json` (`Trying model 1/1: glm-cn/glm-5.2`).

**Pre-fix client wire** (OmniRoute-transformed finish chunk):

```json
"usage": {
  "prompt_tokens": 19392,
  "completion_tokens": 50,
  "total_tokens": 19442,
  "cached_tokens": 17344,
  "reasoning_tokens": 25
}
```

**Provider wire** (same dump):

```json
"usage": {
  "prompt_tokens": 17392,
  "completion_tokens": 50,
  "total_tokens": 17442,
  "prompt_tokens_details": { "cached_tokens": 17344 },
  "completion_tokens_details": { "reasoning_tokens": 25 }
}
```

`prompt_tokens` inflation (+2000) comes from `addBufferToUsage()` in `open-sse/utils/usageTracking.ts` (via `getBufferTokens()`), applied in passthrough finish handling in `open-sse/utils/stream.ts` when re-serializing the finish chunk.

Cursor requests include `stream_options: { "include_usage": true }` (seen in inbound dumps).

**Post-fix wire** (`omniroute:v3.8.46-cursor-usage-fix`, dump `2026-07-07T19-38-39-358Z_7aa0e991.json`):

- `prompt_tokens` stays **17392** with nested `prompt_tokens_details` / `completion_tokens_details`
- `clientWire` ≈ `providerWire` (minor JSON key ordering only)
- **Follow-up still `400 5`** at `03:38:40` local

---

## Code mitigations attempted (local / deployed images)

| Change | File | Deployed image | Result |
| ------ | ---- | -------------- | ------ |
| Skip SSE metadata comments for Cursor | `src/domain/omnirouteResponseMeta.ts` → `shouldInjectOmniRouteSseMetadataComment`; `open-sse/utils/stream.ts` | `v3.8.46-cursor-sse-fix` | Comments removed; **still fails** |
| Passthrough provider `usage` on finish for Cursor (no `addBufferToUsage` / `filterUsageForFormat`) | `open-sse/utils/stream.ts` | `v3.8.46-cursor-usage-fix` | Usage matches provider; **still fails** |
| Pin auto-scored target before task-route reorder | `open-sse/services/combo.ts` | Not deployed at time of last test | N/A after single-target combo |

**Current production image on `lwpredict`:** `omniroute:v3.8.46-cursor-usage-fix`.

---

## Combo / task-route note (multi-target only)

Logs showed:

```text
Auto selection: glm-cn/glm-5.2
Trying model 1/4: opencode-go/glm-5.2
```

`isTaskRoutingStrategy("auto")` is true (`open-sse/services/taskAwareRouting.ts`). `reorderByTaskWeight()` can move another target ahead of the auto-scored winner when `autoUsedExplicitRouter` is false (`open-sse/services/combo.ts`). Local fix: pin `orderedTargets[0]` when `strategy === "auto"`. Not validated end-to-end after operator moved to a single target.

---

## Open questions

1. Why nginx returns **`400` / 5 B** while mirror sometimes records a **full valid body** on the same timestamp — main request may not equal mirror subrequest from Cursor’s perspective (connection / `Connection: close` on non-WebSocket responses in nginx `map $http_upgrade`).
2. Why Cursor occasionally POSTs body **`null`** (4 bytes) — correlated with client-side parse/state failure after first stream.
3. Whether **byte-identical** passthrough (no `sanitizeStreamingChunk` re-serialize) is required for Cursor on glm-cn tool-call streams.

---

## Suggested next steps

1. Compare **raw TCP/SSE** from GLM direct vs OmniRoute for the same tool-call turn (diff tool, not only JSON dumps).
2. Trial nginx `Connection: keep-alive` for `/v1/chat/completions` (server config on `lwpredict`).
3. Optional Cursor-only **transparent passthrough** mode for glm-cn streaming (no usage rewrite, minimal sanitize) behind an env flag.
4. Keep `OMNIROUTE_IO_DUMP=1` until follow-up `400 5` disappears from nginx logs.

---

## Related symbols (grep-verified)

```bash
grep -rn "shouldInjectOmniRouteSseMetadataComment" src/ open-sse/
grep -rn "OMNIROUTE_IO_DUMP" open-sse/ src/
grep -rn "addBufferToUsage" open-sse/utils/
grep -rn "inbound-capture" src/
grep -rn "isTaskRoutingStrategy" open-sse/services/
```
