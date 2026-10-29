/**
 * 「远程连接 → 中转服务」:选择设备之间经 Cindy 官方中转,还是用户自己的中转
 * (这台电脑当中转 / 部署到自己的服务器 / 加入别的中转)。方案见 docs/self-hosted-relay-plan.md。
 *
 * 状态以 main 为准(`window.electronAPI.selfHostedRelay`):命令返回最新状态,另有 CHANGED 推送;
 * 连接问题(被移出中转)来自 device-link 链路,低频轮询兜底。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as QRCode from 'qrcode';

import { Button } from '@/components/ui/button';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import {
  DEFAULT_RELAY_PORT,
  normalizeRelayAddress,
  RELAY_DEPLOY_STEPS,
  type SelfHostedRelayCommand,
  type SelfHostedRelayDeployJobView,
  type SelfHostedRelayErrorCode,
  type SelfHostedRelayState,
} from '../../../shared/selfHostedRelay';

const STATE_POLL_MS = 3_000;

export function useSelfHostedRelayState(enabled: boolean) {
  const [state, setState] = useState<SelfHostedRelayState | null>(null);
  const [error, setError] = useState<SelfHostedRelayErrorCode | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = window.electronAPI?.selfHostedRelay;
    if (!enabled || !api) return;
    let active = true;
    const refresh = () => {
      void api
        .command({ type: 'state' })
        .then((result) => {
          if (active) setState(result.state);
        })
        .catch(() => undefined);
    };
    refresh();
    const off = api.onChanged((next) => {
      if (active) setState(next);
    });
    const timer = setInterval(refresh, STATE_POLL_MS);
    return () => {
      active = false;
      off();
      clearInterval(timer);
    };
  }, [enabled]);

  const run = useCallback(async (command: SelfHostedRelayCommand): Promise<boolean> => {
    const api = window.electronAPI?.selfHostedRelay;
    if (!api) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await api.command(command);
      setState(result.state);
      if (result.error) setError(result.error);
      return !result.error;
    } catch {
      setError('FAILED');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, error, busy, run, clearError: () => setError(null) };
}

export type SelfHostedRelayController = ReturnType<typeof useSelfHostedRelayState>;

/** 收起态摘要:官方 / 本机中转 / 已加入的中转名。 */
export function relaySummary(
  state: SelfHostedRelayState | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!state) return null;
  if (state.mode === 'official' || !state.relay) return t('settings.remoteControl.relay.summary.official');
  if (state.relay.origin === 'host') return t('settings.remoteControl.relay.summary.owner');
  if (state.relay.origin === 'server') return t('settings.remoteControl.relay.summary.server', { name: state.relay.name });
  return t('settings.remoteControl.relay.summary.member', { name: state.relay.name });
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="flex flex-col gap-3 rounded-xl bg-[var(--settings-input-bg)] p-3">{children}</section>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{children}</p>;
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-12 leading-[1.5] text-[var(--error-fg)]">
      {children}
    </p>
  );
}

