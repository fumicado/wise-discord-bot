/**
 * Discord Search — サーバー内メッセージ検索
 *
 * discord.js APIを使ってサーバー内のチャンネルを横断検索。
 * Agent SDKからは呼べないので、bot.mjsのコマンドとして実装。
 *
 * コマンド:
 *   @WISE 検索 <キーワード>          → サーバー内のメッセージを検索
 *   @WISE search <keyword>            → 同上（英語）
 */

import * as db from './db.mjs';

/**
 * DB内のメッセージをFULLTEXT検索
 * （サーバーに流れた全メッセージがDBに記録されている前提）
 */
export async function searchServerMessages(query, limit = 10) {
  const results = await db.searchMessages(query, limit);
  return results;
}

/**
 * 検索結果をDiscord向けにフォーマット
 */
export function formatSearchResults(results, query) {
  if (!results || results.length === 0) {
    return `「${query}」に関する発言は見つかりませんでした 🔍`;
  }

  let text = `🔍 **「${query}」の検索結果** (${results.length}件)\n\n`;

  for (const r of results.slice(0, 8)) {
    const date = new Date(r.created_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const name = r.display_name || '不明';
    const content = (r.content || '').substring(0, 120);
    const channel = r.channel_name ? `#${r.channel_name}` : '';

    text += `> **${name}** ${channel} (${date})\n`;
    text += `> ${content}${r.content?.length > 120 ? '...' : ''}\n\n`;
  }

  if (results.length > 8) {
    text += `*...他 ${results.length - 8} 件*`;
  }

  return text;
}

/**
 * Discord APIでチャンネルからメッセージを直接検索
 * （DB未記録分のフォールバック用）
 */
export async function searchChannelDirect(channel, query, limit = 20) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const matched = messages
      .filter(m => !m.author.bot && m.content.toLowerCase().includes(query.toLowerCase()))
      .first(limit);

    return matched.map(m => ({
      content: m.content,
      display_name: m.member?.displayName || m.author.username,
      channel_name: channel.name,
      created_at: m.createdAt,
    }));
  } catch (err) {
    console.warn('[Search] Channel fetch failed:', err.message);
    return [];
  }
}

/**
 * サーバー全チャンネルを横断検索（Discord API直叩き）
 * ※ DB記録がない初期段階用。DB蓄積後はsearchServerMessagesを優先。
 */
export async function searchAllChannels(guild, query, limit = 10) {
  const results = [];
  const textChannels = guild.channels.cache.filter(
    c => c.isTextBased() && !c.isVoiceBased()
  );

  for (const [, channel] of textChannels) {
    if (results.length >= limit) break;

    try {
      const channelResults = await searchChannelDirect(channel, query, 5);
      results.push(...channelResults);
    } catch {
      // 権限不足等は無視
    }
  }

  return results.slice(0, limit);
}
