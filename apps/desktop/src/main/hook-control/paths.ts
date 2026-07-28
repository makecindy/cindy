/**
 * hook-control/paths.ts
 * ---------------------------------------------------------------------------
 * 工作目录映射判定用的路径比较。**叶子模块**: 不 import 本目录任何其它文件,
 * 供 dispatcher / recentSessions 共用。
 *
 * 单独拆出来是为了守依赖方向: 别的模块不该为了一个路径比较去 import 纯逻辑的
 * dispatcher —— 那会把 dispatcher 的依赖树(协议包等)拖进它们的加载路径, 也容易
 * 拧出环(PR #733 review 指出)。
 */

import path from 'node:path';

/**
 * target 是否落在 base 目录内(含相等)。Windows 大小写不敏感(规则 15)。
 *
 * 空 / 全空白一律 false: `path.resolve('')` 会变成进程的 cwd, 那样
 * `isPathWithin(cwd 下的某个映射根, '')` 就成了假放行 —— 而空串是真实会出现的
 * 输入(SessionMeta.workDir 在 DB workingDir 为 null 时落成空串, 见
 * maker-host/session-storage.ts)。安全判定在这里 fail closed
 * (PR #733 review 指出)。
 *
 * platform 参数是跨平台测试缝：Node 的默认 path 实现在进程启动时就按宿主系统固定，
 * 只 mock process.platform 并不能切换 path.relative 的大小写语义。
 */
export function isPathWithin(
  base: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (base.trim() === '' || target.trim() === '') return false;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value: string): string => {
    const resolved = pathApi.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const rel = pathApi.relative(normalize(base), normalize(target));
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
}
