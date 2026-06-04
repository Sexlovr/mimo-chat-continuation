import crypto from 'crypto';

function extractTextForRegex(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const textBlock = content.find(c => c.type === 'text');
        return textBlock ? textBlock.text : '';
    }
    return '';
}

function applyReplacedText(content, newText) {
    if (typeof content === 'string') return newText;
    if (Array.isArray(content)) {
        return content.map(c => {
            if (c.type === 'text') return { ...c, text: newText };
            return c;
        });
    }
    return newText;
}

// ── Parse directives from system messages AND latest user message ──
export function parseDirectives(messages) {
  let enableThinking = null;
  let webSearch = null;
  let resend = false;

  const cleaned = [];

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'system' || msg.role === 'user') {
      let extractedText = extractTextForRegex(msg.content) || '';
      const isTarget = (msg.role === 'system' || i === lastUserIndex);

      const thinkMatch = extractedText.match(/\[think\s*=\s*(on|off|true|false|1|0)\]/gi);
      if (thinkMatch && isTarget) {
        const last = thinkMatch[thinkMatch.length - 1];
        const val = last.match(/=\s*(on|off|true|false|1|0)/i)[1].toLowerCase();
        enableThinking = ['on', 'true', '1'].includes(val);
      }

      const searchMatch = extractedText.match(/\[search\s*=\s*(on|off|true|false|1|0)\]/gi);
      if (searchMatch && isTarget) {
        const last = searchMatch[searchMatch.length - 1];
        const val = last.match(/=\s*(on|off|true|false|1|0)/i)[1].toLowerCase();
        webSearch = ['on', 'true', '1'].includes(val);
      }

      const resendMatch = extractedText.match(/\[resend\s*=\s*(on|off|true|false|1|0)\]/gi);
      if (resendMatch && isTarget) {
        const last = resendMatch[resendMatch.length - 1];
        const val = last.match(/=\s*(on|off|true|false|1|0)/i)[1].toLowerCase();
        resend = ['on', 'true', '1'].includes(val);
      }

      extractedText = extractedText
        .replace(/\[think\s*=\s*(?:on|off|true|false|1|0)\]/gi, '')
        .replace(/\[search\s*=\s*(?:on|off|true|false|1|0)\]/gi, '')
        .replace(/\[resend\s*=\s*(?:on|off|true|false|1|0)\]/gi, '')
        .trim();

      const finalContent = applyReplacedText(msg.content, extractedText);

      if (extractedText || Array.isArray(msg.content)) {
        cleaned.push({ ...msg, content: finalContent });
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

// ── Conversation fingerprint (Hardened against Identical-Greeting Collisions) ──
export function generateConvKey(messages, headerConvId) {
  if (headerConvId) return headerConvId;

  // Hash ALL system messages
  const systemContent = messages
    .filter(m => m.role === 'system')
    .map(m => m.content || '')
    .join('|||');

  // Include only the FIRST 2 non-system messages (character greeting + first user prompt)
  // These are universally pinned by frontends and will never shift or grow, guaranteeing perfect fingerprint stability.
  const nonSystem = messages.filter(m => m.role !== 'system');
  const earlyMessages = nonSystem.slice(0, 2).map(m => `${m.role}:${m.content || ''}`).join('|||');

  // True Chat Continuation fingerprint algorithm
  // Excludes volatile message lengths so the proxy reliably matches the conversational tree on SQLite!
  const seed = systemContent + '|||MSGS|||' + earlyMessages;

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
          if (idx > 0 && this.thinkingEnabled) {
            results.push({ type: 'reasoning', text: this.buffer.slice(0, idx) });
          }
          this.buffer = this.buffer.slice(idx + THINK_CLOSE_LEN);
          this.state = 'NORMAL';
        } else {
          const hold = Math.min(THINK_CLOSE_PARTIAL, this.buffer.length);
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
      if (this.state === 'THINKING') {
        if (this.thinkingEnabled) {
          results.push({ type: 'reasoning', text: remaining });
        }
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
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/<\/?think>/gi, '');
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

