# mimo-chat-continuation

OpenAI-compatible reverse proxy for **Xiaomi MiMo Studio** chat (`https://aistudio.xiaomimimo.com/#/c`) with **true chat continuation** — long conversations are split across multiple MiMo API calls using a server-side persisted `conversationId`, so you never hit the per-message token cap (~25k tokens).

## Why continuation?

The MiMo `mimo-v2.5-pro` chat endpoint accepts a single `query` string per call. Empirically the per-message cap is ~25,000 tokens (the model silently returns an empty stream above ~26k tokens). For multi-turn OpenAI-style chat with full history, that's not enough.

The MiMo backend, however, **persists conversation history server-side** keyed by `conversationId`. So instead of resending the whole transcript every turn (which would blow the cap), this proxy:

1. Fingerprints each OpenAI conversation (hash of system + first 2 non-system messages).
2. Stores the mapping `conv_key → mimo_conversation_id` in SQLite.
3. On the first request for a conversation: creates a new MiMo conversation and sends the **full transcript** as the query (formatted as `[System Instructions]…[User]…[Assistant]…`).
4. On subsequent requests for the same conversation: reuses the stored `mimo_conversation_id` and sends **only the latest user message**. MiMo's server replays the prior turns itself.
5. Falls back to a fresh conversation if the stored one is older than `CONV_TIMEOUT_MINUTES` (default 60).

This means token usage stays tiny per call regardless of how long the OpenAI-side conversation grows.

## Token cap (measured)

| Input size (chars) | ~Tokens | Result |
|---|---|---|
| 1,000    | 250   | OK |
| 10,000   | 2,500 | OK |
| 50,000   | 12,500 | OK |
| 100,000  | 25,000 | OK (promptTokens=23101) |
| 106,250  | 26,563 | FAIL (empty stream, no usage) |
| 200,000  | 50,000 | FAIL |

So the safe per-query budget is **~25,000 tokens**. The continuation approach keeps every individual call well under that.

## Endpoints

### OpenAI-compatible
- `GET  /v1/models`
- `POST /v1/chat/completions` (streaming + non-streaming, with `reasoning_content` for `[think=on]`)

### Admin (JWT-protected)
- `POST /admin/login` — password → JWT
- `GET/POST/DELETE/PATCH /admin/accounts` — manage MiMo accounts (manual cURL import still supported)
- **`POST /admin/accounts/autologin`** — **NEW**: trigger CDP-based browser login so you don't have to paste cURL. Two-phase (see below).
- `POST /admin/accounts/:id/test` — validate stored credentials with a 1-token probe
- `GET/POST/DELETE/PATCH /admin/keys` — manage API keys (`sk-mimo-…`)
- `GET/POST/DELETE/PATCH /admin/models`
- `GET/DELETE /admin/conversations`

## Auto-login flow (new)

No more manually copy-pasting cURL from devtools every 30 days. The proxy can drive a headless chromium via CDP to log in for you.

### Prerequisites
- A chromium binary on `PATH` (`chromium`, `google-chrome`, …) OR a running chromium with `--remote-debugging-port=9333`.
- The `captures/tools/` scripts: `cdp.mjs`, `login.mjs`, `autologin.mjs`.

### Phase 1 — start login
```bash
curl -X POST http://localhost:7860/admin/accounts/autologin \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"YourPassword"}'
# → {"status":"awaiting_code", ...}
# A 6-digit code is emailed to you by Xiaomi.
```

### Phase 2 — complete login
```bash
curl -X POST http://localhost:7860/admin/accounts/autologin \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"YourPassword","code":"123456"}'
# → {"message":"Account added via auto-login","userId":"6886874562", ...}
```

The proxy then immediately uses the fresh cookies for chat requests. Cookies expire ~30 days; re-run Phase 1+2 before then.

### Standalone (no admin panel)
```bash
node captures/tools/autologin.mjs --email=you@example.com --password=Secret
# paste code when prompted, or re-run with --code=NNNNNN
# → prints {"serviceToken":"…","userId":"…","phToken":"…"} on stdout
```

## Directives (inline in messages)

Place any of these in a `system` or the latest `user` message:
- `[think=on]` / `[think=off]` — toggle MiMo reasoning (streamed as `reasoning_content`).
- `[search=on]` / `[search=off]` — toggle web search.
- `[resend=on]` — on continuation, also resend the system prompt with the new user message.

## Captured API reference

See [`CAPTURE_NOTES.md`](./CAPTURE_NOTES.md) for the full reverse-engineering notes (endpoints, SSE event format, auth cookies, model IDs).

## Running

```bash
# Local
npm install
ADMIN_PASSWORD=admin npm start
# → http://localhost:7860

# Docker (HuggingFace Spaces-compatible)
docker build -t mimo2api .
docker run -p 7860:7860 -e ADMIN_PASSWORD=admin -v $PWD/data:/data mimo2api
```

Environment:
| var | default | meaning |
|---|---|---|
| `PORT` | 7860 | HTTP port |
| `ADMIN_PASSWORD` | admin | admin panel password |
| `JWT_SECRET` | random | JWT signing secret |
| `CONV_TIMEOUT_MINUTES` | 60 | conversation reuse window |
| `CLEANUP_HOURS` | 24 | SQLite cleanup age |
| `DATA_DIR` | cwd | SQLite + persistent storage |
| `MIMO_EMAIL` / `MIMO_PASSWORD` / `MIMO_CODE` | – | for `autologin.mjs` |
| `MIMO_PROFILE` | `/tmp/mimo-cdp-profile` | chromium user-data-dir |
