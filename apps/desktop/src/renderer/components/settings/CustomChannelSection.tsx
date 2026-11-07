/**
 * CustomChannelSection —— 设置 → IM 机器人 →「自定义渠道」。
 *
 * 用户给自己的系统接一条 HTTP 渠道: 填名称与可选回调地址, Cindy 生成 token 并
 * 展示一次; 入站地址形如 http://127.0.0.1:<port>/im/custom/<id>/inbound。
 * 与伙伴页那份分开存(这里没有伙伴, 消息进 IM 机器人自己的会话)。
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Copy, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Collapse } from '@/components/ui/collapse';
import { extractIpcError } from '@/utils/ipcError';
import { cn } from '@/lib/utils';

interface CustomChannelView {
  id: string;
  displayName: string;
  callbackUrl: string | null;
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string | null;
  inboundUrl: string;
  socketPath?: string;
  token?: string;
}

function api() {
  return window.electronAPI.botImConnection?.customChannels ?? null;
}

export function CustomChannelSection({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [connections, setConnections] = useState<CustomChannelView[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 刚添加/轮换的 token 只展示一次, 不入列表投影。 */
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    const client = api();
    if (!client) return;
    void client
      .list()
      .then((payload: { connections: unknown[] }) =>
        setConnections(payload.connections as CustomChannelView[]),
      )
      .catch(() => setConnections([]));
  }, []);

  useEffect(() => {
    if (expanded) refresh();
  }, [expanded, refresh]);

  const add = async () => {
    const client = api();
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = (await client.add({
        displayName: displayName.trim(),
        callbackUrl: callbackUrl.trim() || null,
      })) as CustomChannelView;
      if (created.token) setRevealed((prev) => ({ ...prev, [created.id]: created.token as string }));
      setDisplayName('');
      setCallbackUrl('');
      refresh();
    } catch (failure) {
      setError(extractIpcError(failure)?.message ?? t('settings.imBot.custom.failed'));
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (id: string) => {
    const client = api();
    if (!client) return;
    const ok = await confirm({
      title: t('settings.imBot.custom.rotateTitle'),
      description: t('settings.imBot.custom.rotateBody'),
    });
    if (!ok) return;
    try {
      const next = (await client.rotateToken({ id })) as CustomChannelView;
      if (next.token) setRevealed((prev) => ({ ...prev, [id]: next.token as string }));
      refresh();
    } catch (failure) {
      setError(extractIpcError(failure)?.message ?? t('settings.imBot.custom.failed'));
    }
  };

  const remove = async (id: string) => {
    const client = api();
    if (!client) return;
    const ok = await confirm({
      title: t('settings.imBot.custom.removeTitle'),
      description: t('settings.imBot.custom.removeBody'),
    });
    if (!ok) return;
    await client.remove({ id });
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    refresh();
  };

  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl',
        'border border-[var(--settings-theme-card-border)]',
        'bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-h-[76px] w-full items-center gap-4 px-4 py-3 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-14 font-medium leading-[1.3] text-[var(--settings-section-title)]">
            {t('settings.imBot.custom.title')}
          </span>
          <span className="mt-1 block text-12 leading-[1.45] text-[var(--settings-section-desc)]">
            {t('settings.imBot.custom.description')}
          </span>
        </span>
        <span className="shrink-0 text-12 text-[var(--text-secondary)]">
          {t('settings.imBot.custom.count', { count: connections.length })}
        </span>
        <ChevronDown
          size={17}
          aria-hidden
          className={cn('shrink-0 transition-transform', expanded && 'rotate-180')}
        />
      </button>

      <Collapse
        open={expanded}
        innerClassName="border-t border-[var(--settings-theme-card-border)]"
      >
        <div className="flex flex-col gap-4 p-4">
          {connections.length === 0 ? (
            <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
              {t('settings.imBot.custom.empty')}
            </p>
          ) : (
            connections.map((connection) => (
              <div
                key={connection.id}
                className="flex flex-col gap-2 rounded-xl border border-[var(--settings-theme-card-border)] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-13 font-medium text-[var(--text-primary)]">
                    {connection.displayName}
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void rotate(connection.id)}
                    >
                      <RefreshCw size={13} aria-hidden />
                      {t('settings.imBot.custom.rotate')}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void remove(connection.id)}
                    >
                      <Trash2 size={13} aria-hidden />
                    </Button>
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-11 text-[var(--text-tertiary)]">
                    {t('settings.imBot.custom.inbound')}
                  </span>
                  <code className="break-all rounded-lg bg-[var(--surface-chip)] px-2 py-1 text-11">
                    {connection.inboundUrl}
                  </code>
                  {connection.socketPath ? (
                    <code className="break-all rounded-lg bg-[var(--surface-chip)] px-2 py-1 text-11">
                      --unix-socket {connection.socketPath}
                    </code>
                  ) : null}
                </div>
                {revealed[connection.id] ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-11 text-[var(--text-tertiary)]">
                      {t('settings.imBot.custom.token')}
                    </span>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 break-all rounded-lg bg-[var(--surface-chip)] px-2 py-1 text-11">
                        {revealed[connection.id]}
                      </code>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void navigator.clipboard.writeText(revealed[connection.id])}
                      >
                        <Copy size={13} aria-hidden />
                      </Button>
                    </div>
                    <span className="text-11 text-[var(--text-tertiary)]">
                      {t('settings.imBot.custom.tokenOnce')}
                    </span>
                  </div>
                ) : null}
                {connection.callbackUrl ? (
                  <span className="break-all text-11 text-[var(--text-tertiary)]">
                    {t('settings.imBot.custom.callback', { url: connection.callbackUrl })}
                  </span>
                ) : null}
              </div>
            ))
          )}

          <div className="flex flex-col gap-3 border-t border-[var(--settings-theme-card-border)] pt-4">
            <FormField label={t('settings.imBot.custom.nameLabel')}>
              {(control) => (
                <Input
                  {...control}
                  value={displayName}
                  onChange={setDisplayName}
                  placeholder={t('settings.imBot.custom.namePlaceholder')}
                  disabled={busy}
                />
              )}
            </FormField>
            <FormField label={t('settings.imBot.custom.callbackLabel')}>
              {(control) => (
                <Input
                  {...control}
                  mono
                  value={callbackUrl}
                  onChange={setCallbackUrl}
                  placeholder="http://127.0.0.1:8080/hook"
                  disabled={busy}
                />
              )}
            </FormField>
            {error ? (
              <p role="alert" className="text-12 text-[var(--error-fg)]">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button
                type="button"
                variant="cta"
                size="md"
                loading={busy}
                disabled={busy || !displayName.trim()}
                onClick={() => void add()}
              >
                <Plus size={14} aria-hidden />
                {t('settings.imBot.custom.add')}
              </Button>
            </div>
          </div>
        </div>
      </Collapse>
    </section>
  );
}
