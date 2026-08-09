/**
 * 对外模型代理「写配置预览」交给 renderer 前的密文掩码(#1666 Finding E + 二轮 Finding F)。
 *
 * 安全约束(勿改):写配置预览纯展示,不需要也**绝不**把任何密文明文带过 IPC 边界。
 * 真实明文只在 main 侧落文件(`writeExternalConfig`)/ 落剪贴板(`copy-*` 通道);预览里凡是
 * 等于对外 token 的段一律换成 token 掩码。`assertTrustedAppRendererEvent` 只验来源帧、不验
 * 用户手势,所以哪怕来源可信也不把明文交给可能被注入的渲染进程。
 *
 * 二轮 Finding F:冲突项的 `current` 是**用户自己既有的值**——当 key 是密文型环境变量
 * (如 `ANTHROPIC_API_KEY` 里用户原本填的真 key)时,它同样是密文,若原样过 IPC 就等于把用户
 * 现有的 Claude key 泄漏给渲染进程。故除对外 token 外,任何密文型 key 的 current/next 非空值
 * 一律再兜底掩掉(用不含 token 前缀的通用占位,以示这不是我们的 token)。
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
 * 判定一个环境变量名是否承载密文。宁可多掩不可漏掩:名字里含 KEY/TOKEN/SECRET 一律视为密文。
 * `ANTHROPIC_BASE_URL` 这类非密文 key 不命中,原样展示。
 */
function isSecretEnvKey(key: string): boolean {
  return /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key);
}

/**
 * 把 Anthropic 写配置预览里的密文段替换成掩码。规则:
 *   - 等于对外 token 的段 → token 掩码 `masked`(带 `cindy-local-` 前缀,示意是我们生成的)。
 *   - 密文型 key(见 `isSecretEnvKey`)上其余非空值(尤其是用户既有的真 key)→ 通用占位
 *     `MASK_FALLBACK`,绝不原样过 IPC(Finding F)。
 *   - 其余(base_url 等非密文段)→ 原样保留。
 */
export function maskAnthropicPreview(
  preview: LocalProxyConfigPreview,
  token: string,
  masked: string,
): LocalProxyConfigPreview {
  const scrub = (key: string, v: string): string => {
    if (token.length > 0 && v === token) return masked;
    if (v.length > 0 && isSecretEnvKey(key)) return MASK_FALLBACK;
    return v;
  };
  const proposedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(preview.proposedEnv)) proposedEnv[k] = scrub(k, v);
  return {
    ...preview,
    proposedEnv,
    conflicts: preview.conflicts.map((c) => ({
      key: c.key,
      current: scrub(c.key, c.current),
      next: scrub(c.key, c.next),
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
