/**
 * WISE Discord Bot — メインエントリーポイント
 *
 * 機能:
 * - 全メッセージをMariaDB(discord)に記録
 * - ユーザー自動追跡（upsert）
 * - メンション時にAgent SDK経由でAI応答
 * - 入力サニタイズ（GLM-4-flash）
 * - 出力サニタイズ（内部情報マスク、Discord文字数制限）
 * - 性格分析パイプライン（20メッセージごと）
 * - メッセージベクトル化（OpenAI embedding → MariaDB VECTOR）
 * - ウェルカムメッセージ（執事スタイル）
 * - 自己紹介チャンネル検出・保存
 */
import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import * as db from './db.mjs';
import { generateResponse, resetUserSession } from './agent.mjs';
import { sanitizeInput, sanitizeOutput, getBlockedResponse } from './sanitizer.mjs';
import { observeMessage, getPersonalityContext } from './personality.mjs';
import { enqueueMessage, startFlushTimer } from './embedding.mjs';
import { searchMessages, formatSearchResults } from './discord-search.mjs';
import { getUserLevel, hasPermission, getPermissionDeniedMessage, getPermissionContext } from './permissions.mjs';
import { parseIssueCommand, createIssue, runDevPipeline, formatIssueCreated, formatPRCreated } from './github-dev.mjs';
import { extractActions, executeActions } from './discord-admin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// 自発参加ロジック
// ============================================================
// チャンネルごとの最終自発参加時刻
const lastVolunteerTime = new Map();
// WISEが最近会話に参加したチャンネル（メンション応答含む）
const recentActiveChannels = new Map();

const VOLUNTEER_COOLDOWN = 10 * 60 * 1000;  // 同一チャンネルで10分に1回まで
const ACTIVE_WINDOW = 30 * 60 * 1000;       // 30分以内に会話したチャンネルのみ

// AI・技術キーワード（自発参加のトリガー）
const TECH_KEYWORDS = /(?:claude|gpt|openai|anthropic|agent|llm|embedding|rag|mcp|fine.?tun|プロンプト|ハルシネーション|トークン|ベクトル|推論|学習|モデル)/i;

/**
 * 自発参加すべきか判定
 * 条件: 最近会話に参加した + 技術的な質問っぽい + クールダウン経過
 */
function shouldVolunteerResponse(message) {
  const channelId = message.channelId;
  const now = Date.now();

  // 最近WISEが参加したチャンネルでなければスキップ
  const lastActive = recentActiveChannels.get(channelId);
  if (!lastActive || (now - lastActive) > ACTIVE_WINDOW) return false;

  // クールダウン中はスキップ
  const lastVol = lastVolunteerTime.get(channelId);
  if (lastVol && (now - lastVol) < VOLUNTEER_COOLDOWN) return false;

  const content = message.content;

  // 質問っぽい + 技術キーワード含む
  const isQuestion = content.includes('?') || content.includes('？') ||
    content.match(/(?:どう|なぜ|なんで|どうやって|できる|わかる|教えて|知ってる)/);
  const hasTechKeyword = TECH_KEYWORDS.test(content);

  if (isQuestion && hasTechKeyword) {
    // 確率ゲート: 30%で参加（ウザくならないように）
    if (Math.random() < 0.3) {
      lastVolunteerTime.set(channelId, now);
      return true;
    }
  }

  return false;
}

/**
 * チャンネルをアクティブとしてマーク（WISEが応答した時に呼ぶ）
 */
function markChannelActive(channelId) {
  recentActiveChannels.set(channelId, Date.now());
}

// ============================================================
// .env 読み込み（dotenvで安全にパース）
// ============================================================
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID  = process.env.DISCORD_GUILD_ID;

if (!BOT_TOKEN) {
  console.error('DISCORD_BOT_TOKEN が設定されていません');
  process.exit(1);
}

// ============================================================
// Bot 初期化
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

