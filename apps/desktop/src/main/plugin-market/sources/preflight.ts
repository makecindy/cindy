/**
 * Git 环境前置检测。
 *
 * 打开添加市场对话框时调用一次：Git 缺失或版本过低时禁用 Git 来源的添加
 * （本地来源不受影响）。结果不缓存——用户可能在会话中途装好 Git。
 */
import {
  gitVersion,
  isGitVersionSupported,
  type GitExecutor,
} from './git.js';

export interface GitPreflightResult {
  ok: boolean;
  /** 检测到的版本文本（如 "2.43.0"）；未安装/执行失败为 null。 */
  version: string | null;
}

export async function checkGitPreflight(
  executor?: GitExecutor,
): Promise<GitPreflightResult> {
  const version = await gitVersion(executor);
  if (!version) return { ok: false, version: null };
  return {
    ok: isGitVersionSupported(version),
    version: `${version.major}.${version.minor}`,
  };
}
