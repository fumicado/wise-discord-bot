/**
 * Discord Admin — サーバー管理操作
 *
 * admin権限ユーザーがWISEに自然言語で指示 →
 * AIがアクションタグを出力 → このモジュールが実行。
 *
 * 対応アクション:
 * - チャンネル作成/削除/編集
 * - カテゴリ作成/削除
 * - ロール作成/削除/付与/剥奪
 * - スレッド作成/アーカイブ
 * - 権限の上書き設定
 */
import { ChannelType, PermissionsBitField } from 'discord.js';

// アクションタグの正規表現: [ADMIN_ACTION:{ ... }]
const ACTION_TAG_RE = /\[ADMIN_ACTION:([\s\S]*?)\]/g;

/**
 * AIの応答からアクションタグを抽出
 * @param {string} text - AI応答テキスト
 * @returns {{ actions: object[], cleanText: string }}
 */
export function extractActions(text) {
  const actions = [];
  let cleanText = text;

  for (const match of text.matchAll(ACTION_TAG_RE)) {
    try {
      const action = JSON.parse(match[1]);
      actions.push(action);
    } catch (err) {
      console.warn('[Admin] Failed to parse action tag:', match[1], err.message);
    }
    cleanText = cleanText.replace(match[0], '');
  }

  return { actions, cleanText: cleanText.trim() };
}

/**
 * アクションを実行
 * @param {Guild} guild - Discord Guild
 * @param {object} action - パース済みアクション
 * @returns {Promise<string>} 結果メッセージ
 */
