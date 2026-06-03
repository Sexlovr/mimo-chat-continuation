import express from 'express';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { initDB, getDB, cleanupOldConversations } from './lib/database.js';
import { parseCurl } from './lib/curlParser.js';
import { fetchMimoStream, parseMimoSSE } from './lib/mimoClient.js';
import {
  parseDirectives,
  buildNewConversationQuery,
  buildContinuationQuery,
  generateConvKey,
  hashApiKey,
  buildOpenAIChunk,
  buildOpenAIResponse,
  generateId,
  generateConversationId,
  cleanThinkTags
} from './lib/translator.js';
import { buildAdminPage } from './lib/page.js';

config();

var app = express();
app.use(express.json({ limit: '10mb' }));

var PORT = process.env.PORT || 3000;
var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
var JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
var CONV_TIMEOUT = parseInt(process.env.CONV_TIMEOUT_MINUTES) || 60;

var rrIndex = 0;

function getNextAccount() {
  var db = getDB();
  var accounts = db.prepare('SELECT * FROM accounts WHERE active = 1').all();
  if (accounts.length === 0) return null;
  rrIndex = rrIndex % accounts.length;
  var account = accounts[rrIndex];
  rrIndex++;
  return account;
}

function bumpAccountUsage(accountId) {
  getDB().prepare("UPDATE accounts SET request_count = request_count + 1, last_used = datetime('now') WHERE id = ?").run(accountId);
}

// ══════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════

function adminAuth(req, res, next) {
  var authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    var decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error();
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function apiKeyAuth(req, res, next) {
  var authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: { message: 'Missing API key', type: 'auth_error' } });
  }
  var key = authHeader.split(' ')[1];
  var db = getDB();
  var row = db.prepare('SELECT * FROM api_keys WHERE key = ? AND active = 1').get(key);
  if (!row) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
  }
  db.prepare('UPDATE api_keys SET request_count = request_count + 1 WHERE id = ?').run(row.id);
  req.apiKey = key;
  req.apiKeyHash = hashApiKey(key);
  next();
}

// ══════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════

app.post('/admin/login', function (req, res) {
  var password = req.body.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  var token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token: token });
});

// ── Accounts ──
app.get('/admin/accounts', adminAuth, function (req, res) {
  var rows = getDB().prepare('SELECT id, label, user_id, active, request_count, last_used, created_at FROM accounts').all();
  res.json(rows);
});

app.post('/admin/accounts', adminAuth, function (req, res) {
  var curl = req.body.curl;
  var label = req.body.label;
  if (!curl) return res.status(400).json({ error: 'cURL string required' });

  var parsed = parseCurl(curl);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  var existing = getDB().prepare('SELECT id FROM accounts WHERE user_id = ?').get(parsed.userId);
  if (existing) {
    getDB().prepare('UPDATE accounts SET service_token = ?, ph_token = ?, label = ?, active = 1 WHERE id = ?')
      .run(parsed.serviceToken, parsed.phToken, label || '', existing.id);
    return res.json({ message: 'Account updated', id: existing.id });
  }

  var result = getDB().prepare('INSERT INTO accounts (label, service_token, user_id, ph_token) VALUES (?, ?, ?, ?)')
    .run(label || '', parsed.serviceToken, parsed.userId, parsed.phToken);
  res.json({ message: 'Account added', id: result.lastInsertRowid });
});

