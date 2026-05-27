import crypto from 'crypto';

// ── Parse directives from system messages ──
// Scans ALL system messages, last directive wins
export function parseDirectives(messages) {
  let enableThinking = null;   // null = not specified (default off)
  let webSearch = null;        // null = not specified (default off)
  let resend = false;          // default: don't resend system prompt

  const cleaned = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      let content = msg.content || '';

      // Extract [think=on/off]
      const thinkMatch = content.match(/\[think\s*=\s*(on|off|true|false|1|0)\]/gi);
      if (thinkMatch) {
        const last = thinkMatch[thinkMatch.length - 1];
        const val = last.match(/=\s*(on|off|true|false|1|0)/i)[1].toLowerCase();
        enableThinking = ['on', 'true', '1'].includes(val);
      }

      // Extract [search=on/off]
      const searchMatch = content.match(/\[search\s*=\s*(on|off|true|false|1|0)\]/gi);
      if (searchMatch) {
        const last = searchMatch[searchMatch.length - 1];
        const val = last.match(/=\s*(on|off|true|false|1|0)/i)[1].toLowerCase();
        webSearch = ['on', 'true', '1'].includes(val);
      }

      // Extract [resend=true/false]
      const resendMatch = content.match(/\[resend\s*=\s*(on|off|true|false|1|0)\]/gi);
      if (resendMatch) {
        const last = resendMatch[resendMatch.length - 1];
        const val = last.match(/=\s*(on|off|true|false|1|0)/i)[1].toLowerCase();
        resend = ['on', 'true', '1'].includes(val);
      }

      // Strip directives from content
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

// ── Build the full query for a NEW conversation (first message) ──
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

// ── Build a continuation query (only new user message) ──
export function buildContinuationQuery(messages, resend) {
  // Get last user message
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return '';

  if (resend) {
    // Prepend all system messages
    const systemParts = messages
      .filter(m => m.role === 'system')
      .map(m => m.content);

    if (systemParts.length > 0) {
      return `[System Instructions]\n${systemParts.join('\n')}\n\n${lastUser.content}`;
    }
  }

  return lastUser.content;
}

// ── Generate a conversation fingerprint for tracking ──
export function generateConvKey(messages, headerConvId) {
  if (headerConvId) return headerConvId;

  // Hash system messages + first user message
  const systemContent = messages
    .filter(m => m.role === 'system')
    .map(m => m.content || '')
    .join('|||');

  const firstUser = messages.find(m => m.role === 'user');
  const seed = systemContent + '|||FIRST_USER|||' + (firstUser ? firstUser.content : '');

  return crypto.createHash('sha256').update(seed).digest('hex');
}

// ── Hash an API key for storage (don't store raw keys in conv table) ──
export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// ── Thinking tag parser (stateful, processes streaming chunks) ──
export class ThinkingParser {
  constructor(thinkingEnabled) {
    this.thinkingEnabled = !!thinkingEnabled;
    this.buffer = '';
    this.state = 'NORMAL'; // NORMAL | THINKING
  }

  process(chunk) {
    // Strip MiMo's null-byte delimiters
    this.buffer += chunk.replace(/\u0000/g, '');
    const results = [];

    while (this.buffer.length > 0) {
      if (this.state === 'NORMAL') {
        const idx = this.buffer.indexOf('
        const idx = this.buffer.indexOf('</think>');
        if (idx !== -1) {
          // Emit everything before </think> as reasoning
          if (idx > 0 && this.thinkingEnabled) {
            results.push({ type: 'reasoning', text: this.buffer.slice(0, idx) });
          }
          this.buffer = this.buffer.slice(idx + 8); // skip '</think>'
          this.state = 'NORMAL';
        } else {
          // Hold back enough for partial '</think>' (8 chars, partial up to 7)
          const hold = Math.min(7, this.buffer.length);
          const safe = this.buffer.length - hold;
          if (safe > 0) {
            if (this.thinkingEnabled) {
              results.push({ type: 'reasoning', text: this.buffer.slice(0, safe) });
            }
            this.buffer = this.buffer.slice(safe);
          }
          break;
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
