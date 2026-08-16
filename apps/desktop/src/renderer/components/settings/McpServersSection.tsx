/**
 * McpServersSection —— 设置 → 工具 页里的「外部」分组(用户自定义的远程 MCP)。
 *
 * 与「内置」分组(BuiltinToolsSection)同页:内置在上、外部在下,组成「工具」页。
 * 一张卡片,每行一个用户自定义的远程 MCP(name + transport + url),行尾编辑/删除;
 * 底部「添加」入口打开 McpServerDialog。配置全局跟随账号存 localDb,「配了就生效」——
 * 存在即注入两个 agent(Claude / Codex),删除即停用(下次新建会话生效)。
 *
 * 数据经 maker.listCustomMcpServers() 拉取;CRUD 后 main 广播 MCP_CHANGED → 本页 refetch。
 * 颜色全走主题 token。
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { deleteCustomMcpServer, listCustomMcpServers } from '@/lib/customMcpServers';
import { McpServerDialog } from './McpServerDialog';

import type { CustomMcpConfig } from '@/../shared/customMcp';

type DialogState = { mode: 'create' } | { mode: 'edit'; config: CustomMcpConfig } | null;

function RowIconButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
    >
      {icon}
    </button>
  );
}

function Divider() {
  return <div className="border-t" style={{ borderColor: 'var(--settings-theme-card-border)' }} />;
}

function McpRow({
  config,
  onEdit,
  onDelete,
}: {
  config: CustomMcpConfig;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 px-5 py-4">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-11 font-semibold uppercase"
        style={{
          backgroundColor: 'var(--surface)',
          border: '1px solid var(--settings-btn-secondary-border)',
          color: 'var(--settings-section-desc)',
        }}
      >
        {config.transport}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="truncate text-14 font-medium leading-tight"
          style={{ color: 'var(--settings-section-title)' }}
        >
          {config.name}
        </span>
        <span
          className="truncate text-13 leading-tight"
          style={{ color: 'var(--settings-integration-subtitle)' }}
        >
          {config.url}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <RowIconButton icon={<Pencil size={16} />} label={t('settings.mcp.editAria')} onClick={onEdit} />
        <RowIconButton icon={<Trash2 size={16} />} label={t('settings.mcp.deleteAria')} onClick={onDelete} />
      </div>
    </div>
  );
}

function AddRow({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{
          backgroundColor: 'var(--surface)',
          border: '1px solid var(--settings-btn-secondary-border)',
          color: 'var(--settings-section-desc)',
        }}
      >
        <Plus size={18} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-14 font-medium leading-tight" style={{ color: 'var(--settings-section-title)' }}>
          {t('settings.mcp.addCustom.title')}
        </span>
        <span
          className="truncate text-13 leading-tight"
          style={{ color: 'var(--settings-integration-subtitle)' }}
        >
          {t('settings.mcp.addCustom.subtitle')}
        </span>
      </div>
      <ChevronRight size={18} style={{ color: 'var(--text-tertiary)' }} />
    </button>
  );
}

export function McpServersSection() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [servers, setServers] = useState<CustomMcpConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<DialogState>(null);

  const refetch = useCallback(async () => {
    try {
      const list = await listCustomMcpServers();
      setServers(list);
    } catch {
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
    // CRUD 后 main 广播 MCP_CHANGED → refetch。
    const off = window.electronAPI.maker.onMcpChanged(() => void refetch());
    return off;
  }, [refetch]);

  const handleDelete = useCallback(
    async (config: CustomMcpConfig) => {
      const ok = await confirm({
        title: t('settings.mcp.deleteConfirm.title', { name: config.name }),
        description: t('settings.mcp.deleteConfirm.message'),
        confirmText: t('settings.mcp.deleteConfirm.confirm'),
        cancelText: t('settings.mcp.cancel'),
      });
      if (!ok) return;
      try {
        await deleteCustomMcpServer(config.id);
        toast.success(t('settings.mcp.toast.deleted'));
      } catch {
        toast.error(t('settings.mcp.toast.deleteFailed'));
      }
    },
    [confirm, t],
  );

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2
          className="text-16 font-medium leading-[1.2]"
          style={{ color: 'var(--settings-section-title)' }}
        >
          {t('settings.mcp.title')}
        </h2>
        <p className="text-13 leading-[1.5]" style={{ color: 'var(--settings-section-desc)' }}>
          {t('settings.mcp.subtitle')}
        </p>
      </div>

      {!loading && (
        <div
          className="flex flex-col rounded-xl border"
          style={{
            backgroundColor: 'var(--settings-theme-card-bg)',
            borderColor: 'var(--settings-theme-card-border)',
          }}
        >
          {servers.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 && <Divider />}
              <McpRow
                config={s}
                onEdit={() => setDialog({ mode: 'edit', config: s })}
                onDelete={() => void handleDelete(s)}
              />
            </Fragment>
          ))}
          {servers.length > 0 && <Divider />}
          <AddRow onClick={() => setDialog({ mode: 'create' })} />
        </div>
      )}

      {dialog && (
        <McpServerDialog
          initial={dialog.mode === 'edit' ? dialog.config : undefined}
          existingIds={servers.map((s) => s.id)}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void refetch();
          }}
        />
      )}
    </div>
  );
}
