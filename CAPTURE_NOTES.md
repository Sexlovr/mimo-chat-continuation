# MiMo 2 API — Capture Notes

## Status: ✅ Chat API fully captured & verified
- Login (browser-based CDP) ✅
- Chat send + SSE response ✅
- Direct Node replay (no browser) ✅
- API wrapper: in progress

## Account
- Email: `vonlth3645@javaemail.com`
- Password: `Admin1234`
- userId: `6886874562`
- Login URL: `https://account.xiaomi.com/fe/service/login/password` → email verification step (code sent to email)
- After login: navigate to `https://aistudio.xiaomimimo.com/#/c`
  - Dismiss cookie banner (button "Accept All")
  - Click "Sign in" button — uses existing passport cookies to authenticate, returns to chat page

---

## Chat API Overview

**Base host:** `https://aistudio.xiaomimimo.com`

**Authentication:** Cookies set on `.xiaomimimo.com` after SSO handoff:
- `xiaomichatbot_serviceToken` — large base64-encoded encrypted token (the main auth)
- `userId` — e.g. `6886874562`
- `xiaomichatbot_ph` — short string like `"DYXNVSyWCvBPHx/bPp8h3Q=="`. Must also be passed as URL query string `?xiaomichatbot_ph=<URL-ENCODED>` on every chat API call.

**Default headers** (observed):
```
content-type: application/json
accept: */*
accept-language: en-US,en;q=0.9
origin: https://aistudio.xiaomimimo.com
referer: https://aistudio.xiaomimimo.com/
x-timezone: UTC
user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36
cookie: xiaomichatbot_serviceToken=<...>; userId=6886874562; xiaomichatbot_ph=<...>
```

---

## Endpoints

### 1. `POST /open-apis/chat/conversation/save`

Creates a conversation. Call once per chat session.

**Body:**
```json
{
  "conversationId": "661b091b51bd39a76e7c910306af6265",   // 32 hex chars, generate client-side
  "title": "New conversation",
  "type": "chat"
}
```

**Response:**
```json
{"code":0,"msg":"成功","data":{"id":4600421,"creator":"6886874562","createTime":"...","title":"New conversation","conversationId":"661b091b...","deleteFlag":0,"type":"chat"}}
```

### 2. `POST /open-apis/bot/chat` — **The actual chat completion (SSE)**

**Body:**
```json
{
  "msgId": "5f3dd0d1c9efb51154666fc9ed405a90",          // 32 hex chars, generate per message
  "conversationId": "<conv-id from step 1>",
  "query": "Hello, what is 2+2?",
  "isEditedQuery": false,
  "modelConfig": {
    "enableThinking": false,
    "webSearchStatus": "disabled",
    "model": "mimo-v2.5-pro"
  },
  "multiMedias": []
}
```

**Response:** `text/event-stream` (SSE)

Events (each block ends with blank line, fields are `id:`, `event:`, `data:`):

```
id:9e3e819e93749759bd60a59d6efb4df6
event:dialogId
data:{"content":"9952598"}

id:9e3e819e93749759bd60a59d6efb4df6
event:message
data:{"type":"text","content":""}            ← first chunk is empty (init marker)

id:9e3e819e93749759bd60a59d6efb4df6
event:message
data:{"type":"text","content":"The capital"}

id:9e3e819e93749759bd60a59d6efb4df6
event:message
data:{"type":"text","content":" of France is Paris."}

id:9e3e819e93749759bd60a59d6efb4df6
event:usage
data:{"promptTokens":3103,"completionTokens":65,"totalTokens":3168,"nativeUsage":{...,"completion_tokens_details":{"reasoning_tokens":56}}}

id:9e3e819e93749759bd60a59d6efb4df6
event:finish
data:{"content":"[DONE]"}
```

**Notes:**
- Same `id:` repeats for every block (the dialog id).
- `event:dialogId` is sent first.
- Multiple `event:message` blocks carry the assistant text in `content` — concatenate them.
- `\u0000` byte may appear inside `content` — observed when `enableThinking: false`. Frontend likely uses it as a separator. For our wrapper just stream them through; clients can ignore or strip.
- `event:usage` carries token counts (1 block before finish).
- `event:finish` carries `{"content":"[DONE]"}` — end of stream.
- If `enableThinking: true`, expect `event:message` with `{"type":"thinking",...}` chunks before the text ones (not yet verified — left as TODO).

**Model IDs seen in UI:** `mimo-v2.5-pro` (default visible). Other models likely exist (e.g., `mimo-v2.5-asr` for ASR — seen in mimocode binary strings).

### 3. `POST /open-apis/chat/conversation/genTitle` (optional)
```json
{"conversationId":"<conv-id>","content":"<full user + assistant text>"}
```
Returns `{"code":0,"msg":"成功","data":"<title>"}`

### 4. `GET /open-apis/user/mimo-claw/status`
Returns free/subscription plan info:
```json
{"code":0,"msg":"成功","data":{"status":"NOT_CREATED","resource":{"status":"NOT_CREATED","resourceType":"FREE","dataCleaned":true},"billing":{"edition":"FREE","billingPriority":"FREE","tokenPlan":{"status":"NONE","exhausted":false},"apiKey":{"required":false,"bound":false}},"clusterKey":"OVERSEA"}}
```

---

## Autorenewal / Refresh (#todo)
- `xiaomichatbot_serviceToken` expires ~30 days (until 2026-09-05). Re-login via browser before that.
- Login contract for `aistudio.xiaomimimo.com`:
  1. With `xiaomi.com` passport cookies present (passToken/serviceToken), the user just clicks "Sign in" on `/#/c`.
  2. The site redirects to an OAuth callback and sets the `.xiaomimimo.com` cookies.
- Wrapper will include a `login.mjs` that uses CDP to (a) log in to xiaomi.com with email+password, (b) complete email verification with user-provided code, (c) navigate to aistudio, (d) click Sign in, (e) extract `.xiaomimimo.com` cookies to a JSON file.

## Files
- `/data/projects/mimo2api/captures/tools/cdp.mjs` — dependency-free CDP driver
- `/data/projects/mimo2api/captures/tools/login.mjs` — browser email+password login flow
- `/data/projects/mimo2api/captures/tools/chat-send.mjs` — chat send + capture script
- `/data/projects/mimo2api/lib/replay-test.mjs` — direct HTTP replay (verified)
- `/data/projects/mimo2api/cooks.json` — extracted cookies (created by wrapper) — #todo
- `/home/user/mimo-capture/net/2026-08-06T05-41-30-chat-send.jsonl` — full capture of first chat send
