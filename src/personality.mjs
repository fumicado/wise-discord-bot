/**
 * Personality Analyzer — ユーザーの性格分析
 *
 * メッセージを蓄積し、定期的にBig Five + エニアグラムのスコアを更新。
 * wise-agentのpersonality-observe.tsパターンをDiscord用に移植。
 */
import * as db from './db.mjs';

const ZAI_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const ZAI_API_KEY = process.env.ZAI_API_KEY;
const ANALYSIS_MODEL = 'glm-4-flash';

// N件メッセージごとに分析（コスト節約）
const ANALYSIS_THRESHOLD = 20;

// ユーザーごとのメッセージカウンター（メモリ内）
const messageCounters = new Map();

/**
 * メッセージを観察し、閾値に達したら性格分析を実行
 */
export async function observeMessage(userId, content, messageId) {
  if (!content || content.length < 10) return; // 短すぎるメッセージは無視

  const count = (messageCounters.get(userId) || 0) + 1;
  messageCounters.set(userId, count);

  if (count % ANALYSIS_THRESHOLD === 0) {
    // 非同期で分析（応答をブロックしない）
    analyzePersonality(userId).catch(err => {
      console.warn('[Personality] Analysis failed:', err.message);
    });
  }
}

/**
 * ユーザーの最近のメッセージから性格分析を実行
 */
async function analyzePersonality(userId) {
  if (!ZAI_API_KEY) return;

  // 最近のメッセージを取得
  const messages = await db.getRecentMessages(userId, 30);
  if (messages.length < 10) return; // データ不足

  const user = await db.getUser(userId);
  if (!user) return;

  const currentScores = user.personality_scores
    ? (typeof user.personality_scores === 'string' ? JSON.parse(user.personality_scores) : user.personality_scores)
    : { big5: { O: 0, C: 0, E: 0, A: 0, N: 0 }, enneagram: {} };

  const messageTexts = messages.map(m =>
    `[${m.channel_name}] ${m.content.substring(0, 200)}`
  ).join('\n');

  try {
    const res = await fetch(ZAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ZAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        messages: [
          {
            role: 'system',
            content: `あなたは心理学の専門家です。ユーザーのDiscordメッセージから性格傾向を分析します。

現在の累積スコア:
Big Five: O(開放性)=${currentScores.big5?.O || 0}, C(誠実性)=${currentScores.big5?.C || 0}, E(外向性)=${currentScores.big5?.E || 0}, A(協調性)=${currentScores.big5?.A || 0}, N(神経症傾向)=${currentScores.big5?.N || 0}

以下のメッセージ群から、性格の傾向を読み取り、スコアの変動量（delta）を提案してください。

JSON形式で回答:
{
  "observation": "観察内容（1-2行）",
  "big5_delta": {"O": 0, "C": 0, "E": 0, "A": 0, "N": 0},
  "enneagram_delta": {"1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 0, "9": 0}
}

ルール:
- delta値は -10 〜 +10 の範囲
- 明確な傾向がない特性は 0
- 観察は客観的に、忖度なく
- JSONのみ回答。説明不要。`
          },
          {
            role: 'user',
            content: `ユーザー「${user.display_name || user.username}」の最近のメッセージ:\n\n${messageTexts}`
          }
        ],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });

    if (!res.ok) return;

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';

    // JSONを抽出（```json ... ``` ラッパー対応）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const result = JSON.parse(jsonMatch[0]);

    // delta適用
    const newScores = {
      big5: {
        O: (currentScores.big5?.O || 0) + (result.big5_delta?.O || 0),
        C: (currentScores.big5?.C || 0) + (result.big5_delta?.C || 0),
        E: (currentScores.big5?.E || 0) + (result.big5_delta?.E || 0),
        A: (currentScores.big5?.A || 0) + (result.big5_delta?.A || 0),
        N: (currentScores.big5?.N || 0) + (result.big5_delta?.N || 0),
      },
      enneagram: { ...(currentScores.enneagram || {}) },
    };

    // エニアグラムdelta適用
    if (result.enneagram_delta) {
      for (const [type, delta] of Object.entries(result.enneagram_delta)) {
        newScores.enneagram[type] = (newScores.enneagram[type] || 0) + (delta || 0);
      }
    }

    // 要約生成
    const summary = generateSummary(newScores);

    // DB更新
    await db.updatePersonalityScores(userId, newScores, summary);
    await db.addPersonalityLog(
      userId,
      result.observation || '',
      result.big5_delta || {},
      result.enneagram_delta || {},
      null
    );

    console.log(`[Personality] Updated ${user.display_name}: ${result.observation}`);
  } catch (err) {
    console.warn('[Personality] Analysis error:', err.message);
  }
}

/**
 * スコアから要約テキストを生成
 */
function generateSummary(scores) {
  const b5 = scores.big5 || {};
  const traits = [];

  if (Math.abs(b5.O || 0) > 10) traits.push(b5.O > 0 ? '開放的' : '保守的');
  if (Math.abs(b5.C || 0) > 10) traits.push(b5.C > 0 ? '計画的' : '柔軟型');
  if (Math.abs(b5.E || 0) > 10) traits.push(b5.E > 0 ? '外向的' : '内向的');
  if (Math.abs(b5.A || 0) > 10) traits.push(b5.A > 0 ? '協調的' : '独立的');
  if (Math.abs(b5.N || 0) > 10) traits.push(b5.N > 0 ? '繊細' : '安定的');

  // エニアグラム上位
  const ennea = scores.enneagram || {};
  const topTypes = Object.entries(ennea)
    .filter(([, v]) => v > 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);

  const enneaNames = {
    1: '改革者', 2: '援助者', 3: '達成者', 4: '個性派',
    5: '観察者', 6: '忠実家', 7: '楽天家', 8: '挑戦者', 9: '調停者',
  };

  let summary = traits.length > 0 ? `傾向: ${traits.join('・')}` : '分析中';
  if (topTypes.length > 0) {
    summary += ` / エニア: ${topTypes.map(([t]) => `${t}(${enneaNames[t] || '?'})`).join(', ')}`;
  }

  return summary;
}

/**
 * ユーザーの性格プロファイルを取得（Agent SDK systemPromptに注入用）
 */
export async function getPersonalityContext(userId) {
  const user = await db.getUser(userId);
  if (!user) return '';

  let ctx = '';
  if (user.display_name) ctx += `名前: ${user.display_name}\n`;
  if (user.intro) ctx += `自己紹介: ${user.intro}\n`;
  if (user.personality_summary) ctx += `性格傾向: ${user.personality_summary}\n`;
  if (user.message_count) ctx += `発言数: ${user.message_count}\n`;
  if (user.notes) ctx += `メモ: ${user.notes}\n`;

  return ctx;
}
