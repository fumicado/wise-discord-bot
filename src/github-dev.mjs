/**
 * GitHub Dev Pipeline — Discord → Issue → Branch → PR
 *
 * 管理者/コアメンバーがDiscordからIssue作成し、
 * Agent SDKが自動で実装してPRを出す。
 *
 * コマンド:
 *   @WISE issue <タイトル>: <説明>   → Issue作成
 *   @WISE dev #<issue番号>            → Issue→自動実装→PR
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'fumicado/wise-discord-bot';
const GITHUB_API = 'https://api.github.com';
const REPO_DIR = process.env.WORK_DIR || '/var/www/wise/workspace/wise-discord-bot';

/**
 * GitHub Issue を作成
 * @returns {{ number: number, url: string, title: string }}
 */
export async function createIssue(title, body, labels = ['from-discord']) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({ title, body, labels }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return {
    number: data.number,
    url: data.html_url,
    title: data.title,
  };
}

/**
 * Issue情報を取得
 */
export async function getIssue(issueNumber) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/issues/${issueNumber}`, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!res.ok) throw new Error(`Issue #${issueNumber} not found`);
  return await res.json();
}

/**
 * PRを作成
 */
export async function createPR(branch, title, body) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/pulls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({
      title,
      body,
      head: branch,
      base: 'main',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PR creation failed: ${err}`);
  }

  return await res.json();
}

/**
 * Gitコマンド実行ヘルパー
 */
async function git(...args) {
  const { stdout } = await execFileAsync('git', args, { cwd: REPO_DIR });
  return stdout.trim();
}

/**
 * Issue作成コマンドのパース
 * "タイムアウト設定を追加: Agent SDKのタイムアウトを環境変数で設定可能にする"
 * → { title: "タイムアウト設定を追加", body: "Agent SDKの..." }
 */
export function parseIssueCommand(text) {
  const colonIdx = text.indexOf(':');
  if (colonIdx > 0) {
    return {
      title: text.substring(0, colonIdx).trim(),
      body: text.substring(colonIdx + 1).trim(),
    };
  }
  return { title: text.trim(), body: '' };
}

/**
 * 自動開発パイプライン
 * Issue → Branch → Agent SDK実装 → Commit → Push → PR
 *
 * @param {number} issueNumber
 * @param {Function} progressCallback - 進捗報告コールバック
 * @returns {{ prUrl: string, branch: string }}
 */
export async function runDevPipeline(issueNumber, progressCallback) {
  const report = progressCallback || (() => {});

  // 1. Issue取得
  report('📋 Issue情報を取得中...');
  const issue = await getIssue(issueNumber);
  const branchName = `issue-${issueNumber}`;

  // 2. ブランチ作成
  report(`🌿 ブランチ \`${branchName}\` を作成中...`);
  await git('fetch', 'origin', 'main');
  await git('checkout', '-b', branchName, 'origin/main').catch(async () => {
    // ブランチが既に存在する場合
    await git('checkout', branchName);
    await git('rebase', 'origin/main');
  });

  // 3. Agent SDKで実装
  report('🤖 Agent SDKでコードを実装中...');

  // ここでAgent SDKを呼び出して実装
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const prompt = `GitHub Issue #${issueNumber} を実装してください。

## Issue
**${issue.title}**

${issue.body || '（詳細なし）'}

## ルール
- このリポジトリ（wise-discord-bot）のコードを修正してください
- 既存のコードスタイルに合わせてください（ESM, .mjs）
- テストは不要ですが、構文チェック（node --check）は必ず通してください
- 変更したファイルをgit addしてコミットしてください
- コミットメッセージは "Fix #${issueNumber}: <概要>" の形式で
- 実装が完了したら結果を報告してください`;

  let result = '';
  for await (const event of query({
    prompt,
    options: {
      cwd: REPO_DIR,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      permissionMode: 'acceptEdits',
      systemPrompt: 'あなたはwise-discord-botの開発者です。GitHub Issueの内容を実装してください。コードの品質を保ち、既存のパターンに合わせてください。',
      settingSources: [],
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
      maxTurns: 50,
    },
  })) {
    if ('type' in event && event.type === 'result' && 'result' in event) {
      result = event.result;
    }
  }

  // 4. Push
  report('📤 プッシュ中...');
  await git('push', '-u', 'origin', branchName).catch(async () => {
    await git('push', '--force-with-lease', 'origin', branchName);
  });

  // 5. PR作成
  report('📝 PRを作成中...');
  const pr = await createPR(
    branchName,
    `Fix #${issueNumber}: ${issue.title}`,
    `## Summary\nCloses #${issueNumber}\n\n${issue.title}\n\n## Implementation\n${result.substring(0, 500)}\n\n🤖 Auto-implemented by WISE Discord Bot`
  );

  // mainに戻す
  await git('checkout', 'main');

  return {
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch: branchName,
    summary: result.substring(0, 300),
  };
}

/**
 * Issue作成のDiscord応答フォーマット
 */
export function formatIssueCreated(issue, requestedBy) {
  return `📋 **Issue #${issue.number}** を作成いたしました 🎩\n\n` +
    `> **${issue.title}**\n` +
    `> ${issue.url}\n\n` +
    `起票者: ${requestedBy}\n` +
    `自動実装をご希望の場合は \`@WISE dev #${issue.number}\` とお申し付けくださいませ。`;
}

/**
 * PR作成のDiscord応答フォーマット
 */
export function formatPRCreated(pr) {
  return `✅ **PR #${pr.prNumber}** を作成いたしました 🎩\n\n` +
    `> ブランチ: \`${pr.branch}\`\n` +
    `> ${pr.prUrl}\n\n` +
    `レビューをお願いいたします。`;
}