// ============================================================
// 起動
// ============================================================
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ WISE Discord Bot v2 起動: ${c.user.tag}`);
  console.log(`🏠 Guild: ${GUILD_ID}`);
  console.log(`🤖 Model: ${process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514'}`);
  console.log(`📅 ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);

  // ステータス設定
  c.user.setPresence({
    activities: [{ name: '日本AI開発者互助会', type: ActivityType.Watching }],
    status: 'online',
  });

  // DB接続確認
  try {
    const pool = db.getPool();
    await pool.execute('SELECT 1');
    console.log('✅ MariaDB (discord) 接続OK');
  } catch (err) {
    console.error('MariaDB接続失敗:', err.message);
  }

  // ベクトル化タイマー開始
  startFlushTimer();
});

// ============================================================
// 新メンバー参加 → ウェルカムメッセージ + DB登録
// ============================================================
client.on(Events.GuildMemberAdd, async (member) => {
  console.log(`👋 新メンバー参加: ${member.user.tag}`);

  // DB登録
  try {
    await db.upsertUser(member.user);
  } catch (err) {
    console.warn('[DB] User upsert failed:', err.message);
  }

  // 自己紹介チャンネルを探す
  const introChannel = member.guild.channels.cache.find(
    c => c.name === '自己紹介'
  );

  if (introChannel) {
    const rulesChannel = member.guild.channels.cache.find(c => c.name === 'ルール-ガイドライン');
    await introChannel.send(
      `${member} 様、ようこそお越しくださいました 🎩\n\n` +
      `私、当会の執事を務めております **WISE** と申します。\n` +
      `皆様との交流の第一歩として、簡単な自己紹介をお願いできますでしょうか。\n\n` +
      `・お名前（ニックネームで結構でございます）\n` +
      `・普段のお仕事や活動\n` +
      `・AIで関心のある分野\n\n` +
      (rulesChannel ? `📋 お館のルールは <#${rulesChannel.id}> にございます。\n` : '') +
      `何かございましたら、いつでもお声がけくださいませ。`
    );
  }
});

