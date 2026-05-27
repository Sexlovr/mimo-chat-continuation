import crypto from 'crypto';

// ── Parse directives from system messages ──
export function parseDirectives(messages) {
  let enableThinking = null;
  let webSearch = null;
  let resend = false;

  const cleaned = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      let content = msg.content || '';

      const thinkMatch = content.match(/\[think\s*=\s*(on|off|true|false|1|0)\]/gi);
      if (thinkMatch) {
        const last = thinkMatch[thinkMatch.length - 1];
        const val = last.match(/=\s*(on|off|true|false|1|0)/i)[1].toLowerCase();
        enableThinking = ['on', 'true', '1'].includes(val);
      }

      const searchMatch = content.match(/\[search\s*=\s*(on|off|true|false|1|0)\]/gi);
      if (searchMatch) {
        const last = searchMatch[searchMatch.length - 1];
        const val = last.match(/=\s*(on|off|true|false|1|0)/i)[1].toLowerCase();
        webSearch = ['on', 'true', '1'].includes(val);
      }

      const resendMatch = content.match(/\[resend\s*=\s*(on|off|true|false|1|0)\]/gi);
      if (resendMatch) {
        const last = resendMatch[resendMatch.length - 1];
        const val = last.match(/=\s*(on|off|true|false|1|0)/i)[1].toLowerCase();
        resend = ['on', 'true', '1'].includes(val);
      }

      content = content
        .replace(/\[think\s*=\s*(?:on|off|true|false|1|0)\]/gi, '')
        .replace(/\[search\s*=\s*(?:on|off|true|false|1|0)\]/gi, '')
        .replace(/\[resend\s*=\s*(?:on|off|true|false|1|0)\]/gi, '')
        .trim();

      if (content) {
        cleaned.push({ ...msg, content });
      }
    } else {
      cleaned.push(msg);
    }
  }

  return { enableThinking, webSearch, resend, cleanedMessages: cleaned };
}

// ── Build full query for NEW conversation ──
export function buildNewConversationQuery(messages) {
  const parts = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        parts.push(`[System Instructions]\n${msg.content}`);
        break;
      case 'user':
        parts.push(`[User]\n${msg.content}`);
        break;
      case 'assistant':
        parts.push(`[Assistant]\n${msg.content}`);
        break;
      default:
        parts.push(`[${msg.role}]\n${msg.content}`);
    }
  }

  return parts.join('\n\n');
}

// ── Build continuation query (only latest user message) ──
export function buildContinuationQuery(messages, resend) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return '';

  if (resend) {
    const systemParts = messages
      .filter(m => m.role === 'system')
      .map(m => m.content);

    if (systemParts.length > 0) {
      return `[System Instructions]\n${systemParts.join('\n')}\n\n${lastUser.content}`;
    }
  }

  return lastUser.content;
}

// ── Conversation fingerprint ──
export function generateConvKey(messages, headerConvId) {
  if (headerConvId) return headerConvId;

  const systemContent = messages
    .filter(m => m.role === 'system')
    .map(m => m.content || '')
    .join('|||');

  const firstUser = messages.find(m => m.role === 'user');
  const seed = systemContent + '|||FIRST_USER|||' + (firstUser ? firstUser.content : '');

  return crypto.createHash('sha256').update(seed).digest('hex');
}

// ── Hash API key for conversation table ──
export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// ══════════════════════════════════════════
//  ThinkingParser — streaming state machine
//  <think> = opening think tag (7 chars)
//  </think> = closing think tag (8 chars)
//  Replace them yourself before running
// ══════════════════════════════════════════
const THINK_OPEN = '<think>';       // line 104 — replace with real opening think tag
const THINK_OPEN_LEN = 7;        // line 105 — length of real opening think tag
const THINK_OPEN_PARTIAL = 6;    // line 106 — THINK_OPEN_LEN - 1

const THINK_CLOSE = '</think>';    // line 108 — replace with real closing think tag
const THINK_CLOSE_LEN = 8;      // line 109 — length of real closing think tag
const THINK_CLOSE_PARTIAL = 7;  // line 110 — THINK_CLOSE_LEN - 1

export class ThinkingParser {
  constructor(thinkingEnabled) {
    this.thinkingEnabled = !!thinkingEnabled;
    this.buffer = '';
    this.state = 'NORMAL';
  }

  process(chunk) {
    this.buffer += chunk.replace(/\u0000/g, '');
    const results = [];

    while (this.buffer.length > 0) {
      if (this.state === 'NORMAL') {
        // ── Search for opening tag ──
        const idx = this.buffer.indexOf(THINK_OPEN);

        if (idx !== -1) {
          // Emit everything before the tag as content
          if (idx > 0) {
            results.push({ type: 'content', text: this.buffer.slice(0, idx) });
          }
          // Skip past the opening tag and switch to THINKING
          this.buffer = this.buffer.slice(idx + THINK_OPEN_LEN);
          this.state = 'THINKING';
        } else {
          // No opening tag found — hold back enough for partial detection
          const hold = Math.min(THINK_OPEN_PARTIAL, this.buffer.length);
          const safe = this.buffer.length - hold;

          if (safe > 0) {
            results.push({ type: 'content', text: this.buffer.slice(0, safe) });
            this.buffer = this.buffer.slice(safe);
          }
          break; // Wait for more data
        }

      } else if (this.state === 'THINKING') {
        // ── Search for closing tag ──
        const idx = this.buffer.indexOf(THINK_CLOSE);

        if (idx !== -1) {
          // Emit everything before closing tag as reasoning
          if (idx > 0 && this.thinkingEnabled) {
            results.push({ type: 'reasoning', text: this.buffer.slice(0, idx) });
          }
          // Skip past closing tag and return to NORMAL
          this.buffer = this.buffer.slice(idx + THINK_CLOSE_LEN);
          this.state = 'NORMAL';
        } else {
          // Hold back enough for partial closing tag
          const hold = Math.min(THINK_CLOSE_PARTIAL, this.buffer.length);
          const safe = this.buffer.length - hold;

          if (safe > 0) {
            if (this.thinkingEnabled) {
              results.push({ type: 'reasoning', text: this.buffer.slice(0, safe) });
            }
            this.buffer = this.buffer.slice(safe);
          }
          break; // Wait for more data
        }
      }
    }

    return results;
  }

  flush() {
    const results = [];
    const remaining = this.buffer.replace(/\u0000/g, '');

    if (remaining.length > 0) {
      if (this.state === 'THINKING' && this.thinkingEnabled) {
        results.push({ type: 'reasoning', text: remaining });
      } else if (this.state === 'NORMAL') {
        results.push({ type: 'content', text: remaining });
      }
    }

    this.buffer = '';
    return results;
  }
}

// ── Build OpenAI SSE chunk ──
export function buildOpenAIChunk(id, model, delta, finishReason, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: delta || {},
      finish_reason: finishReason || null
    }]
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ── Build OpenAI non-streaming response ──
export function buildOpenAIResponse(id, model, content, reasoning, usage) {
  const message = { role: 'assistant', content: content || '' };
  if (reasoning) message.reasoning_content = reasoning;

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: 'stop'
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

export function generateId() {
  return 'chatcmpl-' + crypto.randomBytes(16).toString('hex');
}

export function generateMsgId() {
  return crypto.randomBytes(16).toString('hex');
}

export function generateConversationId() {
  return crypto.randomBytes(16).toString('hex');
}
