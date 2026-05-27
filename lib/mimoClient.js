import { generateMsgId } from './translator.js';

const BASE_URL = 'https://aistudio.xiaomimimo.com/open-apis/bot/chat';

const DEFAULT_HEADERS = {
  'accept': '*/*',
  'content-type': 'application/json',
  'origin': 'https://aistudio.xiaomimimo.com',
  'referer': 'https://aistudio.xiaomimimo.com/',
  'sec-ch-ua': '"Chromium";v="143", "Not A(Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'x-timezone': 'UTC'
};

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

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'cookie': cookie
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`MiMo API ${response.status}: ${errText.slice(0, 500)}`);
  }

  return response;
}

// ── Parse a MiMo SSE stream into events ──
export async function* parseMimoSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double newlines (event boundaries) or single newlines (field boundaries)
      const lines = buffer.split('\n');
      buffer = lines.pop(); // potentially incomplete last line

      let currentId = null;
      let currentEvent = null;
      let currentData = null;

      for (const rawLine of lines) {
        const line = rawLine.trim();

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
          currentData = line.slice(5);
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
      let currentId = null, currentEvent = null, currentData = null;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith('id:')) currentId = line.slice(3).trim();
        else if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
        else if (line.startsWith('data:')) currentData = line.slice(5);
      }
      if (currentEvent && currentData !== null) {
        yield { id: currentId, event: currentEvent, data: currentData };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
