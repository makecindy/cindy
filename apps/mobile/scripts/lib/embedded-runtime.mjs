// =============================================================================
// embedded-runtime.mjs —— 从冷更构建产物里回读“真正烤进包的 runtimeVersion”
//
// 背景 / 为什么必须读产物而非现算:
//   runtimeVersion 策略是 fingerprint(app.json `runtimeVersion.policy: "fingerprint"`)。
//   expo-updates 在 gradle / xcodebuild 构建时用 @expo/fingerprint 算出 hash,写进产物内的
//   `fingerprint` 文件(Android: APK 内 assets/fingerprint;iOS: app 内 EXUpdates.bundle/fingerprint,
//   即 EXUpdates pod 的 resource_bundle,运行时 UpdatesConfig.swift 从 EXUpdates.bundle 读它),
//   运行时客户端就读这个文件当作自己的 runtimeVersion,再拿去和服务端 release.json 比对——
//   不一致就弹整包更新。
//
//   坑:发版脚本若用 `expo-updates fingerprint:generate` 独立“现算”一次写进 release.json,
//   这个 CLI 会把已生成的 android/ (bareNativeDir) 也纳入哈希,而 android/ 在 prebuild --clean /
//   gradle 构建各阶段内容都在变,导致现算值与真正烤进包的内嵌值不同 → 装了最新包仍反复弹整包更新。
//   因此权威值只能是“产物里内嵌的那个”:构建完成后从产物回读,保证 release.json == 装机包内嵌值。
//
// 说明:这些解压走系统 CLI(APK / IPA 都是 zip):优先 Info-ZIP `unzip`(macOS 自带),
//   缺失时回退 bsdtar `tar`(Windows 10+ / macOS 均系统自带)。release-ios-local 强制 darwin,
//   但 release-android-local 支持在 Windows 跑(脚本内有 gradlew.bat / aapt2.exe 等 win32 分支),
//   不能假设 unzip 存在;两个工具都缺才抛错。
// =============================================================================

import { spawnSync } from 'node:child_process';

// fingerprint 是 @expo/fingerprint 的 SHA1 摘要 = 40 位十六进制。校验并归一化(小写)。
// 纯函数,便于单测;非法值抛错(源信息拼进 message 方便定位)。
export function normalizeFingerprintHash(raw, { source } = {}) {
  const value = String(raw ?? '').trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    const shown = JSON.stringify(String(raw ?? '')).slice(0, 80);
    throw new Error(
      `从${source ?? '构建产物'}读到的 runtimeVersion 不是合法 fingerprint(期望 40 位十六进制,实际 ${shown})`,
    );
  }
  return value.toLowerCase();
}

// 从 .ipa 的 zip 条目清单里挑出 EXUpdates.bundle 内的 fingerprint 文件 —— 这才是 iOS 运行时
// (UpdatesConfig.swift 的 `file:fingerprint` sentinel)实际读取的位置,不是 app 根。
// EXUpdates.bundle 是 EXUpdates pod 的 resource_bundle:静态链接下拷到 app 根
// (Payload/<App>.app/EXUpdates.bundle/fingerprint),动态 framework 下可能更深,故按任意层级匹配;
// 兼容 macOS 风格 bundle 的 Contents/Resources 布局。多个命中取最浅路径(app 根那份)保证确定性。
// 纯函数,便于单测。
export function pickIpaFingerprintEntry(entryNames) {
  const re = /(^|\/)EXUpdates\.bundle\/(Contents\/Resources\/)?fingerprint$/;
  const hits = (entryNames ?? []).filter((name) => re.test(name))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  if (hits.length === 0) {
    throw new Error('.ipa 内未找到 EXUpdates.bundle/fingerprint(该包可能不是 fingerprint 运行时策略构建的)');
  }
  return hits[0];
}

// 先 unzip、缺失回退 bsdtar 执行一条"读 zip"命令,返回 spawnSync 结果;两个工具都缺才抛错。
// bsdtar 的 zip 支持覆盖这里的只读用法(-xOf 抽条目到 stdout / -tf 列条目名)。
function spawnZipTool(unzipArgs, tarArgs, maxBuffer) {
  let r = spawnSync('unzip', unzipArgs, { encoding: 'utf8', maxBuffer });
  if (r.error?.code === 'ENOENT') {
    r = spawnSync('tar', tarArgs, { encoding: 'utf8', maxBuffer });
    if (r.error?.code === 'ENOENT') {
      throw new Error('未找到 unzip 也未找到 tar(读构建产物内嵌 fingerprint 需要其一;macOS 自带 unzip,Windows 10+ 自带 tar)');
    }
  }
  return r;
}

// 解压出 zip 内单个条目的文本内容(stdout)。工具缺失 / 条目不存在都抛清晰错误。
function unzipEntryText(zipPath, entry) {
  const r = spawnZipTool(['-p', zipPath, entry], ['-xOf', zipPath, entry], 8 * 1024 * 1024);
  if (r.status !== 0) throw new Error(`读取 zip 条目失败(${zipPath} :: ${entry}):${r.stderr || `exit ${r.status}`}`);
  return r.stdout ?? '';
}

// 列出 zip 全部条目名(每行一个)。用于在 .ipa 里定位带通配 App 名的 fingerprint 条目。
function listZipEntries(zipPath) {
  const r = spawnZipTool(['-Z1', zipPath], ['-tf', zipPath], 32 * 1024 * 1024);
  // unzip -Z1 / tar -tf 对空 / 截断 / 非法 zip 也返回非 0;明确提示"可能是产物损坏或截断"便于排查。
  if (r.status !== 0) throw new Error(`列出 zip 条目失败(${zipPath},可能是产物损坏 / 截断 / 非 zip):${r.stderr || `exit ${r.status}`}`);
  const entries = (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error(`产物内无任何条目(${zipPath}),疑似空包 / 截断:无法读取内嵌 fingerprint`);
  return entries;
}

// Android:读 APK 内嵌 assets/fingerprint —— 客户端运行时实际使用的 runtimeVersion。
export function readEmbeddedRuntimeVersionFromApk(apkPath) {
  const text = unzipEntryText(apkPath, 'assets/fingerprint');
  return normalizeFingerprintHash(text, { source: `APK 内嵌 assets/fingerprint(${apkPath})` });
}

// Android App Bundle:base module 的 assets 位于 base/assets/。Google Play 最终拆包时
// 会把该文件放回 base APK 的 assets/fingerprint,与直接构建 APK 的运行时读取位置一致。
export function readEmbeddedRuntimeVersionFromAab(aabPath) {
  const text = unzipEntryText(aabPath, 'base/assets/fingerprint');
  return normalizeFingerprintHash(text, { source: `AAB 内嵌 base/assets/fingerprint(${aabPath})` });
}

// iOS:读 .ipa 内 Payload/<App>.app/fingerprint —— 客户端运行时实际使用的 runtimeVersion。
// 用出包时的本地 ipa 读取即可:NPKG 企业重签只换签名、不改 bundle 内的 fingerprint 文件。
export function readEmbeddedRuntimeVersionFromIpa(ipaPath) {
  const entry = pickIpaFingerprintEntry(listZipEntries(ipaPath));
  const text = unzipEntryText(ipaPath, entry);
  return normalizeFingerprintHash(text, { source: `IPA 内嵌 ${entry}(${ipaPath})` });
}
