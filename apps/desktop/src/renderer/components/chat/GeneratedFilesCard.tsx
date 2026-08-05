/**
 * GeneratedFilesCard — 每个 user turn 结尾的「本轮产出文件」卡。
 * ---------------------------------------------------------------------------
 * 对标 Codex Desktop 回复尾部的 artifact 文件卡:agent 本轮新建的文件不再只能
 * 靠模型在正文里写对 Markdown 链接才可见(Issue #1811 场景),而是从 tool_use
 * 结构化派生后集中呈现。文件来源判定见 lib/generatedFiles.ts。
 *
 * 交互:
 *   - 左键 → 用系统默认应用打开(本地 openPath;远程会话取回缓存副本再打开);
 *   - 右键 → 共享文件 chip 菜单(复制 / 路径 / 定位 / 打开方式…),与聊天里其它
 *     文件 chip 一致。
 *
 * 存在性门槛(DESIGN.md §14.5「可点必存在」):本地会话渲染前 stat 过滤,不存在
 * 的文件不出 chip,整卡为空则不渲染。远程会话无法本机 stat,信任 tool_use 的
 * 产出记录直接呈现(点击时再经远程取回,失败有 toast)。
 */

import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { GeneratedFileRef } from '@/lib/generatedFiles';
import { isRemoteFileOrigin } from '@/lib/sessionFileOrigin';
import { openRemoteChatFile } from '@/lib/remoteFileOpen';
import { toast } from '@/lib/toast';
import { useChatSessionFile } from './ChatSessionFileContext';
import { useFileChipContextMenu } from './useFileChipContextMenu';

function GeneratedFileChip({ file }: { file: GeneratedFileRef }) {
  const { t } = useTranslation();
  const fileCtx = useChatSessionFile();
  const remoteOrigin = isRemoteFileOrigin(fileCtx.origin) ? fileCtx.origin : null;
  const ctxMenu = useFileChipContextMenu({
    getAbsPath: () => file.path,
    // 生成物常是 .xlsx / .pdf / 图片等,"打开方式"对它们最有用;会话上下文
    // (含侧边栏定位目标)由 useFileChipContextMenu 内部从 ChatSessionFileContext 取。
    canOpenInBrowser: false,
  });

  const open = async (): Promise<void> => {
    if (remoteOrigin) {
      await openRemoteChatFile(remoteOrigin, fileCtx.workingDir, file.path);
      return;
    }
    const res = await window.electronAPI.openPath(file.path);
    if (!res.success) toast.error(res.error ?? t('logic.errors.openFileFailed'));
  };

  return (
    <>
      <button
        type="button"
        title={file.path}
        onClick={() => void open()}
        onContextMenu={ctxMenu.onContextMenu}
        className={cn(
          'inline-flex items-center gap-1.5',
          'h-7 px-2.5 py-1.5 max-w-[280px]',
          'rounded-[9999px]',
          'bg-[var(--msg-md-inline-code-bg)]',
          'text-[13px] font-medium text-[var(--msg-assistant-text)]',
          'hover:bg-[var(--cmd-palette-item-hover)]',
          'transition-colors cursor-pointer',
        )}
      >
        <FileText size={14} className="shrink-0 opacity-70" />
        <span className="truncate">{file.name}</span>
      </button>
      {ctxMenu.menu}
    </>
  );
}

export function GeneratedFilesCard({
  files,
  workingDir,
}: {
  files: readonly GeneratedFileRef[];
  workingDir: string;
}) {
  const { t } = useTranslation();
  const fileCtx = useChatSessionFile();
  const isRemote = isRemoteFileOrigin(fileCtx.origin);
  // 本地会话:stat 过滤到真实存在的文件;远程:信任产出记录(见文件头注释)。
  // null = 尚未算完(本地首帧),此时不渲染,避免闪现后又被过滤掉。
  const [existing, setExisting] = useState<GeneratedFileRef[] | null>(
    isRemote ? [...files] : null,
  );

  useEffect(() => {
    if (isRemote) {
      setExisting([...files]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const checks = await Promise.all(
        files.map(async (f) => {
          try {
            const r = await window.electronAPI.fsBrowse.statPath(f.path);
            return r.kind === 'file';
          } catch {
            return false;
          }
        }),
      );
      if (!cancelled) setExisting(files.filter((_, idx) => checks[idx]));
    })();
    return () => {
      cancelled = true;
    };
    // workingDir 变化不改变绝对路径集合;files 引用稳定于 build。
  }, [files, isRemote]);

  if (!existing || existing.length === 0) return null;

  return (
    <div className="my-1 flex flex-col gap-1.5">
      <span className="text-12 text-[var(--text-secondary)]">
        {t('chat.generatedFiles.title')}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {existing.map((f) => (
          <GeneratedFileChip key={f.path} file={f} />
        ))}
      </div>
    </div>
  );
}
