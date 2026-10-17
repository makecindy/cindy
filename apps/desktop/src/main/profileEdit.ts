/**
 * profileEdit.ts — 个人资料编辑(改名 / 换头像)的业务体。
 * ---------------------------------------------------------------------------
 * IPC adapter 在 bootstrap-electron 注册(profile:* channel),这里是完全
 * 依赖注入的纯逻辑(规则 14:测试用内存 harness 直接 invoke,不启 Electron)。
 *
 * 2026-07 起资料**直写服务端**(auth-server PATCH /api/me/profile),跨设备
 * 生效;旧的"本地覆写 + cindy-media 头像入仓"方案(profileOverrideStore)
 * 已整体退役。头像字节不落本地媒体总仓:选图后经 oss-server 预签名直传
 * 公开读 bucket(ossPublicUpload),拿 publicUrl 提交 PATCH,登录态由
 * authManager.updateServerProfile 就地更新并广播。
 */

import { throwIpcError } from './utils/ipcValidate';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 上传头像体积上限——与 oss-server avatar 场景的 5MB 上限对齐。 */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/**
 * 选图源文件体积上限。上传的是 renderer 裁剪导出的 ≤512px 头像,不再是原图,
 * 所以源图可以放宽到常见手机原片(4800 万像素 JPEG 可达 10MB+)。
 */
export const AVATAR_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
/** 显示名长度上限(码点数;服务端上限 100,客户端收紧到 40 保持既有体验)。 */
export const NAME_MAX_LENGTH = 40;

/**
 * 头像允许的扩展名(含点)→ mime。**必须是 oss-server avatar 场景 MIME
 * 白名单(jpeg/png/webp)的子集**——白名单外的类型 presign 直接 400;
 * gif 已随本地覆写方案退役(服务端场景表不收)。
 */
const AVATAR_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** 文件选择器 filter 用的扩展名清单(不含点)。 */
export const AVATAR_FILE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

/**
 * 上传字节允许的 mime → 文件头签名。renderer 的头像编辑器只导出 PNG(含透明)
 * 或 JPEG,这里按导出契约收紧,并用文件头核对 mime,不信任 renderer 自报的类型。
 */
const AVATAR_UPLOAD_SIGNATURES: Record<string, readonly number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

/**
 * 上传头像边长上限(像素),与 renderer 头像编辑器的导出上限 AVATAR_OUTPUT_MAX_PX
 * 一致。main 先按文件头声明的尺寸拦截,再完整解码,解压炸弹到不了解码器。
 */
export const AVATAR_UPLOAD_MAX_EDGE_PX = 512;

// ── 依赖注入面 ──────────────────────────────────────────────────────────────

export interface ProfileEditDeps {
  /** 当前登录用户 id;未登录 null。 */
  getCurrentUserId(): string | null;
  /**
   * 当前账号会话的不透明标识(appSessionState.activeOwnerScopeKey):模式、账号或
   * 区域任一切换都会变化,跨 await 的账号副作用前后比对它。
   */
  getAccountScopeKey(): string;
  /** 当前展示资料(authManager.getServerProfile,弹窗预填 + 改名去重用)。 */
  getServerProfile(): { name: string; avatar: string | null } | null;
  /** 弹系统文件选择器,返回所选路径;取消返回 null。 */
  showAvatarOpenDialog(): Promise<string | null>;
  /** 读文件字节(fs.promises.readFile)。 */
  readFile(filePath: string): Promise<Buffer>;
  /** HDR 头像转 SDR(hdrAvatarToSdr.toSdrAvatarImage);SDR 原样返回。 */
  toSdrAvatar(image: { buffer: Buffer; mimeType: string }): Promise<{ buffer: Buffer; mimeType: string }>;
  /**
   * 完整解码上传字节(nativeImage.createFromBuffer),返回像素尺寸;解码失败返回 null。
   * 调用前已按文件头尺寸限过边长。
   */
  decodeAvatarImage(params: { buffer: Uint8Array; mimeType: string }): {
    width: number;
    height: number;
  } | null;
  /** 头像直传 OSS(ossPublicUpload.uploadPublicAsset 的 avatar 场景特化)。 */
  uploadAvatar(params: { buffer: Uint8Array; mimeType: string }): Promise<
    | { ok: true; publicUrl: string }
    | { ok: false; stage: 'presign' | 'put'; status: number; code?: string }
  >;
  /** PATCH /api/me/profile(authManager.updateServerProfile,成功后已广播)。 */
  patchProfile(patch: { displayName?: string; avatarUrl?: string | null }): Promise<
    { ok: true } | { ok: false; status: number; code?: string }
  >;
  /** 非致命异常记日志。 */
  logWarn(message: string, err?: unknown): void;
}