export async function executeAction(guild, action) {
  const { type } = action;

  switch (type) {
    // ──────────────── チャンネル ────────────────
    case 'create_channel': {
      const { name, channelType = 'text', category, topic, nsfw = false } = action;
      if (!name) return '❌ チャンネル名が指定されていません';

      const typeMap = {
        text: ChannelType.GuildText,
        voice: ChannelType.GuildVoice,
        forum: ChannelType.GuildForum,
        stage: ChannelType.GuildStageVoice,
        announcement: ChannelType.GuildAnnouncement,
      };
      const discordType = typeMap[channelType] ?? ChannelType.GuildText;

      const options = { name, type: discordType, topic, nsfw };

      // カテゴリ指定があれば検索
      if (category) {
        const parent = guild.channels.cache.find(
          c => c.type === ChannelType.GuildCategory &&
               c.name.toLowerCase() === category.toLowerCase()
        );
        if (parent) options.parent = parent.id;
      }

      const ch = await guild.channels.create(options);
      return `✅ チャンネル <#${ch.id}> を作成いたしました`;
    }

    case 'delete_channel': {
      const { name, id } = action;
      const ch = id
        ? guild.channels.cache.get(id)
        : guild.channels.cache.find(c => c.name === name);
      if (!ch) return `❌ チャンネル「${name || id}」が見つかりません`;
      const chName = ch.name;
      await ch.delete();
      return `✅ チャンネル #${chName} を削除いたしました`;
    }

    case 'edit_channel': {
      const { name, id, newName, topic, nsfw, slowmode } = action;
      const ch = id
        ? guild.channels.cache.get(id)
        : guild.channels.cache.find(c => c.name === name);
      if (!ch) return `❌ チャンネル「${name || id}」が見つかりません`;

      const edits = {};
      if (newName !== undefined) edits.name = newName;
      if (topic !== undefined) edits.topic = topic;
      if (nsfw !== undefined) edits.nsfw = nsfw;
      if (slowmode !== undefined) edits.rateLimitPerUser = slowmode;
      await ch.edit(edits);
      return `✅ チャンネル <#${ch.id}> を更新いたしました`;
    }

    // ──────────────── カテゴリ ────────────────
    case 'create_category': {
      const { name } = action;
      if (!name) return '❌ カテゴリ名が指定されていません';
      const cat = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
      });
      return `✅ カテゴリ「${cat.name}」を作成いたしました`;
    }

    case 'delete_category': {
      const { name, id } = action;
      const cat = id
        ? guild.channels.cache.get(id)
        : guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name?.toLowerCase()
          );
      if (!cat) return `❌ カテゴリ「${name || id}」が見つかりません`;
      const catName = cat.name;
      await cat.delete();
      return `✅ カテゴリ「${catName}」を削除いたしました`;
    }

    // ──────────────── ロール ────────────────
    case 'create_role': {
      const { name, color, mentionable = false, hoist = false } = action;
      if (!name) return '❌ ロール名が指定されていません';
      const role = await guild.roles.create({
        name,
        color: color || undefined,
        mentionable,
        hoist,
      });
      return `✅ ロール「${role.name}」を作成いたしました`;
    }

    case 'delete_role': {
      const { name, id } = action;
      const role = id
        ? guild.roles.cache.get(id)
        : guild.roles.cache.find(r => r.name.toLowerCase() === name?.toLowerCase());
      if (!role) return `❌ ロール「${name || id}」が見つかりません`;
      if (role.managed) return `❌ 「${role.name}」はBot管理ロールのため削除できません`;
      const roleName = role.name;
      await role.delete();
      return `✅ ロール「${roleName}」を削除いたしました`;
    }

    case 'assign_role': {
      const { userId, roleName, roleId } = action;
      if (!userId) return '❌ ユーザーが指定されていません';

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return `❌ ユーザー(${userId})が見つかりません`;

      const role = roleId
        ? guild.roles.cache.get(roleId)
        : guild.roles.cache.find(r => r.name.toLowerCase() === roleName?.toLowerCase());
      if (!role) return `❌ ロール「${roleName || roleId}」が見つかりません`;

      await member.roles.add(role);
      return `✅ ${member.displayName} に「${role.name}」ロールを付与いたしました`;
    }

    case 'remove_role': {
      const { userId, roleName, roleId } = action;
      if (!userId) return '❌ ユーザーが指定されていません';

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return `❌ ユーザー(${userId})が見つかりません`;

      const role = roleId
        ? guild.roles.cache.get(roleId)
        : guild.roles.cache.find(r => r.name.toLowerCase() === roleName?.toLowerCase());
      if (!role) return `❌ ロール「${roleName || roleId}」が見つかりません`;

      await member.roles.remove(role);
      return `✅ ${member.displayName} から「${role.name}」ロールを剥奪いたしました`;
    }

    // ──────────────── スレッド ────────────────
    case 'create_thread': {
      const { channelName, channelId, name, autoArchiveDuration = 1440 } = action;
      const ch = channelId
        ? guild.channels.cache.get(channelId)
        : guild.channels.cache.find(c => c.name === channelName);
      if (!ch) return `❌ チャンネル「${channelName || channelId}」が見つかりません`;
      if (!name) return '❌ スレッド名が指定されていません';

      const thread = await ch.threads.create({ name, autoArchiveDuration });
      return `✅ スレッド「${thread.name}」を作成いたしました`;
    }

    case 'archive_thread': {
      const { threadId, threadName } = action;
      // スレッドはactiveThreadsから検索
      const fetched = await guild.channels.fetch().catch(() => null);
      const thread = threadId
        ? guild.channels.cache.get(threadId)
        : guild.channels.cache.find(c => c.isThread?.() && c.name === threadName);
      if (!thread) return `❌ スレッド「${threadName || threadId}」が見つかりません`;
      await thread.setArchived(true);
      return `✅ スレッド「${thread.name}」をアーカイブいたしました`;
    }

    // ──────────────── 権限上書き ────────────────
    case 'set_channel_permission': {
      const { channelName, channelId, targetType, targetName, targetId, allow = [], deny = [] } = action;
      const ch = channelId
        ? guild.channels.cache.get(channelId)
        : guild.channels.cache.find(c => c.name === channelName);
      if (!ch) return `❌ チャンネル「${channelName || channelId}」が見つかりません`;

      let target;
      if (targetType === 'role') {
        target = targetId
          ? guild.roles.cache.get(targetId)
          : guild.roles.cache.find(r => r.name.toLowerCase() === targetName?.toLowerCase());
      } else {
        target = await guild.members.fetch(targetId || targetName).catch(() => null);
      }
      if (!target) return `❌ 対象「${targetName || targetId}」が見つかりません`;

      // 権限文字列をPermissionsBitFieldに変換
      const toBits = (perms) => perms.map(p => PermissionsBitField.Flags[p]).filter(Boolean);

      await ch.permissionOverwrites.edit(target, {
        ...Object.fromEntries(toBits(allow).map(f => [f, true])),
        ...Object.fromEntries(toBits(deny).map(f => [f, false])),
      });
      return `✅ <#${ch.id}> の権限を更新いたしました`;
    }

    // ──────────────── サーバー情報 ────────────────
    case 'list_channels': {
      const channels = guild.channels.cache
        .filter(c => c.type !== ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position)
        .map(c => {
          const typeEmoji = { 0: '💬', 2: '🔊', 5: '📢', 13: '🎙️', 15: '📋' };
          return `${typeEmoji[c.type] || '📁'} ${c.name}${c.parent ? ` (${c.parent.name})` : ''}`;
        });
      return `📋 **チャンネル一覧** (${channels.length}件)\n${channels.join('\n')}`;
    }

    case 'list_roles': {
      const roles = guild.roles.cache
        .filter(r => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position)
        .map(r => `• ${r.name} — ${r.members.size}人`);
      return `📋 **ロール一覧** (${roles.length}件)\n${roles.join('\n')}`;
    }

    default:
      return `❌ 不明なアクション: ${type}`;
  }
}

