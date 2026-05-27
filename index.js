import express from 'express';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB, getDB, cleanupOldConversations } from './lib/database.js';
import { parseCurl } from './lib/curlParser.js';
import { fetchMimoStream, parseMimoSSE } from './lib/mimoClient.js';
import {
  parseDirectives,
  buildNewConversationQuery,
  buildContinuationQuery,
  generateConvKey,
  hashApiKey,
  ThinkingParser,
  buildOpenAIChunk,
  buildOpenAIResponse,
  generateId,
  generateConversationId
} from './lib/translator.js';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const CONV_TIMEOUT = parseInt(process.env.CONV_TIMEOUT_MINUTES) || 60;

// ── Round-robin counter (only for NEW conversations) ──
let rrIndex = 0;

function getNextAccount() {
  const db = getDB();
  const accounts = db.prepare('SELECT * FROM accounts WHERE active = 1').all();
  if (accounts.length === 0) return null;
  rrIndex = rrIndex % accounts.length;
  const account = accounts[rrIndex];
  rrIndex++;
  return account;
}

function bumpAccountUsage(accountId) {
  getDB().prepare('UPDATE accounts SET request_count = request_count + 1, last_used = datetime("now") WHERE id = ?').run(accountId);
}

// ══════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error();
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: { message: 'Missing API key', type: 'auth_error' } });
  }
  const key = authHeader.split(' ')[1];
  const db = getDB();
  const row = db.prepare('SELECT * FROM api_keys WHERE key = ? AND active = 1').get(key);
  if (!row) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
  }
  db.prepare('UPDATE api_keys SET request_count = request_count + 1 WHERE id = ?').run(row.id);
  // Attach to request for downstream use
  req.apiKey = key;
  req.apiKeyHash = hashApiKey(key);
  next();
}

// ══════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

// ── Accounts ──
app.get('/admin/accounts', adminAuth, (req, res) => {
  const rows = getDB().prepare('SELECT id, label, user_id, active, request_count, last_used, created_at FROM accounts').all();
  res.json(rows);
});

app.post('/admin/accounts', adminAuth, (req, res) => {
  const { curl, label } = req.body;
  if (!curl) return res.status(400).json({ error: 'cURL string required' });

  const parsed = parseCurl(curl);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const existing = getDB().prepare('SELECT id FROM accounts WHERE user_id = ?').get(parsed.userId);
  if (existing) {
    getDB().prepare('UPDATE accounts SET service_token = ?, ph_token = ?, label = ?, active = 1 WHERE id = ?')
      .run(parsed.serviceToken, parsed.phToken, label || '', existing.id);
    return res.json({ message: 'Account updated', id: existing.id });
  }

  const result = getDB().prepare('INSERT INTO accounts (label, service_token, user_id, ph_token) VALUES (?, ?, ?, ?)')
    .run(label || '', parsed.serviceToken, parsed.userId, parsed.phToken);
  res.json({ message: 'Account added', id: result.lastInsertRowid });
});

