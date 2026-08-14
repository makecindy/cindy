/**
 * FilterResultList —— 文件名筛选结果列表。
 *
 * 每行 basename(主) + dirname(副,小一号),点击选中文件触发 onSelectFile。
 * 跟 FileTreeView 同视觉风格(h-28px / rounded-md / hover bg-sidebar-item-hover /
 * selected bg-sidebar-item-active)。
 *
 * 抽到 workdir-browse/ 下,RSB plugin 和 doc 模式 sidebar 共用。
 */

import { File as FileIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { FILTER_RESULT_LIMIT } from './lib/filterFiles';

export interface FilterResultListProps {
  files: readonly string[];
  /** ripgrep cap 截断或前端展示上限截断 —— 显示"结果过多"提示行。 */
  truncated: boolean;
  /** 首次索引加载中(no cached files yet)。 */
  isLoading: boolean;
  /**
   * 文件名索引失败原因(useProjectFileList.error 透传)。非空且无可展示文件时
   * 显示失败占位而不是"无匹配"——静默空结果会被误读成"目录里没有这个文件"。
   * 'RG_UNAVAILABLE' 是稳定 token(远端无 ripgrep),映射专属文案。
   */
  indexError?: string | null;
  selectedPath: string | null;
  onSelectFile: (relPath: string) => void;
}

export function FilterResultList({
  files,
  truncated,
  isLoading,
  indexError = null,
  selectedPath,
  onSelectFile,
}: FilterResultListProps) {
  const { t } = useTranslation();

  if (isLoading && files.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-6 text-11 text-sidebar-muted">
        {t('rightSidebar.fileBrowser.filterIndexing')}
      </div>
    );
  }
  if (files.length === 0 && indexError) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-6 text-center text-11 text-sidebar-muted">
        {indexError === 'RG_UNAVAILABLE'
          ? t('rightSidebar.fileBrowser.filterRgUnavailable')
          : t('rightSidebar.fileBrowser.filterIndexFailed')}
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-6 text-11 text-sidebar-muted">
        {t('rightSidebar.fileBrowser.filterNoMatch')}
      </div>
    );
  }
  return (
    <div className="rsb-fbody-tree-scroll min-h-0 flex-1">
      <div className="flex h-full w-full flex-col gap-px overflow-y-auto py-2">
        {files.map((relPath) => {
          const slash = relPath.lastIndexOf('/');
          const basename = slash < 0 ? relPath : relPath.slice(slash + 1);
          const dirname = slash < 0 ? '' : relPath.slice(0, slash);
          const selected = relPath === selectedPath;
          return (
            <button
              type="button"
              key={relPath}
              onClick={() => onSelectFile(relPath)}
              title={relPath}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm',
                selected
                  ? 'bg-sidebar-item-active font-medium text-sidebar-item-active-foreground'
                  : 'text-foreground hover:bg-sidebar-item-hover',
              )}
            >
              <FileIcon size={14} strokeWidth={1.5} className="shrink-0 text-sidebar-muted" />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate">{basename}</span>
                {dirname && (
                  <span className="truncate text-10 text-sidebar-muted">{dirname}</span>
                )}
              </span>
            </button>
          );
        })}
        {truncated && (
          <div className="px-2 py-2 text-10 text-sidebar-muted">
            {t('rightSidebar.fileBrowser.filterTruncated', { limit: FILTER_RESULT_LIMIT })}
          </div>
        )}
      </div>
    </div>
  );
}
