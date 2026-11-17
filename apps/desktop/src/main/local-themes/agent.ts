import fs from 'node:fs';
import path from 'node:path';
import type { SessionPathAuthorization } from '@cindy/mcps';
import { LOCAL_THEME_SUFFIX } from '../../shared/local-themes';
import { CindyFileError } from '../../shared/cindyFile';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState';
import { manageAppPreferences } from '../app-settings/preferences';
import { classifyLocalAttachmentPath } from '../cindy-brain/ghostLocalPathGrant';
import { inspectCindyFile } from '../cindy-files/reader';
import { getLocalThemesDir, loadLocalThemesSync } from './loader';
import { installThemePackage } from './packages';
import { broadcastLocalThemes } from './register';

/** A task reaches the same installer as file drops; it never opens another app. */
export async function importThemePackageFromTask(
  input: { filePath: string; workingDir: string },
  access: { assertCurrent(): Promise<void>; assertCurrentSync(): void;
    authorizePath(absolutePath: string): Promise<SessionPathAuthorization> },
): Promise<Record<string, unknown>> {
  const owner = activeOwnerScopeKey();
  let grant: SessionPathAuthorization = { allowed: true };
  const assertActive = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner
      || (grant.allowed && grant.isCurrent?.() === false)) throw new Error('Application session or file grant changed');
    access.assertCurrentSync();
  };
  const revalidate = async () => { await access.assertCurrent(); assertActive(); };
  await revalidate();
  if (!input.workingDir.trim() || !input.filePath || input.filePath.includes('\0') || input.filePath.length > 4096
    || !input.filePath.toLowerCase().endsWith('.cindy'))
    return { ok: false, errorCode: 'INVALID_THEME_PACKAGE', message: '请提供本任务中 .cindy 主题包的路径。' };
  const source = classifyLocalAttachmentPath(path.resolve(input.workingDir, input.filePath), input.workingDir,
    { mimeForExt: ext => ext === '.cindy' ? 'application/zip' : null });
  if (source.kind === 'not-local' || source.kind === 'unsupported-type')
    return { ok: false, errorCode: 'INVALID_THEME_PACKAGE', message: '无法读取该主题包，请核对路径和文件类型。' };
  const identity = fs.statSync(source.absPath);
  if (source.kind === 'outside-workdir') {
    grant = await access.authorizePath(source.absPath);
    if (!grant.allowed) return { ok: false, errorCode: 'PERMISSION_DENIED', message: grant.reason };
  }
  const assertSource = () => {
    assertActive();
    const current = fs.statSync(source.absPath);
    if (fs.realpathSync.native(source.absPath) !== source.absPath
      || current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error('Theme source changed after authorization');
  };
  await revalidate();
  assertSource();
  let names: string[];
  try {
    const inspected = await inspectCindyFile(source.absPath);
    await revalidate();
    assertSource();
    if (inspected.type !== 'theme') return { ok: false, errorCode: 'NOT_THEME_PACKAGE', message: '这是插件包，请使用已有插件安装入口。' };
    names = await installThemePackage(inspected, getLocalThemesDir(), assertSource);
  } catch (error) {
    if (!(error instanceof CindyFileError)) throw error;
    return { ok: false, errorCode: error.code === 'unsupported' ? 'UNSUPPORTED_CINDY_FILE' : 'INVALID_THEME_PACKAGE',
      message: error.code === 'unsupported' ? '当前版本不支持此文件，请更新 Cindy 后重试。' : '主题包无效，原有主题保持不变。' };
  }
  await revalidate();
  await broadcastLocalThemes();
  await revalidate();
  const themes = loadLocalThemesSync().themes.map(theme => ({ id: theme.id, name: theme.name, type: theme.type,
    themeFamily: theme.family ? `${theme.family}${LOCAL_THEME_SUFFIX}` : theme.id }));
  let preferences: Awaited<ReturnType<typeof manageAppPreferences>> | undefined;
  try { preferences = await manageAppPreferences('refresh-themes'); } catch { /* Installation and renderer refresh are separate outcomes. */ }
  await revalidate();
  return { ok: true, scope: 'local', status: 'installed', names, themes, refreshed: !!preferences,
    ...(preferences ? { current: { theme: preferences.value?.theme, themeFamily: preferences.value?.themeFamily } }
      : { message: '主题包已安装，但当前窗口尚未确认刷新。请在外观设置刷新并核对，不要重复安装。' }) };
}
