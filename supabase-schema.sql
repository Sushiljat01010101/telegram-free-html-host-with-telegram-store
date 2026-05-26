-- =====================================================
-- Supabase Schema for Telegram HTML Hosting Bot
-- Run this SQL in your Supabase SQL Editor
-- =====================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  chat_id BIGINT,
  name TEXT,
  joined_at TIMESTAMPTZ DEFAULT now(),
  stats JSONB DEFAULT '{"fileCount": 0, "referrals": [], "baseLimit": 2}'::jsonb,
  premium BOOLEAN DEFAULT false,
  premium_since TEXT,
  premium_until TEXT,
  premium_slots INT,
  premium_duration INT,
  premium_approved_by TEXT,
  premium_approved_at TEXT,
  notifications BOOLEAN DEFAULT true,
  account_deleted BOOLEAN DEFAULT false,
  deleted_at TEXT
);

-- Daily stats table
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  users JSONB DEFAULT '[]'::jsonb,
  count INT DEFAULT 0
);

-- Bot config table (stores all admin config values)
CREATE TABLE IF NOT EXISTS bot_config (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TEXT,
  updated_by TEXT
);

-- Files table — stores file metadata; actual files live in Telegram storage channel
-- No Supabase Storage bucket needed; storage is unlimited via Telegram.
CREATE TABLE IF NOT EXISTS files (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  telegram_file_id TEXT NOT NULL,
  telegram_message_id BIGINT,
  content_type TEXT,
  file_size BIGINT DEFAULT 0,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, file_name)
);

-- =====================================================
-- Disable Row Level Security (server-side usage)
-- =====================================================
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE daily_stats DISABLE ROW LEVEL SECURITY;
ALTER TABLE bot_config DISABLE ROW LEVEL SECURITY;
ALTER TABLE files DISABLE ROW LEVEL SECURITY;
