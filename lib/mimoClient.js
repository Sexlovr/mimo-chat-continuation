import { generateMsgId } from './translator.js';

const BASE_URL = 'https://aistudio.xiaomimimo.com/open-apis/bot/chat';

/**
 * Build browser-like headers dynamically.
 * If the account row has a `headers_json` column (future),
 * we could use those instead; for now we use sensible Chrome defaults.
 */
function buildHeaders(cookie) {
  return {
    'accept': '*/*',
    'accept-language': 'system',
    'content-type': 'application/json',
    'cookie': cookie,
    'origin': 'https://aistudio.xiaomimimo.com',
    'referer': 'https://aistudio.xiaomimimo.com/',
    'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'x-timezone': 'Asia/Dhaka'
  };
}

/**
 * @param {object} account        - DB account row
 * @param {string} query          - The text to send
 * @param {object} modelConfig    - {enableThinking, webSearchStatus, model, temperature, topP}
 * @param {string} conversationId - Persistent conversation ID for session continuity
 */
export async function fetchMimoStream(account, query, modelConfig, conversationId) {
  const phEncoded = encodeURIComponent(account.ph_token);
  const url = `${BASE_URL}?xiaomichatbot_ph=${phEncoded}`;

  const cookie = `serviceToken="${account.service_token}"; userId=${account.user_id}; xiaomichatbot_ph="${account.ph_token}"`;

  const body = {
    msgId: generateMsgId(),
    conversationId,
    query,
    isEditedQuery: false,
    modelConfig,
    multiMedias: []
  };

  const headers = buildHeaders(cookie);

  // ── Debug log (set DEBUG=1 env to enable) ──
  if (process.env.DEBUG === '1') {
    console.log('[DEBUG] ── MiMo Request ──');
    console.log('[DEBUG] URL:', url);
    console.log('[DEBUG] Cookie:', cookie.slice(0, 80) + '...');
    console.log('[DEBUG] ph_token raw:', account.ph_token);
    console.log('[DEBUG] ph_token encoded:', phEncoded);
    console.log('[DEBUG] serviceToken length:', account.service_token?.length);
    console.log('[DEBUG] Body:', JSON.stringify(body).slice(0, 200));
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');

    // Log full details on auth failure
    if (response.status === 401) {
      console.error('[AUTH 401] Account:', account.user_id);
      console.error('[AUTH 401] ph_token:', account.ph_token);
      console.error('[AUTH 401] serviceToken (first 40):', account.service_token?.slice(0, 40));
      console.error('[AUTH 401] Response:', errText.slice(0, 300));
    }

    throw new Error(`MiMo API ${response.status}: ${errText.slice(0, 500)}`);
  }

  return response;
}

// ── Parse a MiMo SSE stream into events ──
export async function* parseMimoSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let currentId = null;
  let currentEvent = null;
  let currentData = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double newlines (event boundaries) or single newlines (field boundaries)
      const lines = buffer.split('\n');
      buffer = lines.pop(); // potentially incomplete last line

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r/g, '');

        if (line === '') {
          // Event boundary — emit if we have a complete event
          if (currentEvent && currentData !== null) {
            yield { id: currentId, event: currentEvent, data: currentData };
          }
          currentId = null;
          currentEvent = null;
          currentData = null;
          continue;
        }

        if (line.startsWith('id:')) {
          currentId = line.slice(3).trim();
        } else if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          let content = line.slice(5);
          if (content.startsWith(' ')) content = content.slice(1);

          if (currentData === null) {
            currentData = content;
          } else {
            currentData += '\n' + content;
          }
        }
      }

      // Check for a complete event at the end without trailing blank line
      // (some servers don't send final blank line before next event)
      if (currentEvent && currentData !== null) {
        yield { id: currentId, event: currentEvent, data: currentData };
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      const lines = buffer.split('\n');
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r/g, '');
        if (line.startsWith('id:')) currentId = line.slice(3).trim();
        else if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          let content = line.slice(5);
          if (content.startsWith(' ')) content = content.slice(1);
          if (currentData === null) currentData = content;
          else currentData += '\n' + content;
        }
      }
      if (currentEvent && currentData !== null) {
        yield { id: currentId, event: currentEvent, data: currentData };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
