/**
 * worktree-parallel-sessions: 形容词-名人 名字生成 + 冲突避让。
 *
 * 风格参考 docker container random naming(Linus Torvalds 等), 名字保留小写
 * 单词中划线连接(避免 windows 路径段大小写敏感问题)。
 */

const ADJECTIVES: readonly string[] = [
  'pensive', 'eager', 'jolly', 'silly', 'epic', 'brave', 'calm', 'clever',
  'curious', 'dazzling', 'earnest', 'elegant', 'fierce', 'gentle', 'happy',
  'humble', 'inspiring', 'keen', 'lively', 'loyal', 'merry', 'noble',
  'optimistic', 'peaceful', 'proud', 'quirky', 'radiant', 'serene', 'sharp',
  'silent', 'sincere', 'steady', 'stoic', 'sturdy', 'sweet', 'swift', 'tender',
  'thoughtful', 'tranquil', 'trusty', 'upbeat', 'vibrant', 'vigilant', 'warm',
  'wise', 'witty', 'zealous', 'amazing', 'bold', 'cheerful',
];

// 取自计算机/科学史上的名人, 避免争议性人物。
const SURNAMES: readonly string[] = [
  'lederberg', 'turing', 'lovelace', 'hopper', 'knuth', 'dijkstra', 'ritchie',
  'thompson', 'kernighan', 'torvalds', 'stallman', 'wozniak', 'curie', 'darwin',
  'einstein', 'feynman', 'galileo', 'hawking', 'newton', 'pasteur', 'tesla',
  'archimedes', 'babbage', 'bohr', 'borg', 'cohen', 'colden', 'edison',
  'engelbart', 'euclid', 'fermi', 'goldberg', 'goodall', 'hamilton', 'hertz',
  'hodgkin', 'jang', 'jepsen', 'kalam', 'kapitsa', 'kepler', 'lamarr',
  'leakey', 'liskov', 'mclean', 'mendel', 'mendeleev', 'mirzakhani', 'morse',
  'noether', 'panini',
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** worktree 名长度上限(分支 + 路径段在 Windows 上不能太长)。 */
export const MAX_RAW_NAME_LENGTH = 20;

/**
 * worktree name 合法字符集白名单。
 *
 * 要求(求 git ref + Windows 路径 + POSIX 路径的交集再加保险):
 *   - 仅 [a-z0-9-]
 *   - 必须以 [a-z0-9] 开头(防止以 `-` 开头被 cli 误认为 flag, 防止以 `.` 开头被 git ref 拒绝)
 *   - 长度 1..MAX_RAW_NAME_LENGTH
 *   - 不能两个连续 `-`(防御 git ref 类似 `..` 限制的精神, 顺手保留)
 *   - 不能以 `-` 结尾
 */
const VALID_NAME_RE = /^[a-z0-9](?!.*--)[a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** 校验 worktree 名是否合法。返回 null 表示合法, 否则返回简短理由(给用户看)。 */
export function validateWorktreeName(name: string): string | null {
  if (typeof name !== 'string') return '必须是字符串';
  if (name.length === 0) return '不能为空';
  if (name.length > MAX_RAW_NAME_LENGTH) return `长度不能超过 ${MAX_RAW_NAME_LENGTH} 个字符`;
  if (!VALID_NAME_RE.test(name)) {
    return '仅允许小写字母、数字、单个中划线; 必须以字母或数字开头/结尾';
  }
  return null;
}

/**
 * 生成一个候选名字(无冲突避让, 仅一次随机)。
 *
 * 长度保证 ≤ MAX_RAW_NAME_LENGTH(20)。最长组合(thoughtful-mirzakhani = 21)
 * 会触发回退采样: 若超过上限则重新 pick, 上限 50 次硬兜底。
 */
export function generateRawName(): string {
  for (let i = 0; i < 50; i += 1) {
    const raw = `${pick(ADJECTIVES)}-${pick(SURNAMES)}`;
    if (raw.length <= MAX_RAW_NAME_LENGTH) return raw;
  }
  // 极端兜底: 截断到 MAX_RAW_NAME_LENGTH(实际几乎不会走到)
  return `${pick(ADJECTIVES)}-${pick(SURNAMES)}`.slice(0, MAX_RAW_NAME_LENGTH);
}

/**
 * 给定原始 name + 已存在的名字集合, 返回首个不冲突的命名:
 *   - name 不冲突 → 直接返回 name
 *   - 冲突 → 依次尝试 name-2, name-3, ... 直到不冲突
 *
 * 注意: 大小写敏感比对在 Windows 下不安全(路径不分大小写), 因此比对时 toLowerCase。
 */
export function avoidCollision(
  name: string,
  taken: readonly string[],
): string {
  const takenSet = new Set(taken.map((t) => t.toLowerCase()));
  if (!takenSet.has(name.toLowerCase())) return name;
  let n = 2;
  // 上限 9999 防止 worst case 死循环(实际不会到这里, 这就是保险丝)
  while (n < 10000) {
    const candidate = `${name}-${n}`;
    if (!takenSet.has(candidate.toLowerCase())) return candidate;
    n += 1;
  }
  // 极端兜底: 加时间戳
  return `${name}-${Date.now()}`;
}

/**
 * 一站式: 生成 + 避让, 最多重试 maxAttempts 次随机, 每次都跑 avoidCollision。
 *
 * 调用方传入"已用名字列表"(store + git branch 的 union), avoidCollision 用 -2/-3 后缀
 * 兜住所有冲突, 所以实际只需要 1 次随机就够; maxAttempts > 1 仅在希望尽量避免数字后缀时有用。
 */
export function generateUniqueName(
  taken: readonly string[],
  maxAttempts = 5,
): string {
  for (let i = 0; i < maxAttempts; i += 1) {
    const raw = generateRawName();
    const takenSet = new Set(taken.map((t) => t.toLowerCase()));
    if (!takenSet.has(raw.toLowerCase())) return raw;
  }
  // maxAttempts 次都撞了, 走 avoidCollision 加后缀
  return avoidCollision(generateRawName(), taken);
}

/**
 * 把 name → 分支名: `xdt/<name>`。纯函数, 没有副作用。
 */
export function getBranchName(name: string): string {
  return `xdt/${name}`;
}
