/**
 * Embedding Pipeline — OpenAI text-embedding-3-small
 *
 * メッセージをベクトル化してMariaDBに保存。
 * バッチ処理で効率化（N件溜まったらまとめて処理）。
 */
import * as db from './db.mjs';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_URL = 'https://api.openai.com/v1/embeddings';

// バッチキュー
const queue = [];
const BATCH_SIZE = 5;
const FLUSH_INTERVAL_MS = 60_000; // 1分ごとにフラッシュ

/**
 * メッセージをキューに追加
 */
export function enqueueMessage(messageDbId, userId, channelId, content) {
  if (!OPENAI_API_KEY) return;
  if (!content || content.length < 20) return; // 短すぎるメッセージはスキップ

  queue.push({ messageDbId, userId, channelId, content: content.substring(0, 500) });

  if (queue.length >= BATCH_SIZE) {
    flushQueue().catch(err => console.warn('[Embedding] Flush error:', err.message));
  }
}

/**
 * キューをフラッシュ（ベクトル化して保存）
 */
async function flushQueue() {
  if (queue.length === 0) return;

  const batch = queue.splice(0, BATCH_SIZE);
  const texts = batch.map(m => m.content);

  try {
    const embeddings = await getEmbeddings(texts);

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const embedding = embeddings[i];
      if (embedding) {
        await db.saveMessageVector(
          item.messageDbId,
          item.userId,
          item.channelId,
          item.content,
          embedding
        );
      }
    }

    console.log(`[Embedding] Vectorized ${batch.length} messages`);
  } catch (err) {
    console.warn('[Embedding] Batch failed:', err.message);
    // 失敗したバッチはキューに戻さない（ログで十分）
  }
}

/**
 * OpenAI Embedding API呼び出し
 */
async function getEmbeddings(texts) {
  const res = await fetch(EMBEDDING_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status}`);
  }

  const data = await res.json();
  return data.data.map(d => d.embedding);
}

/**
 * クエリテキストから類似メッセージを検索
 */
export async function searchSimilar(queryText, limit = 5) {
  if (!OPENAI_API_KEY) return [];

  try {
    const embeddings = await getEmbeddings([queryText]);
    if (!embeddings[0]) return [];

    return await db.searchSimilarMessages(embeddings[0], limit);
  } catch (err) {
    console.warn('[Embedding] Search failed:', err.message);
    return [];
  }
}

/**
 * 定期フラッシュタイマー開始
 */
export function startFlushTimer() {
  setInterval(() => {
    flushQueue().catch(err => console.warn('[Embedding] Timer flush error:', err.message));
  }, FLUSH_INTERVAL_MS);
  console.log('[Embedding] Flush timer started (60s interval)');
}