function HostForm({
  state,
  controller,
  onDone,
}: {
  state: SelfHostedRelayState;
  controller: SelfHostedRelayController;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [port, setPort] = useState(String(state.host.port || DEFAULT_RELAY_PORT));
  const [scope, setScope] = useState<'local' | 'all'>(state.host.listenAll ? 'all' : 'local');
  const [externalUrl, setExternalUrl] = useState(state.host.externalUrl ?? '');
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;
  const k = 'settings.remoteControl.relay.host';
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <p className="text-13 font-medium text-[var(--text-primary)]">{t(`${k}.title`)}</p>
        <Hint>{t(`${k}.hint`)}</Hint>
      </div>
      <label className="flex items-center justify-between gap-4">
        <span className="text-13 text-[var(--text-primary)]">{t(`${k}.port`)}</span>
        <Input
          value={port}
          onChange={setPort}
          inputMode="numeric"
          size="sm"
          className="w-28"
          error={!portValid}
          ariaLabel={t(`${k}.port`)}
        />
      </label>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <span className="text-13 text-[var(--text-primary)]">{t(`${k}.scope`)}</span>
          <SegmentedControl
            aria-label={t(`${k}.scope`)}
            value={scope}
            onValueChange={setScope}
            options={[
              { value: 'local', label: t(`${k}.scopeLocal`) },
              { value: 'all', label: t(`${k}.scopeAll`) },
            ]}
          />
        </div>
        <Hint>{t(scope === 'all' ? `${k}.scopeAllHint` : `${k}.scopeLocalHint`)}</Hint>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-13 text-[var(--text-primary)]">{t(`${k}.externalUrl`)}</span>
        <Input
          value={externalUrl}
          onChange={setExternalUrl}
          placeholder={t(`${k}.externalUrlPlaceholder`)}
          size="sm"
          mono
          ariaLabel={t(`${k}.externalUrl`)}
        />
        <Hint>{t(scope === 'all' ? `${k}.externalUrlHintAll` : `${k}.externalUrlHintLocal`)}</Hint>
        {state.host.suggestedUrls.length > 0 ? (
          <Hint>
            {t(`${k}.suggested`)} <span className="font-mono">{state.host.suggestedUrls.join('  ')}</span>
          </Hint>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onDone} disabled={controller.busy}>
          {t(`${k}.cancel`)}
        </Button>
        <Button
          size="sm"
          loading={controller.busy}
          disabled={!portValid || controller.busy}
          onClick={() => {
            void controller
              .run({
                type: 'enable-host',
                port: portNumber,
                listenAll: scope === 'all',
                externalUrl: externalUrl.trim() || null,
              })
              .then((ok) => {
                if (ok) onDone();
              });
          }}
        >
          {t(state.host.enabled ? `${k}.save` : `${k}.start`)}
        </Button>
      </div>
    </Card>
  );
}

function AddDevice({ state, controller }: { state: SelfHostedRelayState; controller: SelfHostedRelayController }) {
  const { t } = useTranslation();
  const [qr, setQr] = useState<string | null>(null);
  const link = state.joinLink?.link ?? null;
  const k = 'settings.remoteControl.relay.add';

  useEffect(() => {
    if (!link) {
      setQr(null);
      return;
    }
    let active = true;
    void QRCode.toDataURL(link, { margin: 2, width: 200 }).then((url) => {
      if (active) setQr(url);
    });
    return () => {
      active = false;
    };
  }, [link]);

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--border-default)] pt-3">
      {link ? (
        <>
          <Hint>{t(`${k}.hint`)}</Hint>
          <div className="flex items-start gap-4">
            {qr ? (
              <img src={qr} alt={t(`${k}.qrAlt`)} className="h-[160px] w-[160px] shrink-0 rounded-xl" />
            ) : (
              <div className="h-[160px] w-[160px] shrink-0 rounded-xl bg-[var(--surface-elevated)]" />
            )}
            <div className="flex min-w-0 flex-col gap-2">
              <p className="break-all font-mono text-12 text-[var(--text-secondary)]">{link}</p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(link).then(() => toast.success(t(`${k}.copied`)));
                  }}
                >
                  {t(`${k}.copy`)}
                </Button>
                <Button variant="secondary" size="sm" disabled={controller.busy} onClick={() => void controller.run({ type: 'create-join-link' })}>
                  {t(`${k}.newLink`)}
                </Button>
              </div>
            </div>
          </div>
          {state.pendingRequests.length === 0 ? <Hint>{t(`${k}.waiting`)}</Hint> : null}
        </>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <Hint>{t(`${k}.intro`)}</Hint>
          <Button size="sm" disabled={controller.busy} onClick={() => void controller.run({ type: 'create-join-link' })}>
            {t(`${k}.create`)}
          </Button>
        </div>
      )}
      {state.pendingRequests.map((request) => (
        <div
          key={request.requestId}
          className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border-default)] p-3"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p className="truncate text-13 font-medium text-[var(--text-primary)]">
              {t('settings.remoteControl.relay.requests.item', { name: request.deviceName })}
            </p>
            <p className="text-13 text-[var(--text-primary)]">
              {t('settings.remoteControl.relay.requests.verify')}{' '}
              <span className="font-mono text-16 font-medium tracking-[0.2em]">{request.verifyCode}</span>
            </p>
            {request.verified ? (
              <Hint>
                {t('settings.remoteControl.relay.requests.verifyHint')}
                {request.replacesExisting ? ` ${t('settings.remoteControl.relay.requests.replaces')}` : ''}
              </Hint>
            ) : (
              <ErrorText>{t('settings.remoteControl.relay.requests.unverified')}</ErrorText>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={controller.busy}
              onClick={() => void controller.run({ type: 'decide', requestId: request.requestId, approve: false })}
            >
              {t('settings.remoteControl.relay.requests.reject')}
            </Button>
            <Button
              size="sm"
              disabled={controller.busy || !request.verified}
              onClick={() => void controller.run({ type: 'decide', requestId: request.requestId, approve: true })}
            >
              {t('settings.remoteControl.relay.requests.approve')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function JoinForm({
  state,
  controller,
  onDone,
}: {
  state: SelfHostedRelayState;
  controller: SelfHostedRelayController;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [link, setLink] = useState('');
  const k = 'settings.remoteControl.relay.join';
  const join = state.join;
  const inProgress = join.status === 'connecting' || join.status === 'waiting';
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <p className="text-13 font-medium text-[var(--text-primary)]">{t(`${k}.title`)}</p>
        <Hint>{t(`${k}.hint`)}</Hint>
      </div>
      {join.status === 'waiting' ? (
        <div className="flex flex-col gap-2">
          <p className="text-13 text-[var(--text-primary)]">{t(`${k}.waiting`, { name: join.relayName })}</p>
          <p className="font-mono text-24 font-medium tracking-[0.3em] text-[var(--text-primary)]">{join.verifyCode}</p>
        </div>
      ) : join.status === 'connecting' ? (
        <Hint>{t(`${k}.connecting`)}</Hint>
      ) : (
        <Input
          value={link}
          onChange={setLink}
          placeholder={t(`${k}.placeholder`)}
          size="sm"
          mono
          ariaLabel={t(`${k}.placeholder`)}
        />
      )}
      {join.status === 'failed' ? <ErrorText>{t(`settings.remoteControl.relay.errors.${join.error}`)}</ErrorText> : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            if (inProgress) void controller.run({ type: 'cancel-join' });
            onDone();
          }}
        >
          {t(`${k}.cancel`)}
        </Button>
        {!inProgress ? (
          <Button
            size="sm"
            disabled={!link.trim() || controller.busy}
            onClick={() => void controller.run({ type: 'join', link: link.trim() })}
          >
            {t(`${k}.submit`)}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

type SshHostOption = { id: string; label: string; hostname: string };

function useSshHosts(enabled: boolean): SshHostOption[] | null {
  const [hosts, setHosts] = useState<SshHostOption[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void window.electronAPI.remoteSsh
      .list()
      .then((res) => {
        if (!active) return;
        setHosts(
          res.hosts.map((host) => ({
            id: host.config.id,
            label: host.config.displayName || host.config.id,
            hostname: host.config.hostname,
          })),
        );
      })
      .catch(() => {
        if (active) setHosts([]);
      });
    return () => {
      active = false;
    };
  }, [enabled]);
  return hosts;
}

function DeployForm({
  state,
  controller,
  onDone,
}: {
  state: SelfHostedRelayState;
  controller: SelfHostedRelayController;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const k = 'settings.remoteControl.relay.deploy';
  const hosts = useSshHosts(true);
  const previous = state.deployment;
  const [hostId, setHostId] = useState(previous?.sshHostId ?? '');
  const [address, setAddress] = useState(previous?.address ?? '');
  const [name, setName] = useState(previous?.name ?? t(`${k}.defaultName`));
  const [addressTouched, setAddressTouched] = useState(Boolean(previous));

  // 选服务器时,访问地址默认取 SSH 主机地址(是 IP 或域名时),用户可以改。
  useEffect(() => {
    if (!hosts || hosts.length === 0) return;
    const selected = hosts.find((host) => host.id === hostId) ?? hosts[0];
    if (!hostId) setHostId(selected.id);
    if (!addressTouched) setAddress(normalizeRelayAddress(selected.hostname) ?? '');
  }, [hosts, hostId, addressTouched]);

  const normalized = normalizeRelayAddress(address);
  const canSubmit = Boolean(hostId && normalized && name.trim()) && !controller.busy;
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <p className="text-13 font-medium text-[var(--text-primary)]">{t(`${k}.title`)}</p>
        <Hint>{t(`${k}.hint`)}</Hint>
        <Hint>{t(`${k}.requirements`)}</Hint>
      </div>
      {hosts && hosts.length === 0 ? (
        <Hint>{t(`${k}.noHosts`)}</Hint>
      ) : (
        <>
          <label className="flex items-center justify-between gap-4">
            <span className="text-13 text-[var(--text-primary)]">{t(`${k}.server`)}</span>
            <Select
              label={t(`${k}.server`)}
              value={hostId}
              className="w-56"
              truncateOptions
              disabled={!hosts}
              onValueChange={(value) => {
                setHostId(value);
                setAddressTouched(false);
              }}
              options={(hosts ?? []).map((host) => ({ value: host.id, label: host.label }))}
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-13 text-[var(--text-primary)]">{t(`${k}.address`)}</span>
            <Input
              value={address}
              onChange={(value) => {
                setAddress(value);
                setAddressTouched(true);
              }}
              placeholder={t(`${k}.addressPlaceholder`)}
              size="sm"
              mono
              error={Boolean(address.trim()) && !normalized}
              ariaLabel={t(`${k}.address`)}
            />
            <Hint>{t(`${k}.addressHint`)}</Hint>
          </div>
          <label className="flex items-center justify-between gap-4">
            <span className="text-13 text-[var(--text-primary)]">{t(`${k}.name`)}</span>
            <Input value={name} onChange={setName} size="sm" className="w-56" ariaLabel={t(`${k}.name`)} />
          </label>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onDone} disabled={controller.busy}>
          {t(`${k}.cancel`)}
        </Button>
        <Button
          size="sm"
          disabled={!canSubmit}
          onClick={() => {
            void controller
              .run({ type: 'deploy', sshHostId: hostId, address: normalized!, name: name.trim(), replaceExisting: false })
              .then((ok) => {
                if (ok) onDone();
              });
          }}
        >
          {t(`${k}.submit`)}
        </Button>
      </div>
    </Card>
  );
}

function DeployProgress({
  job,
  state,
  controller,
}: {
  job: SelfHostedRelayDeployJobView;
  state: SelfHostedRelayState;
  controller: SelfHostedRelayController;
}) {
  const { t } = useTranslation();
  const k = 'settings.remoteControl.relay.deploy';
  const steps = job.action === 'uninstall' ? (['connect', 'configure', 'finish'] as const) : RELAY_DEPLOY_STEPS;
  const currentIndex = steps.indexOf(job.step as (typeof steps)[number]);
  const deployment = state.deployment;
  const retry = (replaceExisting: boolean) => {
    if (!deployment) return;
    void controller.run(
      job.action === 'upgrade' && !replaceExisting
        ? { type: 'upgrade-deployment' }
        : { type: 'deploy', sshHostId: deployment.sshHostId, address: deployment.address, name: deployment.name, replaceExisting },
    );
  };
  return (
    <Card>
      <p className="text-13 font-medium text-[var(--text-primary)]">
        {t(job.status === 'done' ? `${k}.done.${job.action}` : `${k}.running.${job.action}`, {
          version: state.bundledRelayVersion ?? '',
        })}
      </p>
      {job.status !== 'done' ? (
        <ol className="flex flex-col gap-1.5">
          {steps.map((step, index) => {
            const done = index < currentIndex || job.status === 'done';
            const current = index === currentIndex;
            const failed = current && job.status === 'failed';
            return (
              <li key={step} className="flex items-center gap-2 text-13">
                <span
                  aria-hidden
                  className={
                    failed
                      ? 'h-2 w-2 rounded-full bg-[var(--error-fg)]'
                      : done
                        ? 'h-2 w-2 rounded-full bg-[var(--text-secondary)]'
                        : current
                          ? 'h-2 w-2 rounded-full motion-safe:animate-pulse bg-[var(--text-primary)]'
                          : 'h-2 w-2 rounded-full border border-[var(--border-default)]'
                  }
                />
                <span className={done || current ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}>
                  {t(`${k}.steps.${job.action === 'uninstall' && step === 'configure' ? 'remove' : step}`)}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {job.status === 'failed' && job.error ? (
        <div className="flex flex-col gap-1">
          <ErrorText>{t(`settings.remoteControl.relay.errors.${job.error}`)}</ErrorText>
          {job.detail ? <Hint>{t(`${k}.detail`, { detail: job.detail })}</Hint> : null}
        </div>
      ) : null}
      {job.status === 'failed' && job.action !== 'uninstall' && deployment ? (
        <div className="flex flex-wrap justify-end gap-2">
          {job.error === 'RELAY_MISMATCH' ? (
            <Button variant="secondary" size="sm" disabled={controller.busy} onClick={() => retry(true)}>
              {t(`${k}.replace`)}
            </Button>
          ) : null}
          <Button size="sm" disabled={controller.busy} onClick={() => retry(false)}>
            {t(`${k}.retry`)}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function DeploymentCard({ state, controller }: { state: SelfHostedRelayState; controller: SelfHostedRelayController }) {
  const { t } = useTranslation();
  const confirmDialog = useOptionalConfirmDialog();
  const deployment = state.deployment!;
  const running = state.deployJob?.status === 'running';
  const k = 'settings.remoteControl.relay.server';
  const confirm = async (title: string, description: string, confirmText: string) =>
    !confirmDialog || (await confirmDialog.confirm({ title, description, confirmText, confirmVariant: 'destructive' }));
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-12 text-[var(--text-tertiary)]">{t(`${k}.title`)}</p>
          <p className="truncate text-13 font-medium text-[var(--text-primary)]">{deployment.name}</p>
          <p className="truncate font-mono text-12 text-[var(--text-tertiary)]">{deployment.baseUrl}</p>
          <Hint>
            {deployment.relayVersion ? t(`${k}.version`, { version: deployment.relayVersion }) : t(`${k}.incomplete`)}
          </Hint>
        </div>
        {!deployment.active && deployment.relayVersion ? (
          <Button size="sm" disabled={controller.busy || running} onClick={() => void controller.run({ type: 'use-deployment' })}>
            {t('settings.remoteControl.relay.actions.useDeployment')}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {!deployment.relayVersion && !state.deployJob ? (
          <Button
            size="sm"
            disabled={controller.busy || running || !state.bundledRelayVersion}
            onClick={() => void controller.run({ type: 'deploy', sshHostId: deployment.sshHostId, address: deployment.address, name: deployment.name, replaceExisting: false })}
          >
            {t('settings.remoteControl.relay.deploy.retry')}
          </Button>
        ) : null}
        {deployment.upgradeAvailable ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={controller.busy || running}
            onClick={() => void controller.run({ type: 'upgrade-deployment' })}
          >
            {t(`${k}.upgrade`, { version: state.bundledRelayVersion ?? '' })}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          disabled={controller.busy || running}
          onClick={() => {
            void confirm(t(`${k}.forgetTitle`), t(`${k}.forgetDescription`), t(`${k}.forget`)).then((ok) => {
              if (ok) void controller.run({ type: 'forget-deployment' });
            });
          }}
        >
          {t(`${k}.forget`)}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={controller.busy || running}
          onClick={() => {
            void confirm(t(`${k}.uninstallTitle`), t(`${k}.uninstallDescription`), t(`${k}.uninstall`)).then((ok) => {
              if (ok) void controller.run({ type: 'uninstall-deployment', removeData: true });
            });
          }}
        >
          {t(`${k}.uninstall`)}
        </Button>
      </div>
    </Card>
  );
}

export function RelayServicePanel({ controller }: { controller: SelfHostedRelayController }) {
  const { t } = useTranslation();
  const confirmDialog = useOptionalConfirmDialog();
  const [form, setForm] = useState<'none' | 'host' | 'join' | 'deploy'>('none');
  const { state, error } = controller;
  const k = 'settings.remoteControl.relay';

  // 加入成功后收起表单(main 已切换中转)。
  useEffect(() => {
    if (state?.join.status === 'joined' && form === 'join') setForm('none');
  }, [state?.join.status, form]);

  if (!state) return null;
  if (!state.available) {
    return (
      <Card>
        <Hint>{t(`${k}.unavailable`)}</Hint>
      </Card>
    );
  }

  const relay = state.relay;
  const isHost = relay?.origin === 'host';
  const isServer = relay?.origin === 'server';
  const isOwner = relay?.role === 'owner';
  const currentLabel = !relay ? t(`${k}.summary.official`) : isHost ? t(`${k}.ownerName`) : relay.name;
  const confirmKey = isHost ? 'owner' : isServer ? 'server' : 'member';
  const job = state.deployJob;

  const switchToOfficial = async () => {
    const ok = !confirmDialog || (await confirmDialog.confirm({
      title: t(`${k}.confirm.${confirmKey}Title`),
      description: t(`${k}.confirm.${confirmKey}Description`, { name: relay?.name ?? '' }),
      confirmText: t(`${k}.actions.useOfficial`),
      confirmVariant: isHost ? 'destructive' : 'default',
    }));
    if (ok) {
      setForm('none');
      await controller.run({ type: 'use-official' });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Hint>{t(`${k}.description`)}</Hint>
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-12 text-[var(--text-tertiary)]">{t(`${k}.current`)}</p>
            <p className="truncate text-13 font-medium text-[var(--text-primary)]">{currentLabel}</p>
            {relay ? <p className="truncate font-mono text-12 text-[var(--text-tertiary)]">{relay.baseUrl}</p> : null}
          </div>
          {relay ? (
            <Button variant="secondary" size="sm" disabled={controller.busy} onClick={() => void switchToOfficial()}>
              {t(`${k}.actions.useOfficial`)}
            </Button>
          ) : null}
        </div>
        {state.issue ? (
          <ErrorText>
            {t(`${k}.issue.${state.issue}`)} {t(`${k}.issue.next`)}
          </ErrorText>
        ) : null}
        {isHost && state.host.error ? (
          <ErrorText>{t(`${k}.errors.${state.host.error}`, { port: state.host.port })}</ErrorText>
        ) : null}
        {isHost && state.host.running ? (
          <>
            <Hint>
              {t(`${k}.host.running`, {
                address: state.host.externalUrl ?? state.host.suggestedUrls[0] ?? `127.0.0.1:${state.host.port}`,
              })}
            </Hint>
            <AddDevice state={state} controller={controller} />
          </>
        ) : null}
        {isServer ? <AddDevice state={state} controller={controller} /> : null}
        {relay ? <Hint>{t(`${k}.limits`)}</Hint> : null}
        {!relay && form === 'none' ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setForm('join')}>
              {t(`${k}.actions.join`)}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setForm('host')}>
              {t(`${k}.actions.host`)}
            </Button>
            {!state.deployment ? (
              <Button size="sm" disabled={!state.bundledRelayVersion} onClick={() => setForm('deploy')}>
                {t(`${k}.actions.deploy`)}
              </Button>
            ) : null}
          </div>
        ) : null}
        {isHost && form === 'none' ? (
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => setForm('host')}>
              {t(`${k}.actions.editHost`)}
            </Button>
          </div>
        ) : null}
      </Card>
      {error && error !== 'CANCELLED' ? (
        <ErrorText>{t(`${k}.errors.${error}`, { port: state.host.port })}</ErrorText>
      ) : null}
      {form === 'host' ? (
        <HostForm
          state={state}
          controller={controller}
          onDone={() => {
            controller.clearError();
            setForm('none');
          }}
        />
      ) : null}
      {job && (job.status !== 'done' || form === 'none') ? <DeployProgress job={job} state={state} controller={controller} /> : null}
      {state.deployment && form !== 'deploy' ? <DeploymentCard state={state} controller={controller} /> : null}
      {form === 'deploy' ? (
        <DeployForm
          state={state}
          controller={controller}
          onDone={() => {
            controller.clearError();
            setForm('none');
          }}
        />
      ) : null}
      {form === 'join' ? (
        <JoinForm
          state={state}
          controller={controller}
          onDone={() => {
            controller.clearError();
            setForm('none');
          }}
        />
      ) : null}
    </div>
  );
}
