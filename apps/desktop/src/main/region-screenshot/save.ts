import { app, dialog, type NativeImage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createLogger } from '../logger';
import { t } from '../i18n';

const log = createLogger('region-screenshot:save');

/** 本次运行里上一次保存的目录; 首次用系统「图片」目录。 */
let lastDirectory: string | null = null;

const pad = (value: number) => String(value).padStart(2, '0');

function defaultFileName(now = new Date()): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${t('regionScreenshot.saveFileName')} ${stamp}.png`;
}

/**
 * 弹出系统保存框把截图存为 PNG / JPEG (按用户选的扩展名)。用户取消返回 false;
 * 写入失败给出系统提示, 不抛错。
 */
export async function saveScreenshotImage(image: NativeImage): Promise<boolean> {
  const directory = lastDirectory ?? app.getPath('pictures');
  const result = await dialog.showSaveDialog({
    defaultPath: path.join(directory, defaultFileName()),
    filters: [
      { name: 'PNG', extensions: ['png'] },
      { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
    ],
  });
  if (result.canceled || !result.filePath) return false;
  const extension = path.extname(result.filePath).toLowerCase();
  const isJpeg = extension === '.jpg' || extension === '.jpeg';
  const filePath = extension ? result.filePath : `${result.filePath}.png`;
  try {
    await fs.writeFile(filePath, isJpeg ? image.toJPEG(92) : image.toPNG());
    lastDirectory = path.dirname(filePath);
    return true;
  } catch (error) {
    log.warn('screenshot save failed', { error });
    void dialog.showMessageBox({
      type: 'error',
      message: t('regionScreenshot.saveFailed'),
      detail: error instanceof Error ? error.message : String(error),
      noLink: true,
    });
    return false;
  }
}

/** Export only to a path selected in the native dialog; keep bytes in memory on cancellation. */
export async function saveRegionRecording(bytes: Uint8Array, format: 'webm' | 'gif', isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!isCurrent()) return false;
  const result = await dialog.showSaveDialog({
    defaultPath: path.join(lastDirectory ?? app.getPath('videos'), `${t(`regionScreenshot.live.${format === 'gif' ? 'gif' : 'video'}`)} ${Date.now()}.${format}`),
    filters: [{ name: format === 'gif' ? 'GIF' : 'WebM', extensions: [format] }],
  });
  if (result.canceled || !result.filePath || !isCurrent()) return false;
  const filePath = result.filePath.toLowerCase().endsWith(`.${format}`) ? result.filePath : `${result.filePath}.${format}`;
  try {
    await fs.writeFile(filePath, bytes);
    lastDirectory = path.dirname(filePath);
    return true;
  } catch {
    void dialog.showMessageBox({ type: 'error', message: t('regionScreenshot.saveFailed'), noLink: true });
    return false;
  }
}
