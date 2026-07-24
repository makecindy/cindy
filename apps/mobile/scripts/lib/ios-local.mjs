// 本机冷更(release-ios-local.mjs)的 helper —— 多为纯函数;涉及 IO 的
// fetchBaselineBuildNumber 用可注入的 fetch 依赖,同样便于单测。

/**
 * 从 release-ios.sh 的 stdout 解析安装链接。
 * 脚本会打印 `.../install/<childId>` 与 `itms-services://...`。
 * @returns {{ installUrl: string|null, itmsUrl: string|null, childId: string|null }}
 */
export function parseNpkgInstallLinks(stdout) {
  const text = String(stdout ?? '');
  const install = text.match(/https?:\/\/\S+\/install\/(\S+)/);
  const itms = text.match(/itms-services:\/\/\S+/);
  return {
    installUrl: install ? install[0] : null,
    itmsUrl: itms ? itms[0] : null,
    childId: install ? install[1] : null,
  };
}

/** 语义化 buildNumber 比较(纯数字串按数值,带点按段)。a<b→-1 / a==b→0 / a>b→1。 */
export function compareBuildNumbers(a, b) {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).indexOf('.') < 0 && String(b).indexOf('.') < 0) {
    return na === nb ? 0 : na > nb ? 1 : -1;
  }
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

/**
 * 校验版本号单调递增(相对上一条记录)。previous 为空(首发)则放行。
 * NPKG 靠 md5 去重、覆盖安装靠版本号递增,二者都要求单调。iOS/Android 共用,
 * 故文案不写死平台(iOS=app.json ios.buildNumber;Android=android-version.json versionCode)。
 */
export function assertBuildNumberMonotonic(current, previous) {
  if (!current) throw new Error('缺少版本号(iOS: ios.buildNumber / Android: android-version.json versionCode)');
  if (previous == null || previous === '') return true;
  if (compareBuildNumbers(current, previous) <= 0) {
    throw new Error(`版本号必须大于上一条已发布记录(${current} <= ${previous});请先 bump(iOS: app.json 的 ios.buildNumber / Android: android-version.json 的 versionCode)`);
  }
  return true;
}

/**
 * 读取 CDN 冷更基线记录的 buildNumber —— fail-closed。
 * 只有 404 / 无记录返回 null(合法首发);其它 HTTP 错误、网络错误、JSON 解析失败一律抛错,
 * 避免 CDN 瞬时故障被误判为"首发"而跳过 buildNumber 单调性校验、发出在装用户无法覆盖升级的包。
 * fetch 依赖可注入,便于单测。
 * @param {string} url
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string | number | null>}
 */
