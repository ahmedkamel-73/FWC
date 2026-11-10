-- FWC CLEAN v1 - schema.sql (reference, initDB in src/db.js creates these)
CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, balance REAL DEFAULT 0, wallet TEXT, referral_code TEXT, referral_by INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS mining_log (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER, amount REAL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER, amount REAL, fee REAL, net_amount REAL, wallet TEXT, status TEXT DEFAULT 'pending', created_at INTEGER);
CREATE TABLE IF NOT EXISTS config_overrides (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS daily_tasks (id TEXT PRIMARY KEY, title TEXT, title_ar TEXT, type TEXT, reward REAL, channel TEXT, url TEXT, max_per_day INTEGER DEFAULT 1, once INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS user_daily_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER, task_id TEXT, date TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS daily_checkins (telegram_id INTEGER, date TEXT, streak INTEGER, created_at INTEGER, PRIMARY KEY (telegram_id, date));
CREATE TABLE IF NOT EXISTS founder_owners (telegram_id INTEGER PRIMARY KEY, tx_hash TEXT UNIQUE, burned_amount REAL, created_at INTEGER);
