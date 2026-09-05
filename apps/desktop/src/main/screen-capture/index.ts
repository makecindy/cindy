import { clipboard, ipcMain, nativeImage } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  SCREEN_CAPTURE_REGION_CHANNEL,
  SCREEN_CAPTURE_TARGET_AVAILABLE_CHANNEL,
  type ScreenCaptureOverlayPalette,
  type ScreenCaptureRegionResult,
} from '../../shared/screenCapture.js';
import { createLogger } from '../logger.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { captureRegionViaOverlay } from './overlayCapture.js';

/**
 * 区域截图(capture-region 快捷键)的 main 侧实现, 三平台生效:
 * - darwin: 系统 /usr/sbin/screencapture -i(拉框/按窗口, Esc 取消), 选区
 *   交互、多显示器、Retina 缩放都由系统处理。首次使用时 macOS 可能弹出
 *   「屏幕录制」权限授权。
 * - win32 / linux: desktopCapturer 冻结帧 + 自绘选区覆盖层(overlayCapture)。
 * 成功后 PNG 字节写系统剪贴板并返回 renderer 合并进当前目标草稿。
 */

const execFileAsync = promisify(execFile);
const logger = createLogger('screen-capture');

const SCREENCAPTURE_BIN = '/usr/sbin/screencapture';
/** 选区是用户交互, 可能停留很久; 只兜底清理彻底挂死的进程/覆盖层。 */
const CAPTURE_TIMEOUT_MS = 180_000;

/** 进行中去重: 重复按快捷键不再叠加第二个选区界面。 */
let captureInFlight = false;

interface RegionCaptureOutcome {
  cancelled: boolean;
  data?: Buffer;
}

async function captureRegionDarwin(): Promise<RegionCaptureOutcome> {
  const tmpPath = path.join(os.tmpdir(), `cindy-region-capture-${randomUUID()}.png`);
  try {
    // -i 交互式选区(拖框或空格切换按窗口); 用户 Esc 取消时非零退出且不产生
    // 文件, 与真实失败(下面读文件抛错)区分开。
    await execFileAsync(SCREENCAPTURE_BIN, ['-i', '-t', 'png', tmpPath], {
      timeout: CAPTURE_TIMEOUT_MS,
    });
  } catch (err) {
    // 正常取消不产生文件; 只有 timeout 强杀可能留下已写入的文件, 兜底清掉。
    void rm(tmpPath, { force: true }).catch(() => {});
    // 只把"可确认的用户取消"(干净的非零退出: 未被强杀、非 spawn 失败、无
    // stderr 输出)静默处理; 超时强杀(killed/signal)、spawn 失败(code 为
    // ENOENT 等字符串 errno)、权限被拒等带 stderr 的真实失败要走稳定 IPC
    // 错误 → renderer 失败提示, 不能表现成"按了毫无反应"(review P2)。
    const e = err as {
      killed?: boolean;
      signal?: NodeJS.Signals | null;
      code?: number | string | null;
      stderr?: unknown;
    };
    const stderrText = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    if (e.killed === true || e.signal != null || typeof e.code === 'string' || stderrText !== '') {
      logger.warn('screencapture failed', {
        code: e.code,
        signal: e.signal,
        killed: e.killed,
        stderr: stderrText.slice(0, 200),
      });
      throwIpcError('INTERNAL', 'screencapture failed');
    }
    logger.debug('screencapture exited non-zero (user cancel)', { code: e.code });
    return { cancelled: true };
  }
  let data: Buffer;
  try {
    data = await readFile(tmpPath);
  } catch (readErr) {
    // 退出码 0 但没有文件 —— 某些取消路径也会这样, 按取消处理; 文件存在但
    // 读不了(权限/IO)是真实失败, 不能吞成取消(review P2)。
    if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
      return { cancelled: true };
    }
    logger.warn('failed to read screencapture output', { err: String(readErr) });
    throwIpcError('INTERNAL', 'failed to read screencapture output');
  } finally {
    void rm(tmpPath, { force: true }).catch(() => {});
  }
  if (data.length === 0) {
    throwIpcError('INTERNAL', 'screencapture produced an empty file');
  }
  return { cancelled: false, data };
}

/** 覆盖层提示条文案的兜底(renderer 未传或非法时)。 */
const DEFAULT_OVERLAY_HINT = 'Drag to select the region to capture, press Esc to cancel';
const MAX_OVERLAY_HINT_LENGTH = 200;

/** 提示条文案由 renderer 随调用传入(i18n 在 renderer 侧), main 只做防御性截断。 */
function sanitizeOverlayHint(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return DEFAULT_OVERLAY_HINT;
  const hint = (payload as { overlayHint?: unknown }).overlayHint;
  if (typeof hint !== 'string' || hint.trim() === '') return DEFAULT_OVERLAY_HINT;
  return hint.slice(0, MAX_OVERLAY_HINT_LENGTH);
}