export async function fetchBaselineBuildNumber(url, fetchImpl = fetch) {
  // release.json 是可变指针,CDN 边缘会缓存 bare URL:刚发完一版就读可能拿到旧(更低)buildNumber,
  // 让单调校验对着陈旧值通过、放出装不上的包。加 ?t= cache-bust + no-cache(同 OTA 指针读取处理)。
  const bustedUrl = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  let res;
  try {
    res = await fetchImpl(bustedUrl, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  } catch (err) {
    throw new Error(`读取冷更基线失败(网络错误 ${url}):${err?.message ?? err};无法确认 buildNumber 单调性,已中止(确认是首发/CDN 不可达可加 --skip-record 或人工核对)`);
  }
  if (res.status === 404) return null;                       // 真·首发:无记录
  if (!res.ok) {
    throw new Error(`读取冷更基线失败(HTTP ${res.status} ${url});fail-closed 中止(避免瞬时故障被当成首发)`);
  }
  let record;
  try {
    record = await res.json();
  } catch (err) {
    throw new Error(`冷更基线 JSON 解析失败(${url}):${err?.message ?? err};fail-closed 中止`);
  }
  // 记录存在(200)但缺 buildNumber = 损坏/不完整记录:也 fail-closed,否则会被当成"首发"
  // 而跳过 buildNumber 单调校验(buildReleaseRecord 总会写 buildNumber,缺失即异常)。
  const buildNumber = record?.buildNumber;
  if (buildNumber == null || buildNumber === '') {
    throw new Error(`冷更基线记录存在但缺 buildNumber(${url});记录可能损坏/不完整,fail-closed 中止(确认无误可加 --skip-record 或人工核对)`);
  }
  return buildNumber;
}

/**
 * 计算下一个 iOS 冷更 buildNumber(日期基 YYYYMMDDNN 约定,如 2026070601)。
 * 取「今天的 YYYYMMDD01」与「max(current, previous) + 1」中的较大者:
 *  - 当天首次冷更 → YYYYMMDD01;同天再次冷更 → 末两位序号递增;
 *  - 基线比今天的日期基还大(旧线遗留大号 / 时钟偏差)→ 直接 +1,永远保证单调。
 * 只接受纯数字串(app.json 既有约定);带点等非数字格式抛错回退手动 bump,不静默产出错误版号。
 * @param {string|number|null} current 本地 app.json 当前值(可为空)
 * @param {string|number|null} previous 线上冷更基线值(可为空 = 首发)
 * @param {Date} [now] 可注入,便于单测
 * @returns {string}
 */
export function nextDateBuildNumber(current, previous, now = new Date()) {
  const floors = [current, previous]
    .filter((v) => v != null && v !== '')
    .map((v) => {
      if (!/^\d+$/.test(String(v))) {
        throw new Error(`无法自动 bump:版本号 ${JSON.stringify(String(v))} 不是纯数字串,请手动 bump 后重试`);
      }
      return Number(v);
    });
  const dateBase = Number(
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}01`,
  );
  const floor = floors.length ? Math.max(...floors) : null;
  return String(floor == null || dateBase > floor ? dateBase : floor + 1);
}

/**
 * 在 app.json 原文上就地替换 ios.buildNumber —— 纯字符串替换而非 parse→stringify,
 * 保证文件其余部分(缩进 / 键序 / 尾换行)零改动、diff 只有一行。
 * 要求全文恰好一处 "buildNumber"(当前 app.json 即如此);0 处或多处一律抛错防误替换。
 * @param {string} rawText app.json 原文
 * @param {string} nextBuildNumber 纯数字串
 * @returns {string}
 */
export function replaceBuildNumberInAppJson(rawText, nextBuildNumber) {
  if (!/^\d+$/.test(String(nextBuildNumber))) {
    throw new Error(`replaceBuildNumberInAppJson:新 buildNumber 必须是纯数字串,收到 ${JSON.stringify(nextBuildNumber)}`);
  }
  const matches = String(rawText).match(/"buildNumber"\s*:\s*"[^"]*"/g) ?? [];
  if (matches.length !== 1) {
    throw new Error(`app.json 中 "buildNumber" 出现 ${matches.length} 处(期望恰好 1 处),拒绝自动替换,请手动 bump`);
  }
  return String(rawText).replace(/("buildNumber"\s*:\s*")[^"]*(")/, `$1${nextBuildNumber}$2`);
}

/** xcodebuild -exportArchive 支持的分发方式;缺省 development 与旧发布线一致(产物交发布方重签)。 */
export const IOS_EXPORT_METHODS = Object.freeze(['development', 'ad-hoc', 'enterprise', 'app-store']);

/**
 * 解析 iOS 本地签名描述符(供 xcodebuild archive/export 消费)。
 * iOS 签名不含任何机密(无口令),故 teamId / profileName / signIdentity / profilePath **全部从
 * 按 region 的 self-host-regions.json 的 iosSigning 取值**(纯值、非机密、不入仓,详见 self-host-region.mjs)。
 * teamId / profileName / signIdentity 缺任一即抛错(fail-closed);profilePath 可选
 * (空 = 假设描述文件已装入 ~/Library/MobileDevice/Provisioning Profiles)。
 * signIdentity 只接受**完整证书通用名**("<类型>: <名字> (<ID>)",末尾括号 ID 不能省)
 * 或 40 位 SHA-1:裸类型名("Apple Development")对 xcodebuild 是自动选择器,掐掉 ID 的
 * 部分名("Apple Development: Jane Doe")走 CODE_SIGN_IDENTITY 子串匹配同样有歧义,
 * 多证书钥匙串下都钉不住证书,必须在预检就拒掉(security find-identity -v -p codesigning 可查完整名)。
 * 签名套件本体(profile + p12)在打包机的仓库外目录,不入仓。
 * exportMethod 可选:xcodebuild -exportArchive 的分发方式,白名单校验,留空默认
 * development(与旧发布线一致,产物交发布方重签)。
 * @param {{ authRegion?: string, iosSigning?: { teamId?: string, profileName?: string, signIdentity?: string, profilePath?: string, exportMethod?: string } }} regionConfig
 * @returns {{ teamId: string, profileName: string, identity: string, profilePath: string, exportMethod: string }}
 */
export function resolveIosSigningEnv(regionConfig) {
  const s = regionConfig?.iosSigning ?? {};
  const region = regionConfig?.authRegion ?? '?';
  const teamId = String(s.teamId ?? '').trim();
  const profileName = String(s.profileName ?? '').trim();
  const identity = String(s.signIdentity ?? '').trim();
  const profilePath = String(s.profilePath ?? '').trim();
  const exportMethod = String(s.exportMethod ?? '').trim() || 'development';
  if (!IOS_EXPORT_METHODS.includes(exportMethod)) {
    throw new Error(
      `self-host-regions.json 的 ${region}.iosSigning.exportMethod 只能是 ${IOS_EXPORT_METHODS.join(' / ')}(留空默认 development),收到 ${JSON.stringify(exportMethod)}`,
    );
  }
  const missing = [];
  if (!teamId) missing.push('teamId');
  if (!profileName) missing.push('profileName');
  if (!identity) missing.push('signIdentity');
  if (missing.length) {
    throw new Error(
      `self-host-regions.json 的 ${region}.iosSigning 缺少非空字段:${missing.join(', ')}(iOS 签名描述符从 region JSON 取值,非机密;profilePath 可选,缺省视为描述文件已装入系统)`,
    );
  }
  const isSha1 = /^[0-9A-Fa-f]{40}$/.test(identity);
  // 完整证书通用名固定形如 "<类型>: <名字> (<ID>)",末尾括号 ID 必须在:只查冒号会放过
  // "Apple Development: Jane Doe" 这类掐掉 ID 的部分名——它同样是模糊匹配,钉不住。
  const isFullName = /^.+: .+ \([A-Z0-9]{4,}\)$/.test(identity);
  if (!isSha1 && !isFullName) {
    throw new Error(
      `self-host-regions.json 的 ${region}.iosSigning.signIdentity 必须是完整证书名(形如 "Apple Development: 姓名 (TEAMID)",末尾括号 ID 不能省)或 40 位 SHA-1,收到 ${JSON.stringify(identity)}——裸类型名/部分名对 xcodebuild 是自动选择器或模糊匹配,多证书钥匙串下钉不住证书(完整名用 security find-identity -v -p codesigning 查)`,
    );
  }
  return { teamId, profileName, identity, profilePath, exportMethod };
}

/** plist <string> 值的 XML 转义(证书名等来自配置的外部输入,防意外特殊字符产出坏 plist)。 */
function escapePlistString(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 生成 xcodebuild -exportArchive 用的 ExportOptions.plist(development 方法 + 手动签名)。
 * signingCertificate:钉死 export 阶段用的签名证书。打包机钥匙串里常存在多张
 * "Apple Development" 证书,manual 签名不钉证书时 xcodebuild 会自选,可能挑到
 * 不在 profile 里的那张导致 EXPORT FAILED。传该区域自己的 iosSigning.signIdentity
 * (与 archive 的 CODE_SIGN_IDENTITY 同一张);不传时输出与旧版完全一致。
 */
export function buildExportOptionsPlist({ teamId, bundleId, profileName, signingCertificate, method = 'development' }) {
  if (!teamId || !bundleId || !profileName) {
    throw new Error('buildExportOptionsPlist requires teamId / bundleId / profileName');
  }
  const signingCertificateEntry = signingCertificate
    ? `
    <key>signingCertificate</key>
    <string>${escapePlistString(signingCertificate)}</string>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>${method}</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>teamID</key>
    <string>${teamId}</string>${signingCertificateEntry}
    <key>provisioningProfiles</key>
    <dict>
        <key>${bundleId}</key>
        <string>${profileName}</string>
    </dict>
    <key>compileBitcode</key>
    <false/>
    <key>stripSwiftSymbols</key>
    <true/>
</dict>
</plist>
`;
}

/** 组装写入 CDN 的整包版本记录(/latest 返回体)。 */
export function buildReleaseRecord({ version, buildNumber, runtimeVersion, installUrl, itmsUrl, releaseNotes, minVersion }) {
  if (!runtimeVersion) throw new Error('buildReleaseRecord requires runtimeVersion');
  if (!installUrl && !itmsUrl) throw new Error('buildReleaseRecord requires installUrl or itmsUrl');
  const record = {
    version: version ?? '',
    buildNumber: buildNumber ?? '',
    runtimeVersion,
    installUrl: installUrl ?? '',
    itmsUrl: itmsUrl ?? '',
  };
  if (releaseNotes) record.releaseNotes = releaseNotes;
  if (minVersion) record.minVersion = minVersion;
  return record;
}

/**
 * 地区 App Store 数字 ID → 网页地址 + 直接拉起 App Store 的 deep link。
 * release.json 同时保留两个字段以兼容现有客户端契约；客户端优先打开 itmsUrl。
 */
export function buildAppStoreInstallLinks(appStoreId) {
  const id = String(appStoreId ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error('buildAppStoreInstallLinks requires numeric App Store ID');
  return {
    installUrl: `https://apps.apple.com/app/id${id}`,
    itmsUrl: `itms-apps://itunes.apple.com/app/id${id}`,
  };
}

