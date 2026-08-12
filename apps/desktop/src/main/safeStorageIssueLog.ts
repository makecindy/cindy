/**
 * safeStorage 诊断日志的载荷构造(#871 可观测性)。
 *
 * 不变式:错误只记 code/name,**绝不记 err.message 或任何明文/密文**——fs 错误的
 * message 携带 userData 绝对路径,不该进保留 30 天的日志;密文与解密结果更不落。
 * 抽成纯函数以便回归测试锚死该不变式(#912 review P2)。
 */
export function buildSafeStorageIssueMeta(
  key: string,
  err?: unknown,
): { key: string; error?: string } {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return {
    key,
    ...(err instanceof Error ? { error: typeof code === 'string' ? code : err.name } : {}),
  };
}
