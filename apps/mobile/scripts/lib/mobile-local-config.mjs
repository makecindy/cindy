import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSelfHostRegions } from './self-host-region.mjs';

const defaultMobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Parse the path and branch fields needed to rank reusable local configs. */
export function parseGitWorktreeEntries(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }
  return entries;
}

/**
 * A Git worktree does not inherit gitignored machine config. Reuse a validated
 * config from another worktree without printing any of its values.
 */
export function ensureMobileLocalRegionConfig(options = {}) {
  const mobileDir = path.resolve(options.mobileDir ?? defaultMobileDir);
  const worktreeRoot = path.resolve(mobileDir, '../..');
  const configPath = path.join(mobileDir, 'scripts', 'self-host-regions.json');
  // 本地 Xcode / Simulator 引导用 local 模式:TapDB / Google 等叶子值允许留空,
  // 外部开发者只填身份字段即可构建;自建发布线仍走默认 release 严格校验。
  const validateConfig = options.validateConfig ?? ((candidate) => loadSelfHostRegions({ filePath: candidate, mode: 'local' }));

  if (fs.existsSync(configPath)) {
    validateConfig(configPath);
    return { configPath, copiedFrom: null };
  }

  const entries = options.worktreeEntries ?? readWorktreeEntries(worktreeRoot);
  const candidates = entries
    .filter((entry) => path.resolve(entry.path) !== worktreeRoot)
    .sort((a, b) => candidateRank(a) - candidateRank(b));
  const invalidCandidates = [];

  for (const candidate of candidates) {
    const sourcePath = path.join(candidate.path, 'apps', 'mobile', 'scripts', 'self-host-regions.json');
    if (!fs.existsSync(sourcePath)) continue;
    try {
      validateConfig(sourcePath);
    } catch {
      invalidCandidates.push(sourcePath);
      continue;
    }
    const published = publishValidatedConfig(sourcePath, configPath, validateConfig);
    validateConfig(configPath);
    return { configPath, copiedFrom: published ? sourcePath : null };
  }

  const invalidHint = invalidCandidates.length > 0
    ? ` Found ${invalidCandidates.length} invalid config candidate(s); values were not copied.`
    : '';

  // 任何 worktree 都没有可用配置时,不再阻断:从空白模板自动创建并打警告。
  // 空白模板在 local 校验模式下合法——app 身份回落内置默认,统计关闭;Global 的 Google 登录改走浏览器(CN 不提供 Google)。
  const examplePath = path.join(mobileDir, 'scripts', 'self-host-regions.json.example');
  if (fs.existsSync(examplePath)) {
    validateConfig(examplePath);
    const published = publishValidatedConfig(examplePath, configPath, validateConfig);
    validateConfig(configPath);
    console.warn(
      `[cindy] Missing ${configPath}; created it from the blank template ` +
        '(built-in app identity, analytics disabled, Google sign-in through the browser on Global only). ' +
        `Edit the file to customize.${invalidHint}`,
    );
    return { configPath, copiedFrom: published ? examplePath : null, createdFromExample: true };
  }

  throw new Error(
    `Missing mobile local region config: ${configPath}. Copy self-host-regions.json from a configured Cindy worktree or fill self-host-regions.json.example.${invalidHint}`,
  );
}

/** Publish a complete config atomically; concurrent bootstraps may safely race. */
function publishValidatedConfig(sourcePath, configPath, validateConfig) {
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.copyFileSync(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(tempPath, 0o600);
    validateConfig(tempPath);
    try {
      fs.linkSync(tempPath, configPath);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return false;
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export function formatMobileLocalConfigStatus(result, worktreeRoot) {
  if (result.createdFromExample) {
    return '==> Created mobile local config from the blank template (built-in app identity, analytics disabled, Google sign-in through the browser on Global only); edit apps/mobile/scripts/self-host-regions.json to customize';
  }
  if (!result.copiedFrom) return null;
  return `==> Reused validated mobile local config from ${path.relative(path.dirname(worktreeRoot), result.copiedFrom)} (values hidden)`;
}

function readWorktreeEntries(worktreeRoot) {
  try {
    const text = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: worktreeRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseGitWorktreeEntries(text);
  } catch {
    return [];
  }
}

function candidateRank(entry) {
  const basename = path.basename(entry.path);
  if (basename.endsWith('personal-client')) return 0;
  if (entry.branch === 'refs/heads/main' || entry.branch === 'refs/heads/master') return 1;
  return 2;
}