// ── IPC payload 类型(preload / renderer 共用形状) ─────────────────────────

/** profile:get-state 返回:编辑弹窗的预填数据(当前服务端展示资料)。 */
export interface ProfileEditState {
  name: string;
  avatarUrl: string | null;
}

export interface ChooseAvatarResult {
  canceled: boolean;
  /** 头像编辑器的取景源(data URL,一次性,不落任何缓存)。 */
  previewDataUrl?: string;
}

/**
 * set 携带的是头像编辑器按取景导出的最终字节(而不是源文件路径):预览与上传是
 * 同一份像素,main 也不再读取 renderer 传来的任意路径。
 */
export type AvatarAction =
  | { type: 'keep' }
  | { type: 'set'; data: Uint8Array; mimeType: string }
  | { type: 'reset' };

export interface UpdateProfileParams {
  /** 期望的显示名;null / 空串 / 与当前一致 = 不改名(服务端不允许清空名字)。 */
  name: string | null;
  avatar: AvatarAction;
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

function avatarMimeForPath(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  return AVATAR_MIME_BY_EXT[filePath.slice(dot).toLowerCase()] ?? null;
}

function requireUserId(deps: ProfileEditDeps): string {
  const userId = deps.getCurrentUserId();
  if (!userId) throwIpcError('PRECONDITION_FAILED', 'not logged in');
  return userId;
}

/**
 * 保存过程中每次 await 之后、触达账号的副作用(上传 / PATCH)之前复查:上传与 PATCH
 * 都按调用时的登录态取 token,中途切换账号(含同 id 换区域)会把资料写到新账号上。
 */
function requireSameAccount(deps: ProfileEditDeps, accountScope: string): void {
  if (deps.getAccountScopeKey() !== accountScope) {
    throwIpcError('PRECONDITION_FAILED', 'account changed while saving profile');
  }
}

function parseAvatarAction(value: unknown): AvatarAction | null {
  if (value === null || typeof value !== 'object') return null;
  const action = value as { type?: unknown; data?: unknown; mimeType?: unknown };
  if (action.type === 'keep') return { type: 'keep' };
  if (action.type === 'reset') return { type: 'reset' };
  if (
    action.type === 'set' &&
    action.data instanceof Uint8Array &&
    typeof action.mimeType === 'string'
  ) {
    return { type: 'set', data: action.data, mimeType: action.mimeType };
  }
  return null;
}

/** 文件头是否与声明的 mime 一致(只认上传白名单里的类型)。 */
function avatarBytesMatchMime(data: Uint8Array, mimeType: string): boolean {
  const signature = AVATAR_UPLOAD_SIGNATURES[mimeType];
  if (!signature || data.byteLength < signature.length) return false;
  return signature.every((byte, index) => data[index] === byte);
}

/** JPEG 帧头(SOF0–SOF15,除 DHT/JPG/DAC)标记,紧跟高宽字段。 */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * 读文件头声明的像素尺寸(PNG IHDR / JPEG 首个 SOF);结构不完整返回 null。
 * 调用前已核对过文件头签名。
 */
export function readAvatarDimensions(
  data: Uint8Array,
  mimeType: string,
): { width: number; height: number } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (mimeType === 'image/png') {
    // 签名 8 字节后第一个 chunk 必须是 IHDR:长度(4) 类型(4) 宽(4) 高(4)。
    if (data.byteLength < 24) return null;
    const type = String.fromCharCode(data[12], data[13], data[14], data[15]);
    if (type !== 'IHDR') return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 <= data.byteLength) {
      if (data[offset] !== 0xff) return null;
      const marker = data[offset + 1];
      if (marker === 0xff) {
        offset += 1; // 填充字节
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        offset += 2; // 无长度字段的独立标记
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // 帧头之前就结束 / 开始扫描
      const length = view.getUint16(offset + 2);
      if (length < 2) return null;
      if (JPEG_SOF_MARKERS.has(marker)) {
        // 长度(2) 精度(1) 高(2) 宽(2)
        if (offset + 9 > data.byteLength) return null;
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

// ── 业务入口(bootstrap 的 IPC handler 直调) ───────────────────────────────

/** 编辑弹窗预填数据。 */
export function getProfileEditState(deps: ProfileEditDeps): ProfileEditState {
  requireUserId(deps);
  const profile = deps.getServerProfile();
  if (!profile) throwIpcError('PRECONDITION_FAILED', 'not logged in');
  return { name: profile.name, avatarUrl: profile.avatar };
}

/**
 * 选头像文件:系统选择器 → 扩展名 / 体积校验 → HDR 转 SDR → 返回取景源 data URL。
 * 取景源即转换后的 SDR 像素;编辑器从它导出上传字节,updateProfile 不再二次转换。
 * 这里**不**上传——renderer 调整好取景、用户点「保存」才走 OSS 直传,取消弹窗零副作用。
 */
export async function chooseAvatarFile(deps: ProfileEditDeps): Promise<ChooseAvatarResult> {
  requireUserId(deps);
  const filePath = await deps.showAvatarOpenDialog();
  if (!filePath) return { canceled: true };
  const mime = avatarMimeForPath(filePath);
  if (!mime) {
    throwIpcError('INVALID_PARAMS', `unsupported avatar file type: ${filePath}`);
  }
  let buffer: Buffer;
  try {
    buffer = await deps.readFile(filePath);
  } catch {
    throwIpcError('INVALID_PARAMS', 'avatar file is not readable');
  }
  if (buffer.byteLength === 0 || buffer.byteLength > AVATAR_SOURCE_MAX_BYTES) {
    throwIpcError('INVALID_PARAMS', `avatar file size out of range: ${buffer.byteLength}`);
  }
  const preview = await deps.toSdrAvatar({ buffer, mimeType: mime });
  // 转换后的取景源同样受源图上限约束(上传的是编辑器导出的小图,另有 5MB 上限)。
  if (preview.buffer.byteLength > AVATAR_SOURCE_MAX_BYTES) {
    throwIpcError('INVALID_PARAMS', `avatar file size out of range: ${preview.buffer.byteLength}`);
  }
  return {
    canceled: false,
    previewDataUrl: `data:${preview.mimeType};base64,${preview.buffer.toString('base64')}`,
  };
}

/**
 * 保存资料:name 与 avatar 各自收敛成 PATCH 字段,一次提交服务端。
 *   - name:trim 后为空或与当前一致 → 不改;否则 displayName;
 *   - avatar keep:不动;set:校验导出字节(类型 / 文件头 / 体积 / 尺寸 / 完整解码)→ 原样 OSS 直传
 *     拿 publicUrl(取景源已在选图时转成 SDR,这里不二次转换);reset:avatarUrl null;
 *   - 两个字段都没变化 → 直接成功返回,零网络请求。
 * 上传成功但 PATCH 失败时,已传对象成为孤儿(bucket 生命周期规则兜底清理,
 * 契约见 oss-server 文档),客户端无需补偿删除。
 * 中途切换账号 → PRECONDITION_FAILED,不向新账号上传或 PATCH。
 */
export async function updateProfile(
  deps: ProfileEditDeps,
  rawParams: unknown,
): Promise<{ ok: true }> {
  requireUserId(deps);
  const accountScope = deps.getAccountScopeKey();
  const profile = deps.getServerProfile();
  if (!profile) throwIpcError('PRECONDITION_FAILED', 'not logged in');

  if (rawParams === null || typeof rawParams !== 'object') {
    throwIpcError('INVALID_PARAMS', 'profile update payload must be an object');
  }
  const params = rawParams as { name?: unknown; avatar?: unknown };
  if (params.name !== null && typeof params.name !== 'string') {
    throwIpcError('INVALID_PARAMS', 'name must be a string or null');
  }
  const avatarAction = parseAvatarAction(params.avatar);
  if (!avatarAction) {
    throwIpcError('INVALID_PARAMS', 'avatar action is malformed');
  }

  // ── 名字收敛 ──
  const trimmedName = typeof params.name === 'string' ? params.name.trim() : '';
  if ([...trimmedName].length > NAME_MAX_LENGTH) {
    throwIpcError('INVALID_PARAMS', `name exceeds ${NAME_MAX_LENGTH} characters`);
  }
  const nextDisplayName =
    trimmedName !== '' && trimmedName !== profile.name ? trimmedName : undefined;

  // ── 头像收敛(set 时先直传 OSS 拿公开地址) ──
  let nextAvatarUrl: string | null | undefined;
  if (avatarAction.type === 'set') {
    const { data, mimeType } = avatarAction;
    if (data.byteLength === 0 || data.byteLength > AVATAR_MAX_BYTES) {
      throwIpcError('INVALID_PARAMS', `avatar data size out of range: ${data.byteLength}`);
    }
    if (!avatarBytesMatchMime(data, mimeType)) {
      throwIpcError('INVALID_PARAMS', `avatar data does not match type: ${mimeType}`);
    }
    // renderer 不是安全边界:先按文件头限尺寸,再在 main 完整解码,尺寸一致才上传。
    const declared = readAvatarDimensions(data, mimeType);
    if (
      !declared ||
      declared.width < 1 ||
      declared.height < 1 ||
      declared.width > AVATAR_UPLOAD_MAX_EDGE_PX ||
      declared.height > AVATAR_UPLOAD_MAX_EDGE_PX
    ) {
      throwIpcError(
        'INVALID_PARAMS',
        `avatar dimensions out of range: ${declared ? `${declared.width}x${declared.height}` : '<unreadable>'}`,
      );
    }
    const decoded = deps.decodeAvatarImage({ buffer: data, mimeType });
    if (!decoded || decoded.width !== declared.width || decoded.height !== declared.height) {
      throwIpcError('INVALID_PARAMS', 'avatar data failed to decode');
    }
    requireSameAccount(deps, accountScope);
    const uploaded = await deps.uploadAvatar({ buffer: data, mimeType });
    if (!uploaded.ok) {
      throwIpcError(
        'PROFILE_AVATAR_UPLOAD_FAILED',
        `avatar upload failed stage=${uploaded.stage} status=${uploaded.status} code=${uploaded.code ?? '<none>'}`,
      );
    }
    nextAvatarUrl = uploaded.publicUrl;
  } else if (avatarAction.type === 'reset') {
    nextAvatarUrl = null;
  }

  // ── 提交(无变化则零请求) ──
  if (nextDisplayName === undefined && nextAvatarUrl === undefined) {
    return { ok: true };
  }
  requireSameAccount(deps, accountScope);
  const patched = await deps.patchProfile({
    ...(nextDisplayName !== undefined ? { displayName: nextDisplayName } : {}),
    ...(nextAvatarUrl !== undefined ? { avatarUrl: nextAvatarUrl } : {}),
  });
  if (!patched.ok) {
    throwIpcError(
      'PROFILE_UPDATE_FAILED',
      `profile patch failed status=${patched.status} code=${patched.code ?? '<none>'}`,
    );
  }
  return { ok: true };
}

// ── 旧「本地覆写」方案退役的一次性清理(2026-07) ───────────────────────────

export interface LegacyOverrideCleanupDeps {
  /** 读 userData/profile-override.json 原文;文件不存在返回 null。 */
  readOverrideFile(): string | null;
  /** 回写剩余条目(其它账号的遗留,各自登录时清)。 */
  writeOverrideFile(content: string): void;
  deleteOverrideFile(): void;
  /** 清引用行(cindy-media ledger.removeRefs;字节交回收器,不直接删文件)。 */
  removeRefs(params: { refKind: 'profile-avatar'; refId: string }): Promise<number>;
  logInfo(message: string): void;
  logWarn(message: string, err?: unknown): void;
}

/**
 * 清理旧「本地覆写」方案(profileOverrideStore)留下的存量数据:当前登录
 * 账号在 profile-override.json 里有条目时,删掉其名下的 'profile-avatar'
 * cindy-media 引用行(规则 25:业务退役删自己名下的 ref,字节回收交回收器),
 * 并从文件移除该条目;全部条目清完后删文件。以文件条目为幂等标记——
 * 引用清理失败则保留条目,下次登录(localDb ready)重试;refs 按账号分库,
 * 其它账号的条目留待各自登录时清。文件损坏时无从定位 refs,直接删文件止损。
 */
export async function cleanupLegacyProfileOverride(
  deps: LegacyOverrideCleanupDeps,
  userId: string,
): Promise<void> {
  const raw = deps.readOverrideFile();
  if (raw === null) return;
  let store: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      store = parsed as Record<string, unknown>;
    }
  } catch {
    // 非法 JSON → store 保持 null,走下方删文件止损分支
  }
  if (store === null || Object.keys(store).length === 0) {
    try {
      deps.deleteOverrideFile();
    } catch (err) {
      deps.logWarn('legacy profile override file delete failed', err);
    }
    return;
  }
  if (!(userId in store)) return;

  try {
    const removed = await deps.removeRefs({ refKind: 'profile-avatar', refId: userId });
    deps.logInfo(
      `legacy profile override retired: removed ${removed} avatar media ref(s) for current user`,
    );
  } catch (err) {
    deps.logWarn('legacy profile avatar ref cleanup failed (will retry next login)', err);
    return;
  }
  delete store[userId];
  try {
    if (Object.keys(store).length === 0) {
      deps.deleteOverrideFile();
    } else {
      deps.writeOverrideFile(JSON.stringify(store, null, 2));
    }
  } catch (err) {
    deps.logWarn('legacy profile override file update failed (harmless, retried next login)', err);
  }
}
