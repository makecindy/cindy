/**
 * UnrenderablePlaceholder — main-area card shown when the selected file
 * cannot be previewed in-app (binary / pdf / archive / huge file).
 *
 * "Unrenderable File Placeholder" visual spec:
 *   - 64×64 icon circle (file type icon)
 *   - filename (Inter 16/600)
 *   - meta line (Inter 12 normal — type · size · mtime)
 *   - hint text (Inter 13 normal — "此文件类型不支持在应用内预览")
 *   - primary "在系统中打开" + secondary "显示所在文件夹"
 */

import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { OpenInSystemActions } from './OpenInSystemActions';
import { FileTypeTile } from '@/components/ui/file-type-tile';
import { basename, dirname, formatBytes, formatMtime, joinPath } from './lib/fileMeta';

export interface UnrenderablePlaceholderProps {
  workdir: string;
  /** workdir-relative POSIX path */
  relPath: string;
  size: number;
  mtimeMs: number;
  /**
   * true = SSH remote 会话:文件在远端机器上,"在系统中打开 / 显示所在文件夹"
   * 无意义(本机没有这个路径),隐藏动作行、hint 换远程文案。
   */
  remote?: boolean;
  /**
   * true = 远程文本文件超出传输上限(device-link 帧限预判回 OVERSIZE):
   * hint 换"文件过大"文案——它是文本文件,和"二进制不支持预览"语义不同,
   * 混用文案会让用户以为文件坏了。
   */
  oversize?: boolean;
  /**
   * 大文件取回后的本地缓存副本绝对路径。非空时即使 remote 也显示动作行
   * (「在系统中打开 / 显示所在文件夹」指向本地副本——它就在本机),hint 换
   * "已取回到本地"文案,用户用自己选的应用打开任意大小文件。
   */
  localCopyPath?: string | null;
}

export function UnrenderablePlaceholder({
  workdir,
  relPath,
  size,
  mtimeMs,
  remote = false,
  oversize = false,
  localCopyPath = null,
}: UnrenderablePlaceholderProps) {
  const { t } = useTranslation();
  const name = basename(relPath);
  const absPath = joinPath(workdir, relPath);
  const folderPath = joinPath(workdir, dirname(relPath));

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 px-8">
      <div
        className={cn(
          'flex size-16 items-center justify-center rounded-full',
          'bg-[var(--chat-input-chip-bg)]',
        )}
      >
        <FileTypeTile name={name} />
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <div className="text-base font-semibold text-foreground">{name}</div>
        <div className="text-xs text-[var(--cmd-palette-item-meta)]">
          {formatBytes(size)} · {t('ccAgent.workdirBrowse.unrenderable.modifiedAt', { time: formatMtime(mtimeMs) })}
        </div>
        <div className="text-13 text-[var(--cmd-palette-item-meta)]">
          {t(
            localCopyPath
              ? 'ccAgent.workdirBrowse.unrenderable.cachedLocally'
              : oversize
                ? 'ccAgent.workdirBrowse.unrenderable.remoteOversize'
                : remote
                  ? 'ccAgent.workdirBrowse.unrenderable.remoteNotSupported'
                  : 'ccAgent.workdirBrowse.unrenderable.notSupported',
          )}
        </div>
      </div>
      {localCopyPath ? (
        // cachePath 是本机绝对路径(Windows 反斜杠),不能用 fileMeta 的 POSIX
        // dirname——按两种分隔符取父目录(规则 15)。
        <OpenInSystemActions
          absPath={localCopyPath}
          folderPath={localCopyPath.slice(
            0,
            Math.max(localCopyPath.lastIndexOf('/'), localCopyPath.lastIndexOf('\\')),
          )}
        />
      ) : (
        !remote && <OpenInSystemActions absPath={absPath} folderPath={folderPath} />
      )}
    </div>
  );
}
