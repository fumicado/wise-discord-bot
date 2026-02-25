/**
 * Message Classifier — glm-4.5-air via Z.AI (Anthropic互換API)
 *
 * チャンネル固有の自動行動トリガーに使う汎用分類器。
 * 例: #自己紹介 → intent="self_introduction" → 自動返信
 *     #質問     → intent="question"           → 自動回答
 */

const ZAI_API_URL = 'https://api.z.ai/api/anthropic/v1/messages';
const CLASSIFY_MODEL = 'glm-4.5-air';

// 有効な意図カテゴリ
const VALID_INTENTS = [
  'self_introduction',  // 自己紹介
  'question',           // 質問・相談
  'discussion',         // 議論・意見・考察
  'announcement',       // 告知・共有
  'greeting',           // 挨拶
  'reaction',           // 相槌・リアクション
  'other',              // その他
];

/**
 * メッセージの意図を分類
 *
 * @param {string} content - メッセージ本文
 * @param {object} [context] - { channelName }
 * @returns {Promise<string>} intent文字列（VALID_INTENTSのいずれか）
 */
export async function classifyMessage(content, context = {}) {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey || !content || content.length < 5) {
    return 'other';
  }

  try {
    const res = await fetch(ZAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        max_tokens: 30,
        system: `あなたはDiscordメッセージの意図分類器です。
メッセージの意図を以下のカテゴリから1つだけ選び、そのカテゴリ名のみを回答してください。

カテゴリ:
- self_introduction: 自己紹介（名前・経歴・興味分野などを含む自己紹介文）
- question: 質問（技術質問、相談、「〜できますか？」「〜とは？」など）
- discussion: 議論・意見（技術トーク、感想、考察、体験共有）
- announcement: 告知・共有（イベント告知、リリース報告、記事共有）
- greeting: 挨拶（おはよう、こんにちは、おやすみ等）
- reaction: リアクション・相槌（「いいね」「なるほど」「www」等の短い反応）
- other: 上記に該当しない

チャンネル: #${context.channelName || '不明'}

カテゴリ名のみ回答。説明不要。`,
        messages: [
          { role: 'user', content: content.substring(0, 500) },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn(`[Classifier] API error: ${res.status} ${errBody.substring(0, 100)}`);
      return 'other';
    }

    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim().toLowerCase();

    // レスポンスからintentを抽出（余計なテキストが混じっても対応）
    const intent = VALID_INTENTS.find(i => text.includes(i)) || 'other';

    console.log(`[Classifier] #${context.channelName || '?'}: "${content.substring(0, 40)}..." → ${intent}`);
    return intent;
  } catch (err) {
    console.warn('[Classifier] Error:', err.message);
    return 'other';
  }
}
