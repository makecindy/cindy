// =============================================================================
// package-lib.mjs — 桌面端打包(package-desktop.mjs)的纯逻辑层
//
// 只放无副作用、可被 node --test 直接覆盖的函数:参数解析、版本解析、
// 产物目录/文件命名、build-info 组装。所有 IO(forge / 签名 / 拷贝 / 网络)
// 留在 package-desktop.mjs 编排层。
// =============================================================================

/** 版本无关打包写入 package.json / APP_VERSION 的占位版本。
 *  必须保持纯数字段(NSIS / rcedit 的 PE FileVersion 只接受数字),且与
 *  CDN manifest 的「无有效版本」哨兵 '0.0.0' 同值——updateService 据此
 *  (isVersionlessAppVersion)禁用热更新,开源社区拉仓打的包不会被线上
 *  manifest 拉去自更。 */
export const VERSIONLESS_VERSION = '0.0.0';

export const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
export const SUPPORTED_REGIONS = Object.freeze(['cn', 'global', 'dev']);
const VERSION_BUMP_KINDS = Object.freeze(['major', 'minor', 'patch']);

export const PLATFORM_ARCHS = Object.freeze({
  win32: ['x64'],
  darwin: ['arm64', 'x64'],
  // linux 两个架构都能打,但都只能在对应架构的机器上打:与 darwin 不同,缺省不
  // 连打双架构,显式 --arch 也必须等于宿主 arch(两条都由 parsePackageArgs 强制)。
  // 交叉打包不可行——原生模块(better-sqlite3 / node-pty)要按目标 arch 重编,
  // sqlite-vec 的 vec0.so 也是预编译平台件。
  linux: ['x64', 'arm64'],
});

/**
 * node arch → Debian 包架构名(deb 文件名与 control 的 Architecture 字段用它)。
 * 必须与 @electron-forge/maker-deb 的同名函数保持一致:归集产物时要按 maker
 * 实际写出的文件名命名,错了会把 arm64 包标成 amd64,用户装上直接起不来。
 * 当前实际打的只有 linux 的 x64/arm64,其余分支保持与 maker-deb 同构(将来扩
 * 架构时不必回头改映射);未知 arch 原样返回。
 */
export function debianArch(nodeArch) {
  switch (nodeArch) {
    case 'x64':
      return 'amd64';
    case 'ia32':
      return 'i386';
    case 'armv7l':
      return 'armhf';
    case 'arm':
      return 'armel';
    default:
      return nodeArch;
  }
}

/** x.y.z 显式版本(不接受前缀 v / 预发布后缀——发布版本号是 CDN 比较键,保持纯净)。 */
export function isExplicitVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

/**
 * 解析 package-desktop.mjs 的命令行参数。非法输入直接 throw(编排层统一打印)。
 * 返回的 archs 是数组:显式 --arch 只打单架构;缺省时 darwin 双架构连打
 * (发布侧 canary/promote 对 mac 默认就是双架构,打包侧对齐),其它平台单 arch。
 * linux 额外要求目标 arch 等于宿主 arch——见下方 archFlag 分支的理由。
 * @param {string[]} argv  process.argv.slice(2)
 * @param {{ platform?: string, arch?: string }} [defaults]  默认取当前机器
 */
export function parsePackageArgs(argv, defaults = {}) {
  const out = {
    platform: defaults.platform ?? process.platform,
    region: 'global',
    versionSpec: null,
    skipSmoke: false,
    allowUnsigned: false,
    noSign: false,
  };
  let archFlag = null;
  let regionSpecified = false;
  const takeValue = (flag, i) => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      // pnpm 会把 `pnpm release:package -- --region cn` 里的 `--` 原样透传给脚本
      // (pnpm 10 对 run-script 参数不做剥离),裸 `--` 按分隔符跳过。
      case '--': break;
      case '--platform': out.platform = takeValue(a, i); i++; break;
      case '--arch': archFlag = takeValue(a, i); i++; break;
      case '--region':
        if (regionSpecified) throw new Error('--region 只能传一次');
        regionSpecified = true;
        out.region = takeValue(a, i);
        i++;
        break;
      case '--version': out.versionSpec = takeValue(a, i); i++; break;
      case '--skip-smoke': out.skipSmoke = true; break;
      case '--allow-unsigned': out.allowUnsigned = true; break;
      // 主动跳过签名(即使签名配置在手)。外部签名命令依赖发布方自己的构建
      // 环境,不具备该环境的机器打版本无关包时用它;与 --allow-unsigned
      // (放行"缺配置")语义互补。
      case '--no-sign': out.noSign = true; out.allowUnsigned = true; break;
      default:
        throw new Error(`未知参数: ${a}(支持 --platform/--arch/--region/--version/--skip-smoke/--allow-unsigned/--no-sign)`);
    }
  }

  if (!SUPPORTED_PLATFORMS.includes(out.platform)) {
    throw new Error(`不支持的 platform: ${out.platform}(可选 ${SUPPORTED_PLATFORMS.join('/')})`);
  }
  const supportedArchs = PLATFORM_ARCHS[out.platform];
  const hostArch = defaults.arch ?? process.arch;
  if (archFlag !== null) {
    if (!supportedArchs.includes(archFlag)) {
      throw new Error(`platform ${out.platform} 不支持 arch: ${archFlag}(可选 ${supportedArchs.join('/')})`);
    }
    // linux 跨架构必须在参数层就拒。放行只会把失败推迟到 forge 的原生模块
    // rebuild:普通构建机没有交叉编译工具链,烧掉整个 package 阶段才吐一堆
    // 编译错误;而带 --skip-smoke 时连启动校验都不剩,能静默产出一个跑不起来
    // 的 deb。darwin 不受此限——Rosetta 2 让 Apple Silicon 主机能打并 smoke
    // darwin-x64,那是经验证的支持路径。
    if (out.platform === 'linux' && archFlag !== hostArch) {
      throw new Error(
        `linux 不支持交叉打包(当前 ${hostArch},目标 ${archFlag});请在目标架构的机器上执行。`,
      );
    }
    out.archs = [archFlag];
  } else if (out.platform === 'darwin') {
    // mac 缺省双架构连打:Apple Silicon 主机经 Rosetta 2 能跑 darwin-x64,
    // smoke test 同样可过(老一体式 release-macos.mjs 验证过的模式)。
    out.archs = [...PLATFORM_ARCHS.darwin];
  } else {
    if (!supportedArchs.includes(hostArch)) {
      throw new Error(`platform ${out.platform} 不支持 arch: ${hostArch}(可选 ${supportedArchs.join('/')})`);
    }
    out.archs = [hostArch];
  }
  if (!SUPPORTED_REGIONS.includes(out.region)) {
    throw new Error(`不支持的 region: ${out.region}(可选 ${SUPPORTED_REGIONS.join('/')})`);
  }
  if (out.versionSpec !== null && !regionSpecified) {
    throw new Error('版本化打包必须显式传 --region cn、global 或 dev');
  }
  if (
    out.versionSpec !== null &&
    !VERSION_BUMP_KINDS.includes(out.versionSpec) &&
    !isExplicitVersion(out.versionSpec)
  ) {
    throw new Error(`非法 --version: ${out.versionSpec}(可选 x.y.z / major / minor / patch)`);
  }
  return out;
}