app.delete('/admin/accounts/:id', adminAuth, function (req, res) {
  getDB().prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  getDB().prepare('DELETE FROM conversations WHERE account_id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

app.patch('/admin/accounts/:id', adminAuth, function (req, res) {
  if (req.body.active !== undefined) {
    getDB().prepare('UPDATE accounts SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  }
  if (req.body.label !== undefined) {
    getDB().prepare('UPDATE accounts SET label = ? WHERE id = ?').run(req.body.label, req.params.id);
  }
  res.json({ message: 'Updated' });
});

// ── Test Account Credentials ──
app.post('/admin/accounts/:id/test', adminAuth, async function (req, res) {
  var account = getDB().prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    var testResponse = await fetchMimoStream(account, 'hi', {
      enableThinking: false,
      webSearchStatus: 'disabled',
      model: 'mimo-v2.5-pro'
    }, generateConversationId());

    // Read just enough to confirm it's streaming
    var reader = testResponse.body.getReader();
    var { value } = await reader.read();
    reader.releaseLock();

    var snippet = new TextDecoder().decode(value).slice(0, 200);
    res.json({ success: true, message: 'Account is valid', snippet: snippet });
  } catch (err) {
    var is401 = err.message.includes('401');
    res.json({
      success: false,
      message: err.message.slice(0, 300),
      hint: is401 ? 'serviceToken is expired or invalid — re-import a fresh cURL from the browser' : 'Unknown error'
    });
  }
});

// ── API Keys ──
app.get('/admin/keys', adminAuth, function (req, res) {
  var rows = getDB().prepare('SELECT * FROM api_keys').all();
  res.json(rows);
});

app.post('/admin/keys', adminAuth, function (req, res) {
  var name = req.body.name;
  var key = 'sk-mimo-' + crypto.randomBytes(24).toString('hex');
  var result = getDB().prepare('INSERT INTO api_keys (name, key) VALUES (?, ?)').run(name || '', key);
  res.json({ message: 'Key created', id: result.lastInsertRowid, key: key });
});

app.delete('/admin/keys/:id', adminAuth, function (req, res) {
  getDB().prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

app.patch('/admin/keys/:id', adminAuth, function (req, res) {
  if (req.body.active !== undefined) {
    getDB().prepare('UPDATE api_keys SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  }
  res.json({ message: 'Updated' });
});

// ── Models ──
app.get('/admin/models', adminAuth, function (req, res) {
  var rows = getDB().prepare('SELECT * FROM models').all();
  res.json(rows);
});

app.post('/admin/models', adminAuth, function (req, res) {
  var model_id = req.body.model_id;
  var display_name = req.body.display_name;
  if (!model_id) return res.status(400).json({ error: 'model_id required' });
  try {
    var result = getDB().prepare('INSERT INTO models (model_id, display_name) VALUES (?, ?)')
      .run(model_id, display_name || model_id);
    res.json({ message: 'Model added', id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Model already exists' });
    throw e;
  }
});

app.delete('/admin/models/:id', adminAuth, function (req, res) {
  getDB().prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

app.patch('/admin/models/:id', adminAuth, function (req, res) {
  if (req.body.active !== undefined) {
    getDB().prepare('UPDATE models SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  }
  res.json({ message: 'Updated' });
});

// ── Conversations ──
app.get('/admin/conversations', adminAuth, function (req, res) {
  var rows = getDB().prepare(
    'SELECT c.id, c.conv_key, c.mimo_conversation_id, c.account_id, c.message_count, ' +
    'c.model, c.last_used, c.created_at, a.label as account_label, a.user_id ' +
    'FROM conversations c ' +
    'LEFT JOIN accounts a ON c.account_id = a.id ' +
    'ORDER BY c.last_used DESC LIMIT 100'
  ).all();
  res.json(rows);
});

app.delete('/admin/conversations', adminAuth, function (req, res) {
  var result = getDB().prepare('DELETE FROM conversations').run();
  res.json({ message: 'Cleared ' + result.changes + ' conversations' });
});

// ══════════════════════════════════════════
//  OPENAI-COMPATIBLE ROUTES
// ══════════════════════════════════════════

app.get('/v1/models', apiKeyAuth, function (req, res) {
  var rows = getDB().prepare('SELECT * FROM models WHERE active = 1').all();
  res.json({
    object: 'list',
    data: rows.map(function (r) {
      return {
        id: r.model_id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'xiaomi'
      };
    })
  });
});

app.post('/v1/chat/completions', apiKeyAuth, async function (req, res) {
  var db = getDB();

  try {
    var messages = req.body.messages;
    var model = req.body.model;
    var stream = req.body.stream;
    var temperature = req.body.temperature;
    var top_p = req.body.top_p;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages array required', type: 'invalid_request' } });
    }

    var hasUser = messages.some(function (m) { return m.role === 'user'; });
    if (!hasUser) {
      return res.status(400).json({ error: { message: 'At least one user message required', type: 'invalid_request' } });
    }

    var requestedModel = model || 'mimo-v2.5-pro';
    var completionId = generateId();

    // ── Parse directives ──
    var directives = parseDirectives(messages);
    var enableThinking = directives.enableThinking;
    var webSearch = directives.webSearch;
    var resend = directives.resend;
    var cleanedMessages = directives.cleanedMessages;

    // ── Conversation tracking ──
    var headerConvId = req.headers['x-conversation-id'] || null;
    var convKey = generateConvKey(cleanedMessages, headerConvId);
    var apiKeyHash = req.apiKeyHash;

    // Look up existing conversation within timeout window
    var timeoutModifier = '-' + CONV_TIMEOUT + ' minutes';
    var conv = db.prepare(
      "SELECT * FROM conversations WHERE conv_key = ? AND api_key_hash = ? AND last_used > datetime('now', ?)"
    ).get(convKey, apiKeyHash, timeoutModifier);

    var query, mimoConversationId, account;
    var isContinuation = false;

    if (conv && messages.length > conv.message_count) {
      // ═══ CONTINUATION ═══
      account = db.prepare('SELECT * FROM accounts WHERE id = ? AND active = 1').get(conv.account_id);

      if (account) {
        isContinuation = true;
        mimoConversationId = conv.mimo_conversation_id;
        query = buildContinuationQuery(cleanedMessages, resend);

        db.prepare('UPDATE conversations SET message_count = ?, last_used = datetime("now"), model = ? WHERE id = ?')
          .run(messages.length, requestedModel, conv.id);

        console.log('[Conv] Continuation: ' + convKey.slice(0, 12) + '... | msgs: ' + conv.message_count + ' -> ' + messages.length + ' | account: ' + account.user_id);
      } else {
        db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
        conv = null;
      }
    }

    if (!conv || !isContinuation) {
      // ═══ NEW CONVERSATION ═══
      db.prepare('DELETE FROM conversations WHERE conv_key = ? AND api_key_hash = ?').run(convKey, apiKeyHash);

      account = getNextAccount();
      if (!account) {
        return res.status(503).json({ error: { message: 'No active accounts available', type: 'server_error' } });
      }

      mimoConversationId = generateConversationId();
      query = buildNewConversationQuery(cleanedMessages);

      db.prepare(
        'INSERT INTO conversations (conv_key, api_key_hash, mimo_conversation_id, account_id, message_count, model) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(convKey, apiKeyHash, mimoConversationId, account.id, messages.length, requestedModel);

      console.log('[Conv] New: ' + convKey.slice(0, 12) + '... | msgs: ' + messages.length + ' | account: ' + account.user_id);
    }

    bumpAccountUsage(account.id);

    // ── Build MiMo model config ──
    var modelConfig = {
      enableThinking: enableThinking === true,
      webSearchStatus: webSearch ? 'enabled' : 'disabled',
      model: requestedModel,
      temperature: temperature != null ? temperature : 0.8,
      topP: top_p != null ? top_p : 0.95
    };

    // ── Fetch from MiMo ──
    var mimoResponse;
    try {
      mimoResponse = await fetchMimoStream(account, query, modelConfig, mimoConversationId);
    } catch (fetchErr) {
      // ── Auto-disable on 401, try next account ──
      if (fetchErr.message.includes('401')) {
        console.error('[AUTH] Account ' + account.user_id + ' returned 401 — disabling');
        db.prepare('UPDATE accounts SET active = 0 WHERE id = ?').run(account.id);

        // Try one more account if available
        var fallback = getNextAccount();
        if (fallback && fallback.id !== account.id) {
          console.log('[AUTH] Retrying with fallback account: ' + fallback.user_id);
          mimoResponse = await fetchMimoStream(fallback, query, modelConfig, mimoConversationId);
          bumpAccountUsage(fallback.id);
        } else {
          throw new Error('All accounts failed authentication. Please re-import fresh cURL credentials in the admin panel.');
        }
      } else {
        throw fetchErr;
      }
    }

    var thinkingActive = enableThinking === true;

    // ═══════════════════════════════════════════════════════
    //  SIMPLE APPROACH: Collect ALL text → clean → return
    //  No broken state-machine parser. Just buffer + regex.
    // ═══════════════════════════════════════════════════════
    var allTextChunks = [];
    var usageData = null;

    try {
      for await (var event of parseMimoSSE(mimoResponse)) {
        if (event.event === 'message') {
          var parsed;
          try { parsed = JSON.parse(event.data); } catch (e) { continue; }
          if (parsed.type !== 'text' || parsed.content === undefined) continue;
          allTextChunks.push(parsed.content);
        } else if (event.event === 'usage') {
          try {
            var u = JSON.parse(event.data);
            usageData = {
              prompt_tokens: u.promptTokens || 0,
              completion_tokens: u.completionTokens || 0,
              total_tokens: u.totalTokens || 0
            };
          } catch (e) { }
        }
      }
    } catch (streamErr) {
      console.error('[Stream Error]', streamErr.message);
    }

    // ── Join all chunks into one raw string ──
    var rawText = allTextChunks.join('').replace(/\u0000/g, '');

    // ── Extract thinking and content ──
    var reasoning = '';
    var content = '';

    var thinkMatch = rawText.match(/<think>([\s\S]*?)<\/think>([\s\S]*)/i);
    if (thinkMatch) {
      reasoning = thinkMatch[1].trim();
      content = thinkMatch[2].trim();
    } else {
      // No think tags at all, or malformed — clean any stray tags
      content = cleanThinkTags(rawText);
    }

    if (process.env.DEBUG === '1') {
      console.log('[DEBUG] Raw text length:', rawText.length);
      console.log('[DEBUG] Reasoning length:', reasoning.length);
      console.log('[DEBUG] Content length:', content.length);
      console.log('[DEBUG] Content preview:', content.slice(0, 150));
    }

    if (stream) {
      // ═══ STREAMING ═══
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Conversation-Id', convKey);

      // Send role chunk
      res.write(buildOpenAIChunk(completionId, requestedModel, { role: 'assistant', content: '' }, null, null));

      // Send reasoning if thinking is enabled
      if (thinkingActive && reasoning) {
        res.write(buildOpenAIChunk(completionId, requestedModel, { reasoning_content: reasoning }, null, null));
      }

      // Send content in small chunks to simulate streaming
      var CHUNK_SIZE = 20;
      for (var ci = 0; ci < content.length; ci += CHUNK_SIZE) {
        var slice = content.slice(ci, ci + CHUNK_SIZE);
        res.write(buildOpenAIChunk(completionId, requestedModel, { content: slice }, null, null));
      }

      // Send stop
      res.write(buildOpenAIChunk(completionId, requestedModel, {}, 'stop', usageData));
      res.write('data: [DONE]\n\n');
      res.end();

    } else {
      // ═══ NON-STREAMING ═══
      var result = buildOpenAIResponse(
        completionId, requestedModel,
        content,
        thinkingActive && reasoning ? reasoning : undefined,
        usageData
      );

      result['x_conversation_id'] = convKey;
      res.json(result);
    }

  } catch (err) {
    console.error('[/v1/chat/completions Error]', err);
    res.status(502).json({
      error: {
        message: 'Upstream error: ' + err.message,
        type: 'upstream_error'
      }
    });
  }
});

// ── Server-rendered admin page ──
app.get('/', function (req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildAdminPage());
});

// ══════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════

initDB();

setInterval(function () {
  try { cleanupOldConversations(); } catch (e) { console.error('[Cleanup Error]', e.message); }
}, 60 * 60 * 1000);

app.listen(PORT, function () {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       MiMo2API Reverse Proxy         ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log('  ║  Admin Panel : http://localhost:' + PORT + '   ║');
  console.log('  ║  API Base    : http://localhost:' + PORT + '/v1 ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log('  ║  Conv timeout: ' + CONV_TIMEOUT + ' min             ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
