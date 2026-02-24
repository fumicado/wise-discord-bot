/**
 * MariaDB Connection Pool — discord database
 */
import mysql from 'mysql2/promise';

let pool = null;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      database: process.env.DB_NAME || 'discord',
      user: process.env.DB_USER || 'ccagent',
      password: process.env.DB_PASS || '',
      waitForConnections: true,
      connectionLimit: 10,
      charset: 'utf8mb4',
    });
    console.log('[DB] MariaDB pool created (discord)');
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[DB] MariaDB pool closed');
  }
}

// ============================================================
// ユーザー操作
// ============================================================

/** ユーザーをupsert（存在しなければ作成、存在すれば更新） */
export async function upsertUser(discordUser) {
  const p = getPool();
  await p.execute(
    `INSERT INTO users (id, username, display_name, avatar_url, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       username = VALUES(username),
       display_name = VALUES(display_name),
       avatar_url = VALUES(avatar_url),
       last_seen_at = NOW()`,
    [
      discordUser.id,
      discordUser.username,
      discordUser.displayName || discordUser.globalName || discordUser.username,
      discordUser.displayAvatarURL?.() || null,
    ]
  );
}

/** メッセージカウントをインクリメント */
export async function incrementMessageCount(userId) {
  const p = getPool();
  await p.execute(
    `UPDATE users SET message_count = message_count + 1, last_seen_at = NOW() WHERE id = ?`,
    [userId]
  );
}

/** ユーザー情報を取得 */
export async function getUser(userId) {
  const p = getPool();
  const [rows] = await p.execute('SELECT * FROM users WHERE id = ?', [userId]);
  return rows[0] || null;
}

/** ユーザーの自己紹介を保存 */
export async function saveUserIntro(userId, intro) {
  const p = getPool();
  await p.execute('UPDATE users SET intro = ? WHERE id = ?', [intro, userId]);
}

/** 性格スコアを更新 */
export async function updatePersonalityScores(userId, scores, summary) {
  const p = getPool();
  await p.execute(
    'UPDATE users SET personality_scores = ?, personality_summary = ? WHERE id = ?',
    [JSON.stringify(scores), summary, userId]
  );
}

// ============================================================
// メッセージ操作
// ============================================================

/** メッセージを保存 */
export async function saveMessage(msg) {
  const p = getPool();
  await p.execute(
    `INSERT IGNORE INTO messages
       (discord_message_id, guild_id, channel_id, channel_name, user_id,
        content, attachments, embeds, is_bot, reply_to, thread_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      msg.id,
      msg.guildId || '',
      msg.channelId,
      msg.channel?.name || '',
      msg.author.id,
      msg.content || '',
      msg.attachments?.size > 0 ? JSON.stringify([...msg.attachments.values()].map(a => ({
        name: a.name, url: a.url, contentType: a.contentType, size: a.size,
      }))) : null,
      msg.embeds?.length > 0 ? JSON.stringify(msg.embeds.map(e => ({
        title: e.title, description: e.description?.substring(0, 500), url: e.url,
      }))) : null,
      msg.author.bot ? 1 : 0,
      msg.reference?.messageId || null,
      msg.channel?.isThread?.() ? msg.channelId : null,
    ]
  );
}

/** ユーザーの最近のメッセージを取得 */
export async function getRecentMessages(userId, limit = 20) {
  const p = getPool();
  const [rows] = await p.execute(
    `SELECT content, channel_name, created_at FROM messages
     WHERE user_id = ? AND is_bot = 0
     ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]
  );
  return rows;
}

/** チャンネルの最近のメッセージを取得 */
export async function getChannelHistory(channelId, limit = 30) {
  const p = getPool();
  const [rows] = await p.execute(
    `SELECT m.content, m.user_id, u.display_name, m.created_at
     FROM messages m LEFT JOIN users u ON m.user_id = u.id
     WHERE m.channel_id = ? AND m.is_bot = 0
     ORDER BY m.created_at DESC LIMIT ?`,
    [channelId, limit]
  );
  return rows.reverse(); // 古い順に
}

