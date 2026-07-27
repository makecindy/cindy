import { dirname, join } from 'node:path';
import { extractMobileDevRegionArgs, MOBILE_DEV_REGIONS } from './mobile-dev-region.mjs';

export const MOBILE_XCODE_REGIONS = MOBILE_DEV_REGIONS;

/**
 * 解析 mobile:xcode 参数。未显式指定 region 时与其它本地 mobile 入口一样默认 global。
 */
export function parseMobileXcodeArgs(argv) {
  const { region, passthrough } = extractMobileDevRegionArgs(argv);
  const help = passthrough.some((arg) => arg === '--help' || arg === '-h');
  const unknown = passthrough.filter((arg) => arg !== '--help' && arg !== '-h');
  if (unknown.length) throw new Error(`未知参数: ${unknown[0]}`);
  return { help, region };
}

/**
 * 把地区构建身份持久化到 apps/mobile/.env。这样命令打开 Xcode 后，后续单独启动的
 * Metro 仍会用同一地区，不会出现 native 是 global、JS 却从 cn 配置编译的错配。
 */
export function updateMobileXcodeEnvContent(content, values) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  let lines = content ? content.split(/\r?\n/) : [];

  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    let replaced = false;
    lines = lines.filter((line) => {
      if (!pattern.test(line)) return true;
      if (replaced) return false;
      replaced = true;
      return true;
    }).map((line) => {
      if (!pattern.test(line)) return line;
      return `${key}=${value}`;
    });
    if (!replaced) lines.push(`${key}=${value}`);
  }

  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return `${lines.join(newline)}${newline}`;
}

/** 从 ios/ 顶层候选中选择 app workspace，排除 CocoaPods 自己的 workspace。 */
export function selectMobileXcodeWorkspace(iosDir, entries) {
  const candidates = entries
    .filter((entry) => entry.endsWith('.xcworkspace') && entry !== 'Pods.xcworkspace')
    .sort();
  if (candidates.length === 0) {
    throw new Error(`prebuild 后未在 ${iosDir} 找到 app .xcworkspace`);
  }
  if (candidates.length > 1) {
    throw new Error(`在 ${iosDir} 找到多个 app workspace，无法确定要打开哪个: ${candidates.join(', ')}`);
  }
  return join(iosDir, candidates[0]);
}

/** 返回 workspace 所属的生成目录，供调用端输出紧凑提示。 */
export function mobileXcodeGeneratedDir(workspacePath) {
  return dirname(workspacePath);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