app.delete('/admin/accounts/:id', adminAuth, (req, res) => {
  getDB().prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  // Also clean up conversations pinned to this account
  getDB().prepare('DELETE FROM conversations WHERE account_id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

app.patch('/admin/accounts/:id', adminAuth, (req, res) => {
  const { active, label } = req.body;
  if (active !== undefined) {
    getDB().prepare('UPDATE accounts SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  }
  if (label !== undefined) {
    getDB().prepare('UPDATE accounts SET label = ? WHERE id = ?').run(label, req.params.id);
  }
  res.json({ message: 'Updated' });
});

// ── API Keys ──
app.get('/admin/keys', adminAuth, (req, res) => {
  const rows = getDB().prepare('SELECT * FROM api_keys').all();
  res.json(rows);
});

app.post('/admin/keys', adminAuth, (req, res) => {
  const { name } = req.body;
  const key = 'sk-mimo-' + crypto.randomBytes(24).toString('hex');
  const result = getDB().prepare('INSERT INTO api_keys (name, key) VALUES (?, ?)').run(name || '', key);
  res.json({ message: 'Key created', id: result.lastInsertRowid, key });
});

app.delete('/admin/keys/:id', adminAuth, (req, res) => {
  getDB().prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

app.patch('/admin/keys/:id', adminAuth, (req, res) => {
  const { active } = req.body;
  if (active !== undefined) {
    getDB().prepare('UPDATE api_keys SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  }
  res.json({ message: 'Updated' });
});

// ── Models ──
app.get('/admin/models', adminAuth, (req, res) => {
  const rows = getDB().prepare('SELECT * FROM models').all();
  res.json(rows);
});

app.post('/admin/models', adminAuth, (req, res) => {
  const { model_id, display_name } = req.body;
  if (!model_id) return res.status(400).json({ error: 'model_id required' });
  try {
    const result = getDB().prepare('INSERT INTO models (model_id, display_name) VALUES (?, ?)')
      .run(model_id, display_name || model_id);
    res.json({ message: 'Model added', id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Model already exists' });
    throw e;
  }
});

app.delete('/admin/models/:id', adminAuth, (req, res) => {
  getDB().prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

app.patch('/admin/models/:id', adminAuth, (req, res) => {
  const { active } = req.body;
  if (active !== undefined) {
    getDB().prepare('UPDATE models SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  }
  res.json({ message: 'Updated' });
});

// ── Admin: view active conversations ──
app.get('/admin/conversations', adminAuth, (req, res) => {
  const rows = getDB().prepare(`
    SELECT c.id, c.conv_key, c.mimo_conversation_id, c.account_id, c.message_count,
           c.model, c.last_used, c.created_at, a.label as account_label, a.user_id
    FROM conversations c
    LEFT JOIN accounts a ON c.account_id = a.id
    ORDER BY c.last_used DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

app.delete('/admin/conversations', adminAuth, (req, res) => {
  const result = getDB().prepare('DELETE FROM conversations').run();
  res.json({ message: `Cleared ${result.changes} conversations` });
});

// ══════════════════════════════════════════
//  OPENAI-COMPATIBLE ROUTES
// ══════════════════════════════════════════

app.get('/v1/models', apiKeyAuth, (req, res) => {
  const rows = getDB().prepare('SELECT * FROM models WHERE active = 1').all();
  res.json({
    object: 'list',
    data: rows.map(r => ({
      id: r.model_id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'xiaomi'
    }))
  });
});

app.post('/v1/chat/completions', apiKeyAuth, async (req, res) => {
  const db = getDB();

  try {
    const { messages, model, stream, temperature, top_p } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages array required', type: 'invalid_request' } });
    }

    // Must have at least one user message
    const hasUser = messages.some(m => m.role === 'user');
    if (!hasUser) {
      return res.status(400).json({ error: { message: 'At least one user message required', type: 'invalid_request' } });
    }

    const requestedModel = model || 'mimo-v2.5-pro';
    const completionId = generateId();

    // ── Parse directives ──
    const { enableThinking, webSearch, resend, cleanedMessages } = parseDirectives(messages);

    // ── Conversation tracking ──
    const headerConvId = req.headers['x-conversation-id'] || null;
    const convKey = generateConvKey(cleanedMessages, headerConvId);
    const apiKeyHash = req.apiKeyHash;

    // Look up existing conversation (within timeout window)
    let conv = db.prepare(`
      SELECT * FROM conversations 
      WHERE conv_key = ? AND api_key_hash = ? 
      AND last_used > datetime('now', '-${CONV_TIMEOUT} minutes')
    `).get(convKey, apiKeyHash);

    let query, mimoConversationId, account;
    let isContinuation = false;

    if (conv && messages.length > conv.message_count) {
      // ═══ CONTINUATION ═══
      // Verify the pinned account is still active
      account = db.prepare('SELECT * FROM accounts WHERE id = ? AND active = 1').get(conv.account_id);

      if (account) {
        isContinuation = true;
        mimoConversationId = conv.mimo_conversation_id;
        query = buildContinuationQuery(cleanedMessages, resend);

        // Update message count & timestamp
        db.prepare('UPDATE conversations SET message_count = ?, last_used = datetime("now"), model = ? WHERE id = ?')
          .run(messages.length, requestedModel, conv.id);

        console.log(`[Conv] Continuation: ${convKey.slice(0, 12)}... | msgs: ${conv.message_count} → ${messages.length} | account: ${account.user_id}`);
      } else {
        // Account disabled/deleted — fall through to new conversation
        db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
        conv = null;
      }
    }

    if (!conv || !isContinuation) {
      // ═══ NEW CONVERSATION ═══
      // Delete any stale entry with same key
      db.prepare('DELETE FROM conversations WHERE conv_key = ? AND api_key_hash = ?').run(convKey, apiKeyHash);

      account = getNextAccount();
      if (!account) {
        return res.status(503).json({ error: { message: 'No active accounts available', type: 'server_error' } });
      }

      mimoConversationId = generateConversationId();
      query = buildNewConversationQuery(cleanedMessages);

      // Store new conversation
      db.prepare(`INSERT INTO conversations (conv_key, api_key_hash, mimo_conversation_id, account_id, message_count, model)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(convKey, apiKeyHash, mimoConversationId, account.id, messages.length, requestedModel);

      console.log(`[Conv] New: ${convKey.slice(0, 12)}... | msgs: ${messages.length} | account: ${account.user_id}`);
    }

    // Bump account usage
    bumpAccountUsage(account.id);

    // ── Build MiMo model config ──
    const modelConfig = {
      enableThinking: enableThinking ?? false,
      webSearchStatus: webSearch ? 'enabled' : 'disabled',
      model: requestedModel,
      temperature: temperature ?? 0.8,
      topP: top_p ?? 0.95
    };

    // ── Fetch from MiMo ──
    const mimoResponse = await fetchMimoStream(account, query, modelConfig, mimoConversationId);

    // ── Process response ──
    const thinkingActive = enableThinking === true;

    if (stream) {
      // ═══ STREAMING ═══
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Conversation-Id', convKey);

      // Initial role chunk
      res.write(buildOpenAIChunk(completionId, requestedModel, { role: 'assistant', content: '' }, null, null));

      const thinkParser = new ThinkingParser(thinkingActive);
      let usageData = null;

      try {
        for await (const event of parseMimoSSE(mimoResponse)) {
          if (event.event === 'message') {
            let parsed;
            try { parsed = JSON.parse(event.data); } catch { continue; }
            if (parsed.type !== 'text' || parsed.content === undefined) continue;

            const segments = thinkParser.process(parsed.content);
            for (const seg of segments) {
              if (seg.type === 'reasoning') {
                res.write(buildOpenAIChunk(completionId, requestedModel, { reasoning_content: seg.text }, null, null));
              } else if (seg.text) {
                res.write(buildOpenAIChunk(completionId, requestedModel, { content: seg.text }, null, null));
              }
            }
          } else if (event.event === 'usage') {
            try {
              const u = JSON.parse(event.data);
              usageData = {
                prompt_tokens: u.promptTokens || 0,
                completion_tokens: u.completionTokens || 0,
                total_tokens: u.totalTokens || 0
              };
            } catch {}
          } else if (event.event === 'finish') {
            const remaining = thinkParser.flush();
            for (const seg of remaining) {
              if (seg.type === 'reasoning') {
                res.write(buildOpenAIChunk(completionId, requestedModel, { reasoning_content: seg.text }, null, null));
              } else if (seg.text) {
                res.write(buildOpenAIChunk(completionId, requestedModel, { content: seg.text }, null, null));
              }
            }
          }
        }
      } catch (streamErr) {
        console.error('[Stream Error]', streamErr.message);
      }

      res.write(buildOpenAIChunk(completionId, requestedModel, {}, 'stop', usageData));
      res.write('data: [DONE]\n\n');
      res.end();

    } else {
      // ═══ NON-STREAMING ═══
      const thinkParser = new ThinkingParser(thinkingActive);
      const contentParts = [];
      const reasoningParts = [];
      let usageData = null;

      for await (const event of parseMimoSSE(mimoResponse)) {
        if (event.event === 'message') {
          let parsed;
          try { parsed = JSON.parse(event.data); } catch { continue; }
          if (parsed.type !== 'text' || parsed.content === undefined) continue;

          const segments = thinkParser.process(parsed.content);
          for (const seg of segments) {
            if (seg.type === 'reasoning') reasoningParts.push(seg.text);
            else if (seg.text) contentParts.push(seg.text);
          }
        } else if (event.event === 'usage') {
          try {
            const u = JSON.parse(event.data);
            usageData = {
              prompt_tokens: u.promptTokens || 0,
              completion_tokens: u.completionTokens || 0,
              total_tokens: u.totalTokens || 0
            };
          } catch {}
        } else if (event.event === 'finish') {
          const remaining = thinkParser.flush();
          for (const seg of remaining) {
            if (seg.type === 'reasoning') reasoningParts.push(seg.text);
            else if (seg.text) contentParts.push(seg.text);
          }
        }
      }

      const result = buildOpenAIResponse(
        completionId, requestedModel,
        contentParts.join(''),
        reasoningParts.join('') || undefined,
        usageData
      );

      // Include conversation key in response for client tracking
      result['x_conversation_id'] = convKey;
      res.json(result);
    }

  } catch (err) {
    console.error('[/v1/chat/completions Error]', err);
    res.status(502).json({
      error: {
        message: `Upstream error: ${err.message}`,
        type: 'upstream_error'
      }
    });
  }
});

// ── Serve admin panel for all other routes ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════

initDB();

// Periodic cleanup every hour
setInterval(() => {
  try { cleanupOldConversations(); } catch (e) { console.error('[Cleanup Error]', e.message); }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       MiMo2API Reverse Proxy         ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  Admin Panel : http://localhost:${PORT}   ║`);
  console.log(`  ║  API Base    : http://localhost:${PORT}/v1 ║`);
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  Conv timeout: ${CONV_TIMEOUT} min             ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
