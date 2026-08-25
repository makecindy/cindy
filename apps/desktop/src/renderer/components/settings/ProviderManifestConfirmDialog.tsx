/**
 * ProviderManifestConfirmDialog — 外部供应商 manifest 深链
 * (`cindy://settings/providers?manifest=<https-url>`)的确认屏。
 *
 * 信任边界（issue #3387 契约）：确认屏先于任何表单出现——挂载即请求 main 受限拉取
 * (https-only / 拒绝重定向 / 64 KiB / 10s / fail-closed 校验)，成功后展示来源 origin、
 * 各 runtime 端点与模型数，并明示这是外部提供的非官方配置；**默认动作是取消**
 * (Radix AlertDialog 初始焦点在 Cancel)，取消/关闭不产生任何本地数据。用户确认后
 * 才把校验过的 preset 交给「添加供应商」向导的预设表单步(API key 仍由用户自己输入)。
 *
 * 异步过期防护：父层(ProvidersSection)按请求 seq 用 key 挂载本组件——新深链到来
 * 即换代卸载旧实例，卸载后 in-flight 结果被 disposed 标志丢弃，不会污染新表单。
 *
 * 视觉复用 ConfirmDialog 的 --confirm-* token 组(同 SessionShareImportWizard)。
 */

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Globe, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import type { AgentKind, ProviderPreset } from '@cindy/model-providers';

type FetchFailureReason = Awaited<
  ReturnType<(typeof window.electronAPI.maker)['fetchProviderManifest']>
> extends infer R
  ? R extends { ok: false; reason: infer Reason }
    ? Reason
    : never
  : never;

type DialogPhase =
  | { kind: 'loading' }
  | { kind: 'error'; reason: FetchFailureReason; status?: number }
  | { kind: 'ready'; origin: string; preset: ProviderPreset };

/** runtime 展示名与向导目录一致(产品名不进翻译表)。 */
const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};
const AGENT_ORDER: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

/** 失败原因 → 文案桶:拉取层失败各自成桶,内容校验拒绝统一为 invalid(附原因码)。 */
function errorBucket(reason: FetchFailureReason): 'timeout' | 'redirect' | 'http' | 'network' | 'oversize' | 'invalid' {
  switch (reason) {
    case 'timeout':
      return 'timeout';
    case 'redirect':
      return 'redirect';
    case 'http-status':
      return 'http';
    case 'network':
      return 'network';
    case 'oversize':
      return 'oversize';
    default:
      return 'invalid';
  }
}

export interface ProviderManifestConfirmDialogProps {
  /** 深链携带的 manifest URL(main/preload 已过白名单;main 拉取时再复核)。 */
  url: string;
  onCancel: () => void;
  /** 用户在确认屏点「继续」:把校验过的 preset 交给向导预设表单步。 */
  onConfirm: (preset: ProviderPreset) => void;
}

export function ProviderManifestConfirmDialog({
  url,
  onCancel,
  onConfirm,
}: ProviderManifestConfirmDialogProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<DialogPhase>({ kind: 'loading' });

  useEffect(() => {
    let disposed = false;
    void window.electronAPI.maker
      .fetchProviderManifest({ url })
      .then((result) => {
        if (disposed) return;
        if (result.ok) {
          setPhase({ kind: 'ready', origin: result.origin, preset: result.preset });
        } else {
          setPhase({ kind: 'error', reason: result.reason, status: result.status });
        }
      })
      .catch(() => {
        if (!disposed) setPhase({ kind: 'error', reason: 'network' });
      });
    return () => {
      disposed = true;
    };
  }, [url]);

  const busy = phase.kind === 'loading';
  const runtimeRows =
    phase.kind === 'ready'
      ? AGENT_ORDER.flatMap((agent) => {
          const runtime = phase.preset.runtimes[agent];
          return runtime ? [{ agent, runtime }] : [];
        })
      : [];

  return (
    <AlertDialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000]',
            'bg-[var(--overlay-modal)]',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <AlertDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[480px] rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <AlertDialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
            {t('settings.providers.manifest.title')}
          </AlertDialog.Title>

          {phase.kind === 'loading' && (
            <div className="mt-4 flex items-center gap-2 text-sm text-[var(--confirm-desc)]">
              <Spinner size={14} />
              {t('settings.providers.manifest.loading')}
            </div>
          )}

          {phase.kind === 'error' && (
            <div className="mt-3 flex flex-col gap-2">
              <AlertDialog.Description className="text-sm text-[var(--confirm-desc)]">
                {phase.reason === 'http-status'
                  ? t('settings.providers.manifest.error.http', { status: phase.status })
                  : t(`settings.providers.manifest.error.${errorBucket(phase.reason)}`)}
              </AlertDialog.Description>
              {/* 原因码原样给出,便于服务方按 issue 契约修正 manifest。 */}
              <p className="text-xs text-[var(--text-tertiary)]">
                {t('settings.providers.manifest.error.reasonCode', { reason: phase.reason })}
              </p>
            </div>
          )}

          {phase.kind === 'ready' && (
            <div className="mt-3 flex flex-col gap-3">
              <AlertDialog.Description className="text-sm text-[var(--confirm-desc)]">
                {t('settings.providers.manifest.description', { name: phase.preset.name })}
              </AlertDialog.Description>
              <div
                className="flex items-center gap-2 rounded-lg p-3 text-sm"
                style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--confirm-title)' }}
              >
                <Globe size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="truncate" title={phase.origin}>
                  {t('settings.providers.manifest.source', { origin: phase.origin })}
                </span>
              </div>
              <div
                className="flex flex-col gap-2 rounded-lg p-3"
                style={{ backgroundColor: 'var(--surface-chip)' }}
              >
                {runtimeRows.map(({ agent, runtime }) => (
                  <div key={agent} className="text-sm" style={{ color: 'var(--confirm-title)' }}>
                    <p className="font-medium">{AGENT_LABEL[agent]}</p>
                    <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]" title={runtime.baseUrl}>
                      {runtime.baseUrl}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                      {t('settings.providers.manifest.modelCount', { count: runtime.models.length })}
                    </p>
                  </div>
                ))}
              </div>
              <div className="flex items-start gap-2 text-xs text-[var(--text-tertiary)]">
                <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                <p>{t('settings.providers.manifest.warning')}</p>
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className={cn(
                  'h-8 rounded-lg border px-3 text-sm font-medium',
                  'text-[var(--confirm-btn-secondary-text)] border-[var(--confirm-btn-secondary-border)]',
                  'hover:bg-[var(--confirm-btn-secondary-hover)]',
                )}
              >
                {t(
                  phase.kind === 'error'
                    ? 'settings.providers.manifest.close'
                    : 'settings.providers.manifest.cancel',
                )}
              </button>
            </AlertDialog.Cancel>
            {phase.kind === 'ready' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onConfirm(phase.preset)}
                className={cn(
                  'h-8 rounded-lg px-3 text-sm font-medium',
                  'text-[var(--confirm-btn-primary-text)] bg-[var(--confirm-btn-primary-bg)]',
                  'hover:bg-[var(--confirm-btn-primary-hover)]',
                )}
              >
                {t('settings.providers.manifest.confirm')}
              </button>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
