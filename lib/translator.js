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
// ══════════════════════════════════════════
const THINK_OPEN = '<think>';
const THINK_OPEN_LEN = 7;
const THINK_OPEN_PARTIAL = 6;

const THINK_CLOSE = '</think>';
const THINK_CLOSE_LEN = 8;
const THINK_CLOSE_PARTIAL = 7;

export class ThinkingParser {
  constructor(thinkingEnabled) {
    this.thinkingEnabled = !!thinkingEnabled;
    this.buffer = '';
    this.state = 'NORMAL';
  }

  process(chunk) {
    // Strip null bytes that MiMo inserts between tags and content
    this.buffer += chunk.replace(/\u0000/g, '');
    const results = [];

    let iterations = 0;
    while (this.buffer.length > 0 && iterations++ < 500) {
      if (this.state === 'NORMAL') {
        const idx = this.buffer.indexOf(THINK_OPEN);

        if (idx !== -1) {
          if (idx > 0) {
            results.push({ type: 'content', text: this.buffer.slice(0, idx) });
          }
          this.buffer = this.buffer.slice(idx + THINK_OPEN_LEN);
          this.state = 'THINKING';
        } else {
          // Hold back enough chars for partial <think> detection
          const hold = Math.min(THINK_OPEN_PARTIAL, this.buffer.length);
          const safe = this.buffer.length - hold;

          if (safe > 0) {
            results.push({ type: 'content', text: this.buffer.slice(0, safe) });
            this.buffer = this.buffer.slice(safe);
          }
          break;
        }

      } else if (this.state === 'THINKING') {
        const idx = this.buffer.indexOf(THINK_CLOSE);

        if (idx !== -1) {
          // Emit thinking content as reasoning ONLY if thinking is enabled
          if (idx > 0 && this.thinkingEnabled) {
            results.push({ type: 'reasoning', text: this.buffer.slice(0, idx) });
          }
          // Always skip past the closing tag
          this.buffer = this.buffer.slice(idx + THINK_CLOSE_LEN);
          this.state = 'NORMAL';
        } else {
          // Hold back enough for partial </think> detection
          const hold = Math.min(THINK_CLOSE_PARTIAL, this.buffer.length);
          const safe = this.buffer.length - hold;

          if (safe > 0) {
            if (this.thinkingEnabled) {
              results.push({ type: 'reasoning', text: this.buffer.slice(0, safe) });
            }
            // Always trim the buffer even when dropping content
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
      if (this.state === 'THINKING') {
        if (this.thinkingEnabled) {
          results.push({ type: 'reasoning', text: remaining });
        }
        // When disabled: silently drop — do NOT emit as content
      } else if (this.state === 'NORMAL') {
        results.push({ type: 'content', text: remaining });
      }
    }

    this.buffer = '';
    this.state = 'NORMAL';
    return results;
  }
}

// ── Strip any residual <think> tags from final output (safety net) ──
export function cleanThinkTags(text) {
  if (!text) return '';
  // Remove <think>...</think> blocks (incl. multiline)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Remove orphaned opening/closing tags
  cleaned = cleaned.replace(/<\/?think>/gi, '');
  // Strip null bytes
  cleaned = cleaned.replace(/\u0000/g, '');
  return cleaned.trim();
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
