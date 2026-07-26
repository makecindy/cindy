/** 本地 mobile 开发允许选择的地区；未显式指定时统一使用 Global。 */
export const MOBILE_DEV_REGIONS = Object.freeze(['cn', 'global', 'dev']);
export const LOCAL_MOBILE_REGION_CONFIG_ENV_KEY = 'CINDY_USE_LOCAL_REGION_CONFIG';

/** 本地 Xcode / Simulator 构建统一从 self-host-regions.json 读取地区配置。 */
export function withLocalMobileRegionConfig(env) {
  return { ...env, [LOCAL_MOBILE_REGION_CONFIG_ENV_KEY]: '1' };
}

export const DEFAULT_MOBILE_DEV_REGION = 'global';

/**
 * 从本地开发命令参数中提取 `--region`，并把其它参数原样交还调用方。
 * `pnpm` 可能把参数分隔符 `--` 透传进来，这个无业务语义的 token 会被忽略。
 *
 * @param {string[]} argv
 * @returns {{ region: 'cn' | 'global' | 'dev', passthrough: string[] }}
 */
export function extractMobileDevRegionArgs(argv) {
  let region;
  let regionSpecified = false;
  const passthrough = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--region') {
      if (regionSpecified) throw new Error('--region 只能传一次');
      regionSpecified = true;
      region = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--region=')) {
      if (regionSpecified) throw new Error('--region 只能传一次');
      regionSpecified = true;
      region = arg.slice('--region='.length);
      continue;
    }
    passthrough.push(arg);
  }

  const normalizedRegion = regionSpecified ? region?.trim() : DEFAULT_MOBILE_DEV_REGION;
  if (!MOBILE_DEV_REGIONS.includes(normalizedRegion)) {
    throw new Error(
      `--region 只能是 ${MOBILE_DEV_REGIONS.join(' 或 ')},收到: ${normalizedRegion || '(空)'}`,
    );
  }
  return { region: normalizedRegion, passthrough };
}
