# WISE Discord Bot

**日本AI開発者互助会** の執事AI。メンバーの会話を記録・分析し、メンション時にAI応答を返す。

## Architecture

```
Discord Gateway
  │
  ├─ MessageCreate → MariaDB記録 → ベクトル化(OpenAI) → 性格分析
  │
  ├─ メンション検出 → サニタイズ → Agent SDK(GLM-5) → サニタイズ → 応答
  │
  └─ 自発参加判定（技術質問 + 確率ゲート）→ 応答
```

### Modules

| File | Role |
|------|------|
| `bot.mjs` | エントリーポイント。Discord.js Gateway、コマンドルーティング、ストリーミング応答 |
| `agent.mjs` | Agent SDK統合。GLM-5 via Z.AI。セッション管理（user×channel） |
| `db.mjs` | MariaDB接続プール、CRUD操作 |
| `sanitizer.mjs` | 入力サニタイズ（jailbreak検出）+ 出力サニタイズ（内部情報マスク、2000文字制限） |
| `personality.mjs` | 性格分析パイプライン（Big5 + エニアグラム、20メッセージごと） |
| `embedding.mjs` | OpenAI text-embedding-3-small → MariaDB VECTOR(1536) |
| `discord-search.mjs` | ベクトル類似検索（VEC_DISTANCE_COSINE） |
| `permissions.mjs` | ロールベース権限（owner / admin / core / everyone） |
| `github-dev.mjs` | GitHub Issue作成 + 自動開発パイプライン |

## Features

- **全メッセージ記録**: guild内の全メッセージをMariaDBに保存
- **AI応答**: メンション時にAgent SDK経由で応答（ストリーミング表示対応）
- **自発参加**: 技術的な質問を検出し、30%の確率で自然に会話に参加
- **セッション継続**: user×channelごとにAgent SDKセッションを管理・resume
- **性格分析**: Big5 + エニアグラムでメンバーの性格傾向を蓄積
- **ベクトル検索**: 過去の会話をembeddingで意味検索
- **入出力サニタイズ**: jailbreak防御 + 内部情報漏洩防止
- **ロールベース権限**: コマンドごとに必要な権限レベルを制御
- **ウェルカムメッセージ**: 新メンバー参加時に執事スタイルで案内
- **GitHub連携**: Discordからissue作成、自動開発パイプライン

## Commands

メンション (`@WISE`) + コマンド:

| Command | Permission | Description |
|---------|-----------|-------------|
| `検索 <query>` | core+ | ベクトル類似検索で過去の会話を検索 |
| `issue <title>: <body>` | core+ | GitHub Issueを作成 |
| `dev #<number>` | admin+ | Issueから自動実装パイプラインを実行 |
| `リセット` | everyone | 自分のセッションをリセット |

メンションだけならフリートーク。

## Setup

### 1. Database

```bash
sudo mariadb < setup-db.sql
```

### 2. Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Install & Run

```bash
npm install
npm start
```

### 4. Systemd (production)

```bash
sudo cp wise-discord-bot.service /etc/systemd/system/
sudo systemctl enable --now wise-discord-bot
```

## Database Schema

| Table | Purpose |
|-------|---------|
| `users` | Discordユーザー情報 + 性格スコア |
| `messages` | 全メッセージログ（FULLTEXT INDEX付き） |
| `sessions` | Agent SDKセッション管理（user×channel） |
| `personality_log` | 性格分析の観察ログ |
| `message_vectors` | embedding VECTOR(1536) |

## Tech Stack

- **Runtime**: Node.js (ESM)
- **Discord**: discord.js v14
- **AI**: Claude Agent SDK → GLM-5 via Z.AI
- **DB**: MariaDB (VECTOR対応)
- **Embedding**: OpenAI text-embedding-3-small
- **Sanitization**: GLM-4.5-air via Z.AI
