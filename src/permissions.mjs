/**
 * Permissions — ロールベースのコマンド権限管理
 *
 * Discordのロールに応じてBotの振る舞いを変える。
 * ロール名で判定（ID固定しない → 他サーバーでも再利用可能）。
 *
 * 権限レベル:
 *   owner     — サーバーオーナー（全権限）
 *   admin     — 共同運営管理者ロール（issue作成、Bot設定変更）
 *   core      — コアメンバーロール（issue作成、検索）
 *   member    — メンバーロール（検索、AI応答）
 *   everyone  — 未ロール（AI応答のみ）
 */

// ロール名 → 権限レベルのマッピング（小文字で比較）
const ROLE_LEVELS = {
  '共同運営管理者': 'admin',
  'admin': 'admin',
  'moderator': 'admin',
  'コアメンバー': 'core',
  'core': 'core',
  'メンバー': 'member',
  'member': 'member',
};

// コマンド → 必要な最低権限レベル
const COMMAND_PERMISSIONS = {
  // issue系（GitHub連携）
  'issue': 'core',         // Issue作成
  'dev': 'admin',          // 自動開発トリガー（Issue→Branch→PR）

  // 検索
  '検索': 'everyone',
  'search': 'everyone',

  // セッション
  'リセット': 'everyone',
  'reset': 'everyone',
  'clear': 'everyone',
  'クリア': 'everyone',

  // Bot管理
  'status': 'admin',       // Bot状態確認
  'stats': 'core',         // サーバー統計
  'personality': 'core',   // 性格分析結果閲覧

  // AI応答（メンション全般）
  '_default': 'everyone',
};

// 権限レベルの順序（高い方が強い）
const LEVEL_ORDER = ['everyone', 'member', 'core', 'admin', 'owner'];

/**
 * ユーザーの権限レベルを判定
 * @param {GuildMember} member - Discord GuildMember
 * @returns {string} 権限レベル
 */
export function getUserLevel(member) {
  if (!member) return 'everyone';

  // サーバーオーナー
  if (member.guild.ownerId === member.id) return 'owner';

  // ロールから最高権限を取得
  let highestLevel = 'everyone';

  for (const role of member.roles.cache.values()) {
    const roleName = role.name.toLowerCase();
    for (const [pattern, level] of Object.entries(ROLE_LEVELS)) {
      // 完全一致のみ（部分一致は意図しない権限昇格の原因になる）
      if (roleName === pattern.toLowerCase()) {
        if (LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(highestLevel)) {
          highestLevel = level;
        }
      }
    }
  }

  return highestLevel;
}

/**
 * コマンドの実行権限があるか判定
 * @param {string} command - コマンド名
 * @param {string} userLevel - ユーザーの権限レベル
 * @returns {boolean}
 */
export function hasPermission(command, userLevel) {
  const requiredLevel = COMMAND_PERMISSIONS[command] || COMMAND_PERMISSIONS['_default'];
  return LEVEL_ORDER.indexOf(userLevel) >= LEVEL_ORDER.indexOf(requiredLevel);
}

/**
 * 権限不足時のメッセージ
 */
export function getPermissionDeniedMessage(command, requiredLevel) {
  const levelNames = {
    owner: 'サーバーオーナー',
    admin: '管理者（共同運営管理者ロール）',
    core: 'コアメンバー以上',
    member: 'メンバー以上',
    everyone: '全員',
  };

  return `申し訳ございません。「${command}」コマンドは **${levelNames[requiredLevel] || requiredLevel}** の方のみご利用いただけます 🎩`;
}

/**
 * ユーザーの権限情報をシステムプロンプトに注入する文字列を生成
 */
export function getPermissionContext(member) {
  const level = getUserLevel(member);
  const roles = [...member.roles.cache.values()]
    .filter(r => r.name !== '@everyone')
    .map(r => r.name);

  return `権限レベル: ${level}` + (roles.length > 0 ? ` (ロール: ${roles.join(', ')})` : '');
}