// ============================================================
// メッセージ受信 → 記録 + AI応答
// ============================================================
client.on(Events.MessageCreate, async (message) => {
  // Bot自身のメッセージは無視（ただし記録はする）
  if (message.author.id === client.user.id) return;

  // ────────────────────────────────────────
  // 1. 全メッセージをDBに記録
  // ────────────────────────────────────────
  try {
    // ユーザーupsert
    await db.upsertUser(message.author);

    // メッセージ保存
    await db.saveMessage(message);

    // メッセージカウント更新
    if (!message.author.bot) {
      await db.incrementMessageCount(message.author.id);
    }

    // ベクトル化キューに追加（Bot以外）
    if (!message.author.bot && message.content) {
      // messagesテーブルのIDを取得
      const pool = db.getPool();
      const [rows] = await pool.execute(
        'SELECT id FROM messages WHERE discord_message_id = ?',
        [message.id]
      );
      if (rows[0]) {
        enqueueMessage(rows[0].id, message.author.id, message.channelId, message.content);
      }
    }
  } catch (err) {
    console.warn('[DB] Message save failed:', err.message);
  }

  // Bot自体のメッセージは応答しない
  if (message.author.bot) return;

  // ────────────────────────────────────────
  // 2. 性格分析パイプライン（非同期・ノンブロッキング）
  // ────────────────────────────────────────
  observeMessage(message.author.id, message.content, message.id)
    .catch(err => console.warn('[Personality] Observe error:', err.message));

  // ────────────────────────────────────────
  // 3. 自己紹介チャンネル検出 → 保存
  // ────────────────────────────────────────
  if (message.channel.name === '自己紹介' && message.content.length > 20) {
    try {
      await db.saveUserIntro(message.author.id, message.content.substring(0, 2000));
      console.log(`[Intro] Saved intro for ${message.author.tag}`);
    } catch (err) {
      console.warn('[Intro] Save failed:', err.message);
    }

    // 自己紹介への自動返信は無効化（メンションされた場合のみ通常フローで応答）
    // TODO: 新規メンバーの初回自己紹介のみに限定する等、条件を検討
  }

  // ────────────────────────────────────────
  // 4. メンション応答 or 自発参加
  // ────────────────────────────────────────
  const isMentioned = message.mentions.has(client.user);

  if (!isMentioned) {
    // 自発参加の判定（たまに会話に入る）
    const shouldJoin = shouldVolunteerResponse(message);
    if (!shouldJoin) {
      if (process.env.DEBUG === '1') {
        console.log(`[${message.channel.name}] ${message.author.tag}: ${message.content.slice(0, 80)}`);
      }
      return;
    }
    // 自発参加ログ
    console.log(`🙋 自発参加: ${message.author.tag} in #${message.channel.name}: ${message.content.slice(0, 80)}`);
  }

  // メンション部分を除去（自発参加の場合はそのまま）
  const content = isMentioned
    ? message.content.replace(/<@!?\d+>/g, '').trim()
    : message.content.trim();
  if (isMentioned) {
    console.log(`💬 メンション: ${message.author.tag}: ${content}`);
  }

  // 空メンション
  if (!content) {
    await message.reply('お呼びでございますか？ 🎩 何なりとお申し付けくださいませ。');
    return;
  }

  // ────────────────────────────────────────
  // 4a. ロールベース権限判定
  // ────────────────────────────────────────
  const userLevel = getUserLevel(message.member);

  // コマンド判定用の先頭ワード
  const firstWord = content.split(/\s+/)[0].toLowerCase();

  // 権限チェック（コマンドがある場合のみ）
  const knownCommands = ['issue', 'dev', '検索', 'search', 'リセット', 'reset', 'クリア', 'clear', 'status', 'stats', 'personality'];
  if (knownCommands.includes(firstWord) && !hasPermission(firstWord, userLevel)) {
    await message.reply(getPermissionDeniedMessage(firstWord, firstWord));
    return;
  }

  // ────────────────────────────────────────
  // 4b. コマンドルーティング
  // ────────────────────────────────────────

  // リセットコマンド
  if (content.match(/^(リセット|reset|クリア|clear)$/i)) {
    const resetMsg = await resetUserSession(message.author.id, message.channelId);
    await message.reply(resetMsg);
    return;
  }

  // 検索コマンド: @WISE 検索 <キーワード>
  const searchMatch = content.match(/^(?:検索|search)\s+(.+)$/i);
  if (searchMatch) {
    const query = searchMatch[1].trim();
    await message.channel.sendTyping();
    try {
      const results = await searchMessages(query);
      await message.reply(formatSearchResults(results, query));
    } catch (err) {
      console.error('[Search] Error:', err);
      await message.reply('検索中にエラーが発生いたしました 🎩');
    }
    return;
  }

  // Issue作成: @WISE issue <タイトル>: <説明>
  const issueMatch = content.match(/^issue\s+(.+)$/i);
  if (issueMatch) {
    await message.channel.sendTyping();
    try {
      const { title, body } = parseIssueCommand(issueMatch[1]);
      const fullBody = `${body}\n\n---\nRequested by: ${message.author.username} via Discord\nChannel: #${message.channel.name}`;
      const issue = await createIssue(title, fullBody);
      await message.reply(formatIssueCreated(issue, message.author.toString()));
    } catch (err) {
      console.error('[Issue] Error:', err);
      await message.reply(`Issue作成に失敗いたしました: ${err.message} 🎩`);
    }
    return;
  }

  // 自動開発: @WISE dev #<issue番号>
  const devMatch = content.match(/^dev\s+#?(\d+)$/i);
  if (devMatch) {
    const issueNumber = parseInt(devMatch[1]);
    await message.reply(`📋 Issue #${issueNumber} の自動実装を開始いたします 🎩\nしばらくお待ちくださいませ...`);
    try {
      const progressMsg = await message.channel.send('⏳ 準備中...');
      const result = await runDevPipeline(issueNumber, async (status) => {
        await progressMsg.edit(status).catch(err => console.warn('[Bot] Action failed:', err.message));
      });
      await progressMsg.delete().catch(err => console.warn('[Bot] Action failed:', err.message));
      await message.reply(formatPRCreated(result));
    } catch (err) {
      console.error('[Dev] Pipeline error:', err);
      await message.reply(`自動実装中にエラーが発生いたしました: ${err.message} 🎩`);
    }
    return;
  }

  // ────────────────────────────────────────
  // 5. 入力サニタイズ
  // ────────────────────────────────────────
  const inputCheck = await sanitizeInput(content, message.author.username);
  if (!inputCheck.safe) {
    console.warn(`[Sanitizer] Blocked: ${message.author.tag} — ${inputCheck.reason}`);
    await message.reply(getBlockedResponse(inputCheck.reason));
    return;
  }

  // ────────────────────────────────────────
  // 6. Agent SDK でAI応答生成（ストリーミング）
  // ────────────────────────────────────────
  // typing表示
  await message.channel.sendTyping();
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(err => console.warn('[Bot] Action failed:', err.message));
  }, 8000);

  try {
    // チャンネル直近の会話を取得（コンテキスト）
    const channelHistory = await db.getChannelHistory(message.channelId, 15);

    // ストリーミング用の状態管理
    let progressMsg = null;       // 途中経過メッセージ
    let lastEditTime = 0;         // 最後に編集した時刻
    let pendingText = '';         // 未送信テキスト
    const EDIT_INTERVAL = 3000;   // 編集間隔（ms）Discord rate limit対策
    const MIN_TEXT_LENGTH = 20;   // 最低表示文字数

    const onProgress = (text) => {
      pendingText = text;
      const now = Date.now();

      // 初回送信: ある程度テキストが溜まったら
      if (!progressMsg && text.length >= MIN_TEXT_LENGTH) {
        const truncated = text.substring(0, 1900) + '\n\n_⏳ 回答生成中..._';
        progressMsg = 'sending';  // ロック
        message.reply(truncated).then(msg => {
          progressMsg = msg;
          lastEditTime = Date.now();
        }).catch(() => { progressMsg = null; });
        return;
      }

      // 定期更新: rate limit対策で間隔を空ける
      if (progressMsg && progressMsg !== 'sending' && (now - lastEditTime) >= EDIT_INTERVAL) {
        const truncated = text.substring(0, 1900) + '\n\n_⏳ 回答生成中..._';
        lastEditTime = now;
        progressMsg.edit(truncated).catch(err => console.warn('[Bot] Action failed:', err.message));
      }
    };

    // 自発参加の場合はプロンプトを補足
    const effectiveContent = isMentioned
      ? content
      : `[以下はチャンネルの会話で見かけた質問です。あなたはメンションされていませんが、有用な知見があれば自然に会話に参加してください。押し付けがましくなく、短めに。]\n\n${content}`;

    const response = await generateResponse(effectiveContent, {
      userId: message.author.id,
      username: message.author.displayName || message.author.username,
      channelId: message.channelId,
      channelName: message.channel.name,
      channelHistory,
      userLevel,
    }, onProgress);

    // ────────────────────────────────────────
    // 6a. アクションタグ検出・実行（admin権限時のみ）
    // ────────────────────────────────────────
    let finalResponse = response;
    if (userLevel === 'owner' || userLevel === 'admin') {
      const { actions, cleanText } = extractActions(response);
      if (actions.length > 0) {
        console.log(`[Admin] ${actions.length} action(s) detected from ${message.author.tag}`);
        const results = await executeActions(message.guild, actions);
        // アクション結果をメッセージ末尾に追記
        finalResponse = cleanText + '\n\n' + results.join('\n');
      }
    }

    // 出力サニタイズ
    const sanitized = await sanitizeOutput(finalResponse);

    // 最終応答: 途中メッセージがあれば編集、なければ新規送信
    if (sanitized) {
      if (progressMsg && progressMsg !== 'sending') {
        await progressMsg.edit(sanitized).catch(async () => {
          await message.reply(sanitized).catch(err => console.warn('[Bot] Action failed:', err.message));
        });
      } else {
        await message.reply(sanitized);
      }
      // チャンネルをアクティブマーク（自発参加の対象に）
      markChannelActive(message.channelId);
    }

  } catch (err) {
    console.error('[Bot] Response error:', err);
    await message.reply('お応えに手間取っております。もう一度お声がけくださいませ 🎩').catch(err => console.warn('[Bot] Action failed:', err.message));
  } finally {
    clearInterval(typingInterval);
  }
});

// ============================================================
// エラーハンドリング
// ============================================================
client.on(Events.Error, (error) => {
  console.error('Discord Client Error:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

// ============================================================
// Graceful shutdown
// ============================================================
async function shutdown(signal) {
  console.log(`🛑 ${signal} received, shutting down...`);
  client.destroy();
  await db.closePool();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================================
// 接続
// ============================================================
client.login(BOT_TOKEN);
