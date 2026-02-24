-- ============================================================
-- WISE Discord Bot - MariaDB Database Setup
-- ============================================================
-- Run as root: sudo mariadb < /var/www/wise/workspace/wise-discord-bot/setup-db.sql

CREATE DATABASE IF NOT EXISTS discord
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- ccagentユーザーにdiscord DBへのフル権限を付与
GRANT ALL PRIVILEGES ON discord.* TO 'ccagent'@'localhost';
FLUSH PRIVILEGES;

USE discord;

-- ============================================================
-- Discord ユーザー
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED PRIMARY KEY COMMENT 'Discord snowflake ID',
  username VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  avatar_url TEXT,
  intro TEXT COMMENT '自己紹介テキスト',
  roles JSON COMMENT '現在のロール一覧',
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  message_count INT UNSIGNED DEFAULT 0,
  -- 性格分析
  personality_summary TEXT COMMENT 'Big5+エニアグラム要約',
  personality_scores JSON COMMENT '{"big5":{"O":0,"C":0,...},"enneagram":{"1":0,"2":0,...}}',
  notes TEXT COMMENT 'WISEの観察メモ',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_last_seen (last_seen_at)
) ENGINE=InnoDB;

-- ============================================================
-- 全メッセージログ
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  discord_message_id VARCHAR(32) NOT NULL,
  guild_id VARCHAR(32) NOT NULL,
  channel_id VARCHAR(32) NOT NULL,
  channel_name VARCHAR(255),
  user_id BIGINT UNSIGNED NOT NULL,
  content TEXT NOT NULL,
  attachments JSON COMMENT '添付ファイル情報',
  embeds JSON COMMENT 'embed情報',
  is_bot BOOLEAN DEFAULT FALSE,
  reply_to VARCHAR(32) COMMENT '返信先メッセージID',
  thread_id VARCHAR(32) COMMENT 'スレッドID（フォーラム投稿時）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_discord_msg (discord_message_id),
  INDEX idx_channel (channel_id, created_at),
  INDEX idx_user (user_id, created_at),
  INDEX idx_guild (guild_id, created_at),
  FULLTEXT idx_content (content)
) ENGINE=InnoDB;

-- ============================================================
-- Agent SDK セッション管理
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  channel_id VARCHAR(32) COMMENT 'チャンネルコンテキスト（NULLはDM）',
  session_id TEXT COMMENT 'Agent SDK session ID',
  summary TEXT COMMENT '前回セッション要約',
  message_count INT UNSIGNED DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_channel (user_id, channel_id)
) ENGINE=InnoDB;

-- ============================================================
-- 性格分析ログ
-- ============================================================
CREATE TABLE IF NOT EXISTS personality_log (
  id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  observation TEXT NOT NULL,
  big5_delta JSON COMMENT '{"O":5,"C":-3,"E":0,"A":0,"N":0}',
  enneagram_delta JSON COMMENT '{"1":5,"7":3,...}',
  source_message_id VARCHAR(32),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id, created_at)
) ENGINE=InnoDB;

-- ============================================================
-- ベクトル検索用（会話コンテキスト）
-- ============================================================
CREATE TABLE IF NOT EXISTS message_vectors (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  message_id BIGINT UNSIGNED NOT NULL COMMENT 'messagesテーブルのID',
  user_id BIGINT UNSIGNED NOT NULL,
  channel_id VARCHAR(32) NOT NULL,
  content_summary TEXT COMMENT '要約テキスト',
  embedding VECTOR(1536) COMMENT 'text-embedding-3-small',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_channel (channel_id),
  CONSTRAINT fk_mv_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB;

SELECT 'Discord DB setup complete ✅' AS status;
