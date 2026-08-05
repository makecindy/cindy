/**
 * 对外模型代理「写配置预览」交给 renderer 前的 token 掩码(#1666 Finding E)。
 *
 * 安全约束(勿改):写配置预览纯展示,不需要也**绝不**把对外 token 明文带过 IPC 边界。
 * 真实明文只在 main 侧落文件(`writeExternalConfig`)/ 落剪贴板(`copy-*` 通道);预览里凡是
 * 等于 token 的段一律换成掩码。`assertTrustedAppRendererEvent` 只验来源帧、不验用户手势,
 * 所以哪怕来源可信也不把明文交给可能被注入的渲染进程。
 *
 * 纯函数、无 electron / 无 IO 依赖 —— 单测可直接 import(见 __tests__/preview-masking.test.ts)。
 */

import type {
  LocalProxyCodexConfigPreview,
  LocalProxyConfigPreview,
} from '../../shared/localProxyService.js';

/** token 拿不到掩码时的兜底占位(不泄漏长度/内容)。 */
export const MASK_FALLBACK = '••••••••';

/**
 * 把 Anthropic 写配置预览里的 token 段替换成掩码。`proposedEnv.ANTHROPIC_API_KEY` 与任何
 * 取值等于 token 的冲突项(current/next)都会被掩掉,其余原样保留。
 */
export function maskAnthropicPreview(
  preview: LocalProxyConfigPreview,
  token: string,
  masked: string,
): LocalProxyConfigPreview {
  const scrub = (v: string): string => (token.length > 0 && v === token ? masked : v);
  const proposedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(preview.proposedEnv)) proposedEnv[k] = scrub(v);
  return {
    ...preview,
    proposedEnv,
    conflicts: preview.conflicts.map((c) => ({
      key: c.key,
      current: scrub(c.current),
      next: scrub(c.next),
    })),
  };
}

/**
 * codex 预览的 `proposedToml` 本就不含 token(codex 从 `env_key` 读),只 `tokenExportLine`
 * 带明文 —— 掩码它;真实明文走 `copy-codex-token-export` 剪贴板通道。
 */
export function maskCodexPreview(
  preview: LocalProxyCodexConfigPreview,
  token: string,
  masked: string,
): LocalProxyCodexConfigPreview {
  return {
    ...preview,
    tokenExportLine:
      token.length > 0
        ? preview.tokenExportLine.split(token).join(masked)
        : preview.tokenExportLine,
  };
}
