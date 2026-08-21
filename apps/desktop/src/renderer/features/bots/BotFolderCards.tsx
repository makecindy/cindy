import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useBotTranslation } from './botPronounContext';

import { cn } from '@/lib/utils';

import { archiveBotProjectBinding, upsertBotProjectBinding, type BotProjectBinding } from './botStore';

function folderName(workingDir: string): string {
  const trimmed = workingDir.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index === -1 ? trimmed : trimmed.slice(index + 1) || trimmed;
}

function bindingErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * "TA 懂的" 简化版 —— 文件夹卡片 + 加文件夹。复用 BotProjectSettings 同一套
 * 绑定数据(projectBindings)与目录选择器 IPC,只是不在这里暴露 workspace 策略、
 * 默认分支、allowed paths 这些技术细节——那些留在高级里的完整 BotProjectSettings。
 * 不虚构文件数量等 BotProjectBinding 没有的字段。
 */
export function BotFolderCards({
  botId,
  bindings,
}: {
  botId: string;
  bindings: readonly BotProjectBinding[];
}) {
  const { t } = useBotTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = bindings.filter((binding) => binding.status !== 'archived');

  const addFolder = async () => {
    setError(null);
    try {
      const result = await window.electronAPI.showOpenDirectoryDialog();
      if (result.canceled || !result.path) return;
      setBusy('add');
      await upsertBotProjectBinding(botId, {
        workingDir: result.path,
        defaultBranch: null,
        workspacePolicy: 'none',
        isDefault: active.length === 0,
        allowedPaths: [],
      });
    } catch (cause) {
      setError(bindingErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const removeFolder = async (binding: BotProjectBinding) => {
    setBusy(binding.id);
    setError(null);
    try {
      await archiveBotProjectBinding(botId, binding.id);
    } catch (cause) {
      setError(bindingErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      {active.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {active.map((binding) => (
            <div
              key={binding.id}
              className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border-default)] px-3 py-2.5"
            >
              <span className="min-w-0">
                <span className="block truncate text-12 font-medium text-[var(--text-primary)]">
                  {folderName(binding.workingDir)}
                </span>
                <span className="block truncate text-11 text-[var(--text-tertiary)]">
                  {binding.workingDir}
                </span>
              </span>
              {/* 文字按钮,不是卡片右上角的 ✕:那个位置离「关掉这张卡」太近,
                  而这一下删的是绑定关系。 */}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void removeFolder(binding)}
                className="shrink-0 rounded-lg px-1 text-11 text-[var(--text-tertiary)] hover:text-[var(--text-danger)] disabled:opacity-50"
              >
                {t('bots.folders.remove')}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void addFolder()}
        /* 上边距只在它下面真的压着文件夹卡片时才有意义。一个都没有时这 8px 是
           凭空多出来的一道缝,空态卡看起来就比内容还高。 */
        className={cn(
          'inline-flex h-9 items-center gap-2 rounded-xl border border-dashed border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50',
          active.length > 0 && 'mt-2',
        )}
      >
        <FolderOpen size={14} />
        {busy === 'add' ? t('bots.folders.adding') : t('bots.folders.addButton')}
      </button>
      {/*
        原来这里还有一句脚注「TA 会自己读文件夹里的东西,对话时直接用」——它和区块
        标题旁那句「给 TA 一个文件夹,TA 就懂你的项目」是同一件事说两遍,中间只夹了
        一个按钮。同一块里两句解释包一个控件,正是整页「密密麻麻」的来源,已删。
      */}
      {error ? <p className="mt-2 text-11 text-[var(--text-danger)]">{error}</p> : null}
    </div>
  );
}