/** FULLTEXT検索（メッセージリンク用にdiscord_message_id, guild_id含む） */
export async function searchMessages(query, limit = 10) {
  const p = getPool();
  const [rows] = await p.execute(
    `SELECT m.content, m.channel_name, m.channel_id, m.created_at,
            m.discord_message_id, m.guild_id, u.display_name
     FROM messages m LEFT JOIN users u ON m.user_id = u.id
     WHERE MATCH(m.content) AGAINST(? IN NATURAL LANGUAGE MODE)
     ORDER BY m.created_at DESC LIMIT ?`,
    [query, limit]
  );
  return rows;
}

// ============================================================
// セッション操作
// ============================================================

/** セッションをupsert */
export async function upsertSession(userId, channelId, sessionId) {
  const p = getPool();
  await p.execute(
    `INSERT INTO sessions (user_id, channel_id, session_id, message_count, created_at, updated_at)
     VALUES (?, ?, ?, 1, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       session_id = VALUES(session_id),
       message_count = message_count + 1,
       updated_at = NOW()`,
    [userId, channelId, sessionId]
  );
}

/** セッション取得 */
export async function getSession(userId, channelId) {
  const p = getPool();
  const [rows] = await p.execute(
    'SELECT * FROM sessions WHERE user_id = ? AND channel_id = ?',
    [userId, channelId]
  );
  return rows[0] || null;
}

/** セッションリセット（要約を保存） */
export async function resetSession(userId, channelId, summary = null) {
  const p = getPool();
  await p.execute(
    `UPDATE sessions SET session_id = NULL, summary = ?, updated_at = NOW()
     WHERE user_id = ? AND channel_id = ?`,
    [summary, userId, channelId]
  );
}

// ============================================================
// 性格分析ログ
// ============================================================

/** 性格観察を記録 */
export async function addPersonalityLog(userId, observation, big5Delta, enneagramDelta, sourceMessageId) {
  const p = getPool();
  await p.execute(
    `INSERT INTO personality_log (user_id, observation, big5_delta, enneagram_delta, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [userId, observation, JSON.stringify(big5Delta), JSON.stringify(enneagramDelta), sourceMessageId]
  );
}

/** ユーザーの性格ログを取得 */
export async function getPersonalityLogs(userId, limit = 50) {
  const p = getPool();
  const [rows] = await p.execute(
    'SELECT * FROM personality_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit]
  );
  return rows;
}

// ============================================================
// ベクトル操作
// ============================================================

/** ベクトルを保存 */
export async function saveMessageVector(messageId, userId, channelId, summary, embedding) {
  const p = getPool();
  const embeddingStr = '[' + embedding.join(',') + ']';
  await p.execute(
    `INSERT INTO message_vectors (message_id, user_id, channel_id, content_summary, embedding, created_at)
     VALUES (?, ?, ?, ?, VEC_FromText(?), NOW())`,
    [messageId, userId, channelId, summary, embeddingStr]
  );
}

/** ベクトル類似検索（メッセージリンク用にdiscord_message_id, guild_id含む） */
export async function searchSimilarMessages(embedding, limit = 5) {
  const p = getPool();
  const embeddingStr = '[' + embedding.join(',') + ']';
  const [rows] = await p.execute(
    `SELECT mv.content_summary, mv.channel_id, mv.created_at, u.display_name,
            m.discord_message_id, m.guild_id, m.channel_name,
            VEC_DISTANCE_COSINE(mv.embedding, VEC_FromText(?)) AS distance
     FROM message_vectors mv
     LEFT JOIN users u ON mv.user_id = u.id
     LEFT JOIN messages m ON mv.message_id = m.id
     ORDER BY distance ASC
     LIMIT ?`,
    [embeddingStr, limit]
  );
  return rows;
}
