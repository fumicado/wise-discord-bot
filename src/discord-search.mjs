/**
 * Discord Search — サーバー内メッセージ検索
 *
 * 蓄積した全メッセージをベクトル類似検索し、
 * Discordメッセージリンク付きで結果を返す。
 *
 * コマンド:
 *   @WISE 検索 <キーワード>   → ベクトル検索 + メッセージリンク
 *   @WISE search <keyword>     → 同上（英語）
 */

import * as db from './db.mjs';
import { searchSimilar } from './embedding.mjs';

/**
 * ベクトル類似検索でメッセージを検索
 * FULLTEXT検索はフォールバック用。
 */
export async function searchMessages(query, limit = 8) {
  // 1. ベクトル検索（メイン）
  const vectorResults = await searchSimilar(query, limit);

  if (vectorResults && vectorResults.length > 0) {
    return vectorResults.map(r => ({
      content: r.content_summary || '',
      display_name: r.display_name || '不明',
      channel_id: r.channel_id,
      channel_name: r.channel_name || '',
      discord_message_id: r.discord_message_id,
      guild_id: r.guild_id,
      created_at: r.created_at,
      distance: r.distance,
    }));
  }

  // 2. FULLTEXT検索（フォールバック: ベクトル未蓄積時）
  const ftResults = await db.searchMessages(query, limit);
  return ftResults.map(r => ({
    content: r.content || '',
    display_name: r.display_name || '不明',
    channel_id: r.channel_id || '',
    channel_name: r.channel_name || '',
    discord_message_id: r.discord_message_id || '',
    guild_id: r.guild_id || '',
    created_at: r.created_at,
    distance: null,
  }));
}

/**
 * Discordメッセージリンクを生成
 * 形式: https://discord.com/channels/{guildId}/{channelId}/{messageId}
 */
function messageLink(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return '';
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/**
 * 検索結果をDiscord向けにフォーマット（メッセージリンク付き）
 */
export function formatSearchResults(results, query) {
  if (!results || results.length === 0) {
    return `「${query}」に関する発言は見つかりませんでした 🔍\n` +
      `※ ベクトル検索はメッセージが蓄積されてから有効になります。`;
  }

  let text = `🔍 **「${query}」に関連する発言** (${results.length}件)\n\n`;

  for (const r of results.slice(0, 6)) {
    const date = new Date(r.created_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const name = r.display_name;
    const content = r.content.substring(0, 150);
    const channel = r.channel_name ? `#${r.channel_name}` : '';
    const link = messageLink(r.guild_id, r.channel_id, r.discord_message_id);
    const similarity = r.distance != null ? ` (類似度: ${(1 - r.distance).toFixed(2)})` : '';

    text += `**${name}** ${channel} — ${date}${similarity}\n`;
    text += `> ${content}${r.content.length > 150 ? '...' : ''}\n`;
    if (link) {
      text += `> [📎 メッセージへ](${link})\n`;
    }
    text += `\n`;
  }

  if (results.length > 6) {
    text += `*...他 ${results.length - 6} 件の関連発言*`;
  }

  return text;
}
