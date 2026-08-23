/**
 * Review 新鲜度的 staged index 身份读取(#2460)。
 *
 * 内容指纹只哈希**工作树文件**;staged 内容存放在 Git index 中。同一路径同时
 * 存在 staged 与 unstaged 的无正文 diff(binary / large-text / too-large /
 * capped)时,把 index blob 换成同尺寸的另一份、再把工作树字节还原:porcelain
 * status、空 patch 元数据与工作树内容指纹全部不变——两道 freshness gate 都会
 * 放行,review 结论针对的却是已经过期的 staged 证据。
 *
 * 这里只绑定 Git 已经算好的**对象身份** `(path, mode, stage, oid)`,不读 blob
 * 字节:oid 天然稳定(同内容同 oid,重复 git add 不误伤),也不引入新的字节
 * 读取面。staged 删除没有 index 条目——「缺席」本身就是身份,记为 absent 标记,
 * 与「换了另一份 blob」同样参与指纹。unmerged 条目的 stage 1/2/3 各自成行,
 * 完整可表达。git 命令失败时抛错 fail closed(与 Git 证据读取失败同语义,由
 * 调用方中止 Review)。
 */

import { runGit } from './gitRunner.js';

/** `:(top,literal)` 前缀:按仓库根字面匹配,不展开 glob。 */
function literalPathspec(gitPath: string): string {
  return `:(top,literal)${gitPath}`;
}

/**
 * pathspec 分批上限。Windows 的进程命令行封顶约 32K 字符,数千条 capped
 * staged 路径塞进单次 spawn 会直接失败;按累计字节与条数双重上限分批,
 * 批间合并结果,语义与单次调用一致。
 */
const MAX_BATCH_PATHSPEC_BYTES = 12_000;
const MAX_BATCH_PATHS = 500;

/** 供测试注入更小的分批上限;生产调用方不传,走默认常量。 */
export interface IndexIdentityBatchLimits {
  maxBatchPathspecBytes?: number;
  maxBatchPaths?: number;
}

function splitIntoBatches(paths: string[], limits?: IndexIdentityBatchLimits): string[][] {
  const maxBytes = limits?.maxBatchPathspecBytes ?? MAX_BATCH_PATHSPEC_BYTES;
  const maxPaths = limits?.maxBatchPaths ?? MAX_BATCH_PATHS;
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const p of paths) {
    // `:(top,literal)` 前缀 + 引号/分隔的粗略开销。
    const bytes = Buffer.byteLength(p, 'utf8') + 20;
    if (current.length > 0 && (currentBytes + bytes > maxBytes || current.length >= maxPaths)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(p);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * 读取一组路径的 staged index 身份记录,稳定排序返回。
 *
 * 返回记录形如 `<mode> <stage> <oid>\t<path>`(存在于 index)或
 * `absent\t<path>`(index 无该条目,如 staged 删除)。记录组与输入顺序无关,
 * 调用方把整组并入 workspace fingerprint 即完成绑定。
 */
export async function readStagedIndexIdentity(
  repoRoot: string,
  rawPaths: readonly string[],
  limits?: IndexIdentityBatchLimits,
): Promise<string[]> {
  // 不做字符过滤:pathspec 经 argv 传递、输出用 -z(NUL 分隔、无引号转义),
  // 含 \n / \r / \t 的合法 Git 路径同样必须绑定身份 —— 静默丢弃就是绕过口。
  // 记录并入 fingerprint 时经 JSON 序列化,控制字符不产生边界歧义。
  const paths = [...new Set(rawPaths)]
    .filter((p) => p.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paths.length === 0) return [];

  // 记录格式:"<mode> <oid> <stage>\t<path>",NUL 分隔。
  const entriesByPath = new Map<string, string[]>();
  for (const batch of splitIntoBatches(paths, limits)) {
    // 输出预算按路径实际字节计,且 unmerged 一条输入产出 stage 1/2/3 三行,
    // 每行都含完整路径 —— 统一按三倍身份行计,不足 1MB 补足。
    const budget = batch.reduce((n, p) => n + (Buffer.byteLength(p, 'utf8') + 128) * 3, 0);
    const { stdout } = await runGit(
      ['ls-files', '--stage', '-z', '--', ...batch.map(literalPathspec)],
      { cwd: repoRoot, maxStdoutBytes: Math.max(1024 * 1024, budget) },
    );
    for (const record of stdout.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [mode, oid, stage] = record.slice(0, tab).trim().split(/\s+/);
      const filePath = record.slice(tab + 1);
      if (!mode || !oid || !stage || !filePath) continue;
      const rows = entriesByPath.get(filePath) ?? [];
      rows.push(`${mode} ${stage} ${oid}\t${filePath}`);
      entriesByPath.set(filePath, rows);
    }
  }

  const records: string[] = [];
  for (const p of paths) {
    const rows = entriesByPath.get(p);
    if (rows && rows.length > 0) {
      // unmerged 时同一路径有 stage 1/2/3 多行;行内排序保证稳定。
      records.push(...rows.sort());
    } else {
      records.push(`absent\t${p}`);
    }
  }
  return records;
}
