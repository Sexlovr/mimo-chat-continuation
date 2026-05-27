import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let db;

export function initDB() {
  db = new Database(path.join(__dirname, '..', 'mimo2api.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT DEFAULT '',
      service_token TEXT NOT NULL,
      user_id TEXT NOT NULL UNIQUE,
      ph_token TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      request_count INTEGER DEFAULT 0,
      last_used DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      key TEXT NOT NULL UNIQUE,
      active INTEGER DEFAULT 1,
      request_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL UNIQUE,
      display_name TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_key TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      mimo_conversation_id TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      message_count INTEGER DEFAULT 0,
      model TEXT DEFAULT '',
      last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(conv_key, api_key_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_conv_key ON conversations(conv_key, api_key_hash);
    CREATE INDEX IF NOT EXISTS idx_conv_last_used ON conversations(last_used);
  `);

  // Seed default model if none exist
  const count = db.prepare('SELECT COUNT(*) as c FROM models').get();
  if (count.c === 0) {
    db.prepare('INSERT INTO models (model_id, display_name) VALUES (?, ?)').run('mimo-v2.5-pro', 'MiMo v2.5 Pro');
  }

  // Initial cleanup
  cleanupOldConversations();

  return db;
}

export function getDB() {
  return db;
}

export function cleanupOldConversations() {
  const hours = parseInt(process.env.CLEANUP_HOURS) || 24;
  const deleted = db.prepare(`DELETE FROM conversations WHERE last_used < datetime('now', '-${hours} hours')`).run();
  if (deleted.changes > 0) {
    console.log(`[Cleanup] Removed ${deleted.changes} stale conversations`);
  }
}