/**
 * 按安装入口模式(见 self-host-region.resolveIosInstallEntryMode)选出写进 release record 的安装链接:
 *   - appstore：由数字 App Store ID 生成商店网页 + deep link;
 *   - enterprise：直接用 NPKG 企业重签后上传 OSS 的安装页 + itms-services 链接(dev 无上架商店时)。
 * 在此按 mode 分支,避免把空 App Store ID 喂进 buildAppStoreInstallLinks(它对空值 fail closed)。
 * @param {{ mode: 'appstore' | 'enterprise', appStoreId?: string }} entry
 * @param {{ installUrl?: string, itmsUrl?: string }} enterpriseLinks 企业重签上传 OSS 后的安装页/itms 链接
 */
export function selectRecordInstallLinks(entry, enterpriseLinks) {
  if (entry?.mode === 'enterprise') {
    const installUrl = String(enterpriseLinks?.installUrl ?? '').trim();
    const itmsUrl = String(enterpriseLinks?.itmsUrl ?? '').trim();
    if (!installUrl && !itmsUrl) {
      throw new Error('企业重签安装入口缺少 installUrl/itmsUrl(NPKG 重签上传未产出安装页?)');
    }
    return { installUrl, itmsUrl };
  }
  return buildAppStoreInstallLinks(entry?.appStoreId);
}
