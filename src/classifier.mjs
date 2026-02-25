/**
 * Message Classifier — GLM-4-flash 汎用メッセージ意図分類
 *
 * チャンネル固有の自動行動トリガーに使う汎用分類器。
 * 例: #自己紹介 → intent="self_introduction" → 自動返信
 *     #質問     → intent="question"           → 自動回答
 *
 * GLM-4-flashで安価に分類（sanitizerと同じパターン）。
 */

const ZAI_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const CLASSIFY_MODEL = 'glm-4-flash';

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
 * @returns {Promise<{ intent: string, confidence: number }>}
 */
export async function classifyMessage(content, context = {}) {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey || !content || content.length < 5) {
    return { intent: 'other', confidence: 0 };
  }

  try {
    const res = await fetch(ZAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        messages: [
          {
            role: 'system',
            content: `あなたはDiscordメッセージの意図分類器です。
メッセージの意図を以下のカテゴリから1つ選んでください。

カテゴリ:
- self_introduction: 自己紹介（名前・経歴・興味分野などを含む自己紹介文）
- question: 質問（技術質問、相談、「〜できますか？」「〜とは？」など）
- discussion: 議論・意見（技術トーク、感想、考察、体験共有）
- announcement: 告知・共有（イベント告知、リリース報告、記事共有）
- greeting: 挨拶（おはよう、こんにちは、おやすみ等）
- reaction: リアクション・相槌（「いいね」「なるほど」「www」等の短い反応）
- other: 上記に該当しない

チャンネル: #${context.channelName || '不明'}

JSON形式で回答: {"intent":"カテゴリ名","confidence":0.0〜1.0}
回答はJSONのみ。`,
          },
          {
            role: 'user',
            content: content.substring(0, 500),
          },
        ],
        max_tokens: 50,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.warn('[Classifier] API error:', res.status);
      return { intent: 'other', confidence: 0 };
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';

    try {
      const result = JSON.parse(text);
      const intent = VALID_INTENTS.includes(result.intent) ? result.intent : 'other';
      const confidence = typeof result.confidence === 'number'
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.5;

      console.log(`[Classifier] #${context.channelName || '?'}: "${content.substring(0, 40)}..." → ${intent} (${confidence})`);
      return { intent, confidence };
    } catch {
      console.warn('[Classifier] JSON parse failed:', text);
      return { intent: 'other', confidence: 0 };
    }
  } catch (err) {
    console.warn('[Classifier] Error:', err.message);
    return { intent: 'other', confidence: 0 };
  }
}