/**
 * 複数アクションを順次実行
 * @param {Guild} guild
 * @param {object[]} actions
 * @returns {Promise<string[]>} 各アクションの結果
 */
export async function executeActions(guild, actions) {
  const results = [];
  for (const action of actions) {
    try {
      const result = await executeAction(guild, action);
      results.push(result);
    } catch (err) {
      console.error('[Admin] Action failed:', action, err);
      const errMsg = err.code === 50013
        ? '❌ Botの権限が不足しています。Developer Portalで Manage Channels / Manage Roles を有効にしてください'
        : `❌ 操作失敗: ${err.message}`;
      results.push(errMsg);
    }
  }
  return results;
}

/**
 * admin用のツール仕様（システムプロンプトに注入する文字列）
 */
export function getAdminToolSpec() {
  return `
## サーバー管理ツール（admin権限のみ）

あなたはサーバー管理操作を実行できます。以下のアクションタグを応答に含めてください。
タグは必ず [ADMIN_ACTION:{ JSON }] の形式で出力してください。複数の操作は複数のタグを出力します。
アクションの実行結果は自動的にユーザーに通知されます。

### 利用可能なアクション

#### チャンネル管理
- \`create_channel\`: チャンネル作成
  [ADMIN_ACTION:{"type":"create_channel","name":"チャンネル名","channelType":"text|voice|forum|stage|announcement","category":"カテゴリ名(省略可)","topic":"トピック(省略可)"}]

- \`delete_channel\`: チャンネル削除
  [ADMIN_ACTION:{"type":"delete_channel","name":"チャンネル名"}]

- \`edit_channel\`: チャンネル編集
  [ADMIN_ACTION:{"type":"edit_channel","name":"対象チャンネル名","newName":"新名(省略可)","topic":"新トピック(省略可)","slowmode":秒数(省略可)}]

#### カテゴリ管理
- \`create_category\`: カテゴリ作成
  [ADMIN_ACTION:{"type":"create_category","name":"カテゴリ名"}]

- \`delete_category\`: カテゴリ削除
  [ADMIN_ACTION:{"type":"delete_category","name":"カテゴリ名"}]

#### ロール管理
- \`create_role\`: ロール作成
  [ADMIN_ACTION:{"type":"create_role","name":"ロール名","color":"#FF0000(省略可)","mentionable":true/false,"hoist":true/false}]

- \`delete_role\`: ロール削除
  [ADMIN_ACTION:{"type":"delete_role","name":"ロール名"}]

- \`assign_role\`: ロール付与（userIdはメンションから取得: <@ユーザーID> → userId）
  [ADMIN_ACTION:{"type":"assign_role","userId":"ユーザーID","roleName":"ロール名"}]

- \`remove_role\`: ロール剥奪
  [ADMIN_ACTION:{"type":"remove_role","userId":"ユーザーID","roleName":"ロール名"}]

#### スレッド管理
- \`create_thread\`: スレッド作成
  [ADMIN_ACTION:{"type":"create_thread","channelName":"親チャンネル名","name":"スレッド名"}]

- \`archive_thread\`: スレッドアーカイブ
  [ADMIN_ACTION:{"type":"archive_thread","threadName":"スレッド名"}]

#### 権限管理
- \`set_channel_permission\`: チャンネルの権限上書き
  [ADMIN_ACTION:{"type":"set_channel_permission","channelName":"チャンネル名","targetType":"role","targetName":"ロール名","allow":["ViewChannel","SendMessages"],"deny":["SendMessages"]}]
  ※ 使用可能な権限名: ViewChannel, SendMessages, ManageChannels, ManageRoles, ManageMessages, EmbedLinks, AttachFiles, ReadMessageHistory, MentionEveryone, Connect, Speak

#### 情報取得
- \`list_channels\`: チャンネル一覧
  [ADMIN_ACTION:{"type":"list_channels"}]

- \`list_roles\`: ロール一覧
  [ADMIN_ACTION:{"type":"list_roles"}]

### ルール
- 削除操作は必ずユーザーに確認してから実行すること（「よろしいですか？」→ 確認後にタグ出力）
- 一度に大量の操作を行う場合は、途中経過を報告すること
- ユーザーのメッセージ内のメンション（<@123456>）からuserIdを取得すること
- アクションタグの前後に、執事口調で説明テキストを入れること`;
}