/** 覆盖层配色兜底(renderer 未传/字段非法时) — 与主题 token 的 dark 默认值一致。 */
const DEFAULT_OVERLAY_PALETTE: ScreenCaptureOverlayPalette = {
  scrim: 'rgba(0, 0, 0, 0.7)',
  selectionBorder: 'rgba(255, 255, 255, 0.9)',
  pillBg: '#1f1f1e',
  pillFg: '#ffffff',
};

/**
 * 色值只放行 #hex / rgb[a](…) / hsl[a](…) 字面量(函数体内仅数字/逗号/百分号/
 * 空格/点/斜杠)。配色会拼进覆盖层 <style>, 这里是防样式注入的唯一闸口 ——
 * var()/url()/expression 等一律拒绝, 逐字段回退默认值。
 */
const SAFE_CSS_COLOR = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[\d.,%\s/]+\s*\))$/i;

function sanitizeOverlayPalette(payload: unknown): ScreenCaptureOverlayPalette {
  const raw =
    payload && typeof payload === 'object'
      ? (payload as { overlayPalette?: unknown }).overlayPalette
      : undefined;
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (key: keyof ScreenCaptureOverlayPalette): string => {
    const value = source[key];
    if (typeof value === 'string' && SAFE_CSS_COLOR.test(value.trim())) return value.trim();
    return DEFAULT_OVERLAY_PALETTE[key];
  };
  return {
    scrim: pick('scrim'),
    selectionBorder: pick('selectionBorder'),
    pillBg: pick('pillBg'),
    pillFg: pick('pillFg'),
  };
}

async function captureRegion(
  platform: string,
  overlayHint: string,
  overlayPalette: ScreenCaptureOverlayPalette,
): Promise<ScreenCaptureRegionResult> {
  const outcome =
    platform === 'darwin'
      ? await captureRegionDarwin()
      : await captureRegionViaOverlay(CAPTURE_TIMEOUT_MS, overlayHint, overlayPalette);
  if (outcome.cancelled || !outcome.data) {
    return { ok: true, cancelled: true };
  }
  // 同步写系统剪贴板(best-effort): 自动贴入只覆盖主区当前对话/新任务草稿,
  // 协同 Worker 输入框、分离侧栏窗口等其它 composer 用户直接粘贴即可,
  // 各自走既有粘贴管线, 不必为每个挂载面单独接线。
  try {
    clipboard.writeImage(nativeImage.createFromBuffer(outcome.data));
  } catch (err) {
    logger.warn('failed to write captured image to clipboard (ignored)', { err: String(err) });
  }
  return { ok: true, cancelled: false, data: outcome.data };
}

/**
 * 各 host renderer 当前路由是否存在截图目标 composer(webContents.id → boolean)。
 * webview guest 的快捷键转发据此决定要不要拦截按键: 无目标时不 preventDefault,
 * 网页对该组合键的原生处理得以保留(review P2)。缺省视为无目标(不拦截),
 * MainLayout 挂载即上报, 不会出现"有目标但状态未上报"的窗口期盖过真实转发。
 */
const captureTargetAvailability = new Map<number, boolean>();

export function hasRegionCaptureTarget(hostContentsId: number): boolean {
  return captureTargetAvailability.get(hostContentsId) === true;
}

export function registerScreenCaptureIpc(platform: string = process.platform): void {
  ipcMain.on(SCREEN_CAPTURE_TARGET_AVAILABLE_CHANNEL, (event, available: unknown) => {
    // ipcMain.on 同步监听器里不可抛异常(lifecycle 视为 fatal): 不信任来源直接忽略。
    try {
      assertTrustedAppRendererEvent(event);
    } catch {
      return;
    }
    const id = event.sender.id;
    if (!captureTargetAvailability.has(id)) {
      event.sender.once('destroyed', () => captureTargetAvailability.delete(id));
    }
    captureTargetAvailability.set(id, available === true);
  });

  ipcMain.handle(
    SCREEN_CAPTURE_REGION_CHANNEL,
    async (event, payload: unknown): Promise<ScreenCaptureRegionResult> => {
      assertTrustedAppRendererEvent(event);
      if (captureInFlight) {
        return { ok: true, cancelled: true };
      }
      captureInFlight = true;
      try {
        return await captureRegion(
          platform,
          sanitizeOverlayHint(payload),
          sanitizeOverlayPalette(payload),
        );
      } catch (err) {
        // 非取消类失败(desktopCapturer 无可用帧、覆盖层加载失败等)统一转
        // 稳定 IPC 错误码, renderer 据此弹本地化提示 —— 快捷键不能"按了
        // 毫无反应"。仅透传真正的 IpcError(code 在 IpcErrorCode 联合内):
        // Electron/系统调用的原生错误也可能带 code(如 ERR_*), 不能绕过
        // 稳定错误协议裸跨 IPC(review P1/P2)。
        if (isIpcError(err)) throw err;
        // 原始错误只进 main 日志; 跨 IPC 返回固定通用消息 —— 底层错误串可能
        // 携带内部路径/加载 URL 等细节, 不外泄给 renderer(review P2)。
        logger.warn('region capture failed', { err: String(err) });
        throwIpcError('INTERNAL', 'region capture failed');
      } finally {
        captureInFlight = false;
      }
    },
  );
}