/** major/minor/patch bump。baseline 必须是合法 x.y.z。 */
export function bumpVersion(baseline, kind) {
  if (!isExplicitVersion(baseline)) {
    throw new Error(`CDN 基线版本非法: ${baseline}`);
  }
  const [major, minor, patch] = baseline.split('.').map(Number);
  switch (kind) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default: throw new Error(`未知 bump 类型: ${kind}`);
  }
}

/**
 * 解析最终打包版本。
 * - null → 版本无关(占位 0.0.0,包不参与热更新);
 * - x.y.z → 原样;
 * - major/minor/patch → 调 fetchBaseline()(只读拉 CDN 当前版本)后 bump。
 *   只有 bump 关键字才联网——这是打包阶段仅存的 CDN 依赖。
 * @param {string|null} versionSpec
 * @param {() => Promise<string>} fetchBaseline
 * @returns {Promise<{ version: string, versionless: boolean }>}
 */
export async function resolvePackageVersion(versionSpec, fetchBaseline) {
  if (versionSpec === null) {
    return { version: VERSIONLESS_VERSION, versionless: true };
  }
  if (isExplicitVersion(versionSpec)) {
    if (versionSpec === VERSIONLESS_VERSION) {
      throw new Error(`--version ${VERSIONLESS_VERSION} 是版本无关占位符,不能作为发布版本;要打版本无关包直接省略 --version`);
    }
    return { version: versionSpec, versionless: false };
  }
  const baseline = await fetchBaseline();
  if (!baseline || baseline === VERSIONLESS_VERSION) {
    throw new Error(`CDN manifest 没有有效基线版本(got "${baseline}"),无法 ${versionSpec} bump;请显式传 --version x.y.z`);
  }
  return { version: bumpVersion(baseline, versionSpec), versionless: false };
}

/** 产物目录(相对 apps/desktop/release/):artifacts/<region>/<version|unversioned>/<platformKey> */
export function artifactRelDir({ region, version, versionless, platformKey }) {
  const versionSeg = versionless ? 'unversioned' : version;
  return ['artifacts', region, versionSeg, platformKey].join('/');
}

/**
 * 新渠道产物文件基名(老 release 脚本的 xdt-maker-* 命名不动,新产物统一
 * cindy-*)。两区同名(owner 决策):发布渠道靠不同 OSS bucket 区分,本地
 * 产物已按 artifactRelDir 的 `<region>/` 目录分层,文件名不再
 * 叠区域前缀。
 */
export function artifactBaseName({ version, versionless }) {
  return `cindy-${versionless ? 'unversioned' : version}`;
}

/**
 * 组装 build-info.json 内容(发布侧未来只读它决定上传什么)。
 * 所有字段由编排层收集后传入,本函数保持纯组装。
 * @param {{
 *   version: string, versionless: boolean, region: string,
 *   platform: string, arch: string, commitSha: string, electronVersion: string,
 *   schemaVersionMax: number, migrationFiles: string[],
 *   files: Array<{ role: string, name: string, sha256: string, size: number }>,
 *   signing: Record<string, unknown>,
 * }} ctx
 */
export function buildBuildInfo(ctx) {
  return {
    // v2 移除无运行语义的 package channel；发布通道只属于 publish 阶段。
    schemaVersion: 2,
    product: 'cindy-desktop',
    // 版本无关包 version 记 null,占位符不冒充真实版本。
    version: ctx.versionless ? null : ctx.version,
    versionless: ctx.versionless,
    region: ctx.region,
    platform: ctx.platform,
    arch: ctx.arch,
    platformKey: `${ctx.platform}-${ctx.arch}`,
    commitSha: ctx.commitSha,
    buildTime: new Date().toISOString(),
    nodeVersion: process.version,
    electronVersion: ctx.electronVersion,
    schemaVersionMax: ctx.schemaVersionMax,
    migrationFiles: ctx.migrationFiles,
    files: ctx.files,
    signing: ctx.signing,
  };
}
