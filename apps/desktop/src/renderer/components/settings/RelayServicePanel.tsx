/**
 * 「远程连接 → 连接线路」:设备之间经 Cindy 官方中转,还是用户自己的中转
 * (部署到自己的服务器 / 这台电脑当中转 / 加入别的中转)。方案见 docs/self-hosted-relay-plan.md。
 *
 * 紧跟在「我的设备」下面直接展示:单选的线路列表(选中的那条就是正在用的)、服务器中转的管理
 * (可以部署到多台服务器,每台一行),以及三步部署窗口(选择服务器 → 部署 → 完成)。
 * 部署完成不切换线路,改用哪条由用户自己切换。
 *
 * 状态以 main 为准(`window.electronAPI.selfHostedRelay`):命令返回最新状态,另有 CHANGED 推送;
 * 连接问题(被移出中转)来自 device-link 链路,低频轮询兜底。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import {
  ArrowRightLeft,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Cloud,
  Info,
  Link2,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import * as QRCode from 'qrcode';

import { Button } from '@/components/ui/button';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  DEFAULT_RELAY_PORT,
  normalizeRelayAddress,
  normalizeRelayName,
  RELAY_DEPLOY_STEPS,
  RELAY_NAME_MAX_LENGTH,
  RELAY_UNINSTALL_STEPS,
  type SelfHostedRelayCommand,
  type SelfHostedRelayCommandResult,
  type SelfHostedRelayDeployJobView,
  type SelfHostedRelayDeploymentStatus,
  type SelfHostedRelayDeploymentView,
  type SelfHostedRelayErrorCode,
  type SelfHostedRelayServerCheck,
  type SelfHostedRelayState,
  type RelayDeployLogEntry,
} from '../../../shared/selfHostedRelay';

const STATE_POLL_MS = 3_000;

export function useSelfHostedRelayState(enabled: boolean) {
  const [state, setState] = useState<SelfHostedRelayState | null>(null);
  const [error, setError] = useState<SelfHostedRelayErrorCode | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
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

  const request = useCallback(async (command: SelfHostedRelayCommand): Promise<SelfHostedRelayCommandResult | null> => {
    const api = window.electronAPI?.selfHostedRelay;
    if (!api) return null;
    setBusy(true);
    setError(null);
    setErrorDetail(undefined);
    try {
      const result = await api.command(command);
      setState(result.state);
      if (result.error) {
        setError(result.error);
        return null;
      }
      return result;
    } catch {
      setError('FAILED');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const run = useCallback(async (command: SelfHostedRelayCommand) => Boolean(await request(command)), [request]);
  const checkServer = useCallback(async (sshHostId: string) => {
    const result = await request({ type: 'check-server', sshHostId });
    if (!result) return null;
    if (result.check?.ok) return result.check;
    setError(result.check?.error ?? 'FAILED');
    setErrorDetail(result.check?.detail);
    return null;
  }, [request]);

  return { state, error, errorDetail, busy, run, checkServer, clearError: () => { setError(null); setErrorDetail(undefined); } };
}

export type SelfHostedRelayController = ReturnType<typeof useSelfHostedRelayState>;

function Card({ children }: { children: React.ReactNode }) {
  return <section className="flex flex-col gap-4 rounded-xl bg-[var(--settings-input-bg)] p-4">{children}</section>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{children}</p>;
}

/** 错误只在图标上用红色,说明文字保持正常颜色(DESIGN.md「Error notices」)。 */
function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2">
      <LineIcon tone="failed" />
      <p className="min-w-0 flex-1 text-12 leading-5 text-[var(--text-secondary)]">{children}</p>
    </div>
  );
}

/**
 * 加入别的中转、这台电脑当中转的设置:用与部署窗口同一套外框的小窗口,不在线路列表下面展开。
 * 点窗口外面不关闭,免得填到一半丢失;Esc 和「取消」照常关闭。
 */
function FormDialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          className="modal-panel fixed left-1/2 top-1/2 z-[10001] flex max-h-[88vh] w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col outline-none"
        >
          <div className="flex flex-col gap-1 px-4 pb-4 pt-4">
            <Dialog.Title className="text-16 font-semibold text-[var(--confirm-title)]">{title}</Dialog.Title>
            <Dialog.Description className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{description}</Dialog.Description>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 窗口里命令失败的原因;用户取消不算失败。 */
function CommandError({ error, port, detail = '' }: { error: SelfHostedRelayErrorCode | null; port: number; detail?: string }) {
  const { t } = useTranslation();
  if (!error || error === 'CANCELLED') return null;
  return <ErrorText>{t(`settings.remoteControl.relay.errors.${error}`, { port, detail })}</ErrorText>;
}

/** 这台电脑当中转的设置。还没在用时,开启就是切换到它:`notice` 写清楚原线路会怎样。 */
function HostForm({
  state,
  controller,
  notice,
  onDone,
}: {
  state: SelfHostedRelayState;
  controller: SelfHostedRelayController;
  notice: string | null;
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
    <>
      <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
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
        {notice ? (
          <p className="flex items-start gap-2 text-12 leading-[1.5] text-[var(--text-secondary)]">
            <Info aria-hidden size={13} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
            {notice}
          </p>
        ) : null}
        <CommandError error={controller.error} port={portValid ? portNumber : state.host.port} />
      </div>
      <DialogFooter>
        <Button variant="secondary" size="sm" onClick={onDone} disabled={controller.busy}>
          {t(`${k}.cancel`)}
        </Button>
        <Button
          variant="cta"
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
      </DialogFooter>
    </>
  );
}

function AddDevice({
  state,
  controller,
  bare = false,
}: {
  state: SelfHostedRelayState;
  controller: SelfHostedRelayController;
  /** 已放在有边界的区域里时不再画顶部分隔线。 */
  bare?: boolean;
}) {
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
    <div className={cn('flex flex-col gap-3', !bare && 'border-t border-[var(--border-default)] pt-3')}>
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

/** 加入别的中转:粘贴链接 → 等主人同意(显示配对码)。加入成功后窗口由外层关闭。 */
function JoinForm({
  state,
  controller,
  onClose,
}: {
  state: SelfHostedRelayState;
  controller: SelfHostedRelayController;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [link, setLink] = useState('');
  const k = 'settings.remoteControl.relay.join';
  const join = state.join;
  const inProgress = join.status === 'connecting' || join.status === 'waiting';
  return (
    <>
      <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
        {join.status === 'waiting' ? (
          <div className="flex flex-col gap-2">
            <p className="text-13 text-[var(--text-primary)]">{t(`${k}.waiting`, { name: join.relayName })}</p>
            <p className="font-mono text-24 font-medium tracking-[0.3em] text-[var(--text-primary)]">{join.verifyCode}</p>
          </div>
        ) : join.status === 'connecting' ? (
          <p className="inline-flex items-center gap-2 text-13 text-[var(--text-secondary)]">
            <Spinner size={12} />
            {t(`${k}.connecting`)}
          </p>
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
        {join.status === 'failed' ? (
          <ErrorText>{t(`settings.remoteControl.relay.errors.${join.error}`)}</ErrorText>
        ) : (
          <CommandError error={controller.error} port={state.host.port} />
        )}
      </div>
      <DialogFooter>
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t(`${k}.cancel`)}
        </Button>
        {!inProgress ? (
          <Button
            variant="cta"
            size="sm"
            disabled={!link.trim() || controller.busy}
            onClick={() => void controller.run({ type: 'join', link: link.trim() })}
          >
            {t(`${k}.submit`)}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}

type SshHostOption = { id: string; label: string; hostname: string; user: string };

/** 下拉里带上登录账号:`git@…` 这类只能做 Git 操作的主机一眼就能认出来。 */
function hostOptionLabel(host: SshHostOption): string {
  const account = `${host.user}@${host.hostname}`;
  return host.label === host.hostname ? account : `${host.label} · ${account}`;
}

/** `refreshKey` 变化时重新读取:打开部署表单时拿到刚在「远程」里加的主机。 */
function useSshHosts(enabled: boolean, refreshKey: unknown): SshHostOption[] | null {
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
            user: host.config.user,
          })),
        );
      })
      .catch(() => {
        if (active) setHosts([]);
      });
    return () => {
      active = false;
    };
  }, [enabled, refreshKey]);
  return hosts;
}

/** 部署表单的初始值;`relayId` 是继续或修改的那条部署记录。 */
type DeployTarget = { sshHostId: string; address: string; name: string; relayId?: string };

const DEPLOY = 'settings.remoteControl.relay.deploy';
const SERVER = 'settings.remoteControl.relay.server';
/** 这些错误的 detail(程序名、容器名)已写进提示文字,不再单独展开。 */
const DETAIL_IN_MESSAGE = new Set<SelfHostedRelayErrorCode>(['PORT_BUSY', 'PORT_BUSY_CONTAINER']);

function hostLabel(hosts: SshHostOption[] | null, id: string): string {
  return hosts?.find((host) => host.id === id)?.label ?? id;
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function useConfirm() {
  const confirmDialog = useOptionalConfirmDialog();
  return useCallback(
    async (title: string, description: string, confirmText: string) =>
      !confirmDialog || (await confirmDialog.confirm({ title, description, confirmText, confirmVariant: 'destructive' })),
    [confirmDialog],
  );
}

/** 运行中每秒刷新用时;结束后停止计时并保留最终用时。 */
function useElapsed(job: SelfHostedRelayDeployJobView | null): number | null {
  const running = job?.status === 'running';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running, job?.startedAt]);
  if (job?.startedAt === undefined) return null;
  const end = running ? now : job.finishedAt;
  return end === undefined ? null : Math.max(0, Math.floor((end - job.startedAt) / 1_000));
}

type LineTone = 'progress' | 'done' | 'ok' | 'warning' | 'failed' | 'pending';

/** 步骤与状态行左侧的图标:颜色只用在图标上,文字保持正常颜色。 */
function LineIcon({ tone }: { tone: LineTone }) {
  return (
    <span aria-hidden className="flex h-5 w-4 shrink-0 items-center justify-center">
      {tone === 'progress' ? (
        <Spinner size={14} className="text-[var(--text-primary)]" />
      ) : tone === 'failed' ? (
        <CircleAlert size={14} className="text-[var(--error-fg)]" />
      ) : tone === 'warning' ? (
        <TriangleAlert size={14} className="text-[var(--warning-fg)]" />
      ) : tone === 'ok' ? (
        <CircleCheck size={14} className="text-[var(--status-success)]" />
      ) : tone === 'done' ? (
        <Check size={14} className="text-[var(--text-secondary)]" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--border-default)]" />
      )}
    </span>
  );
}

function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group text-12 text-[var(--text-tertiary)]">
      <summary className="flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 hover:text-[var(--text-secondary)] [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          aria-hidden
          className="transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        {label}
      </summary>
      <div className="mt-1 pl-4">{children}</div>
    </details>
  );
}

/** 出了什么问题、怎么处理;服务器返回的技术细节默认收起。 */
function FailureReason({ error, detail }: { error: SelfHostedRelayErrorCode; detail?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-12 leading-[1.6] text-[var(--text-secondary)]">
        {t(`settings.remoteControl.relay.errors.${error}`, { detail: detail ?? '' })}
      </p>
      {detail && !DETAIL_IN_MESSAGE.has(error) ? (
        <Disclosure label={t(`${DEPLOY}.showDetails`)}>
          <p className="select-text break-words font-mono leading-[1.5]">{detail}</p>
        </Disclosure>
      ) : null}
    </div>
  );
}

function CardHeader({ eyebrow, title, subtitle, trailing }: {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        {eyebrow ? <p className="text-12 leading-5 text-[var(--text-tertiary)]">{eyebrow}</p> : null}
        <p className="truncate text-13 font-medium leading-5 text-[var(--text-primary)]">{title}</p>
        {subtitle ? <p className="truncate text-12 leading-5 text-[var(--text-tertiary)]">{subtitle}</p> : null}
      </div>
      {trailing ? <div className="shrink-0 text-12 leading-5 tabular-nums text-[var(--text-tertiary)]">{trailing}</div> : null}
    </div>
  );
}

/** 左边放清理类操作,右边放继续类操作;窄时整组换行。 */
function Actions({ start, children }: { start?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {start}
      <div className="ml-auto flex flex-wrap justify-end gap-2">{children}</div>
    </div>
  );
}

function stepLabel(t: (key: string) => string, step: RelayDeployLogEntry['step']) {
  return t(`${DEPLOY}.steps.${step}`);
}

/**
 * 依次列出这次任务的步骤:进行中的一步下面写实时进展(liveDetail=false 时由调用方放在固定位置),
 * 失败的一步下面写原因,失败后不再列出没执行的步骤。
 */
function JobSteps({ job, liveDetail = true }: { job: SelfHostedRelayDeployJobView; liveDetail?: boolean }) {
  const { t } = useTranslation();
  const steps = job.steps ?? (job.action === 'uninstall' ? RELAY_UNINSTALL_STEPS : RELAY_DEPLOY_STEPS);
  const found = steps.indexOf(job.step);
  const current = job.status === 'done' ? steps.length : found >= 0 ? found : job.step === 'finish' ? steps.length - 1 : 0;
  const failed = job.status === 'failed';
  const latest = job.logs?.at(-1);
  const visible = failed ? steps.slice(0, current + 1) : steps;
  return (
    <ol className="flex flex-col gap-2">
      {visible.map((step, index) => {
        const tone: LineTone = index < current ? 'done' : index > current ? 'pending' : failed ? 'failed' : 'progress';
        return (
          <li key={step} aria-current={tone === 'progress' ? 'step' : undefined} className="flex items-start gap-2">
            <LineIcon tone={tone} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span
                className={cn(
                  'text-13 leading-5',
                  tone === 'pending' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]',
                  (tone === 'progress' || tone === 'failed') && 'font-medium',
                )}
              >
                {stepLabel(t, step)}
              </span>
              {liveDetail && tone === 'progress' && latest?.message && latest.step === step ? (
                <p role="status" className="text-12 leading-[1.5] text-[var(--text-secondary)]">
                  {t(`${DEPLOY}.progress.${latest.message}`)}
                </p>
              ) : null}
              {tone === 'failed' && job.error ? <FailureReason error={job.error} detail={job.detail} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function JobLog({ job }: { job: SelfHostedRelayDeployJobView }) {
  const { t } = useTranslation();
  const logs = job.logs ?? [];
  if (logs.length === 0) return null;
  return (
    <Disclosure label={t(`${DEPLOY}.logs`)}>
      <ol className="flex max-h-40 select-text flex-col gap-1 overflow-y-auto text-[var(--text-secondary)]" aria-label={t(`${DEPLOY}.logs`)}>
        {logs.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="flex items-start gap-3 leading-[1.5]">
            <span className="shrink-0 font-mono tabular-nums text-[var(--text-tertiary)]">
              {formatDuration(Math.max(0, Math.floor((entry.at - (job.startedAt ?? entry.at)) / 1_000)))}
            </span>
            <span className="min-w-0 break-words">
              {entry.message ? t(`${DEPLOY}.progress.${entry.message}`) : stepLabel(t, entry.step)}
            </span>
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}

/** 移除失败(服务器连不上、上面的中转不归这台电脑管)时的退路。 */
function RemovalFallback({ controller, relayId }: { controller: SelfHostedRelayController; relayId: string }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  return (
    <Actions
      start={
        <Button
          variant="secondary"
          size="sm"
          disabled={controller.busy}
          onClick={() => {
            void confirm(t(`${SERVER}.forgetTitle`), t(`${SERVER}.forgetDescription`), t(`${SERVER}.forget`)).then((ok) => {
              if (ok) void controller.run({ type: 'forget-deployment', relayId });
            });
          }}
        >
          {t(`${SERVER}.forget`)}
        </Button>
      }
    >
      <Button size="sm" disabled={controller.busy} onClick={() => void controller.run({ type: 'uninstall-deployment', relayId, removeData: true })}>
        {t(`${DEPLOY}.retry`)}
      </Button>
    </Actions>
  );
}

/** 选服务器后自动做只读检查;换服务器或点「重新检查」时重来,旧结果不会盖过新结果。 */
function useServerCheck(sshHostId: string) {
  const [result, setResult] = useState<SelfHostedRelayServerCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const api = window.electronAPI?.selfHostedRelay;
    if (!sshHostId || !api) return;
    let active = true;
    setChecking(true);
    setResult(null);
    void api
      .command({ type: 'check-server', sshHostId })
      .then((res) => {
        if (active) setResult(res.check ?? { sshHostId, ok: false, error: res.error ?? 'FAILED' });
      })
      .catch(() => {
        if (active) setResult({ sshHostId, ok: false, error: 'FAILED' });
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [sshHostId, attempt]);
  return { result, checking, recheck: () => setAttempt((value) => value + 1) };
}

function ServerCheckLine({
  idle,
  check,
  checking,
  onRecheck,
}: {
  idle: boolean;
  check: SelfHostedRelayServerCheck | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  const { t } = useTranslation();
  const k = `${DEPLOY}.check`;
  let tone: LineTone = 'progress';
  let title = t(`${k}.checking`);
  let meta: string | null = null;
  let body: React.ReactNode = <p className="text-12 leading-[1.6] text-[var(--text-tertiary)]">{t(`${k}.checkingHint`)}</p>;
  if (idle) {
    tone = 'pending';
    title = t(`${k}.idle`);
    body = null;
  } else if (!checking && check && !check.ok) {
    tone = 'failed';
    title = t(`${k}.blocked`);
    body = <FailureReason error={check.error} detail={check.detail} />;
  } else if (!checking && check?.ok) {
    tone = check.existing === 'other' ? 'warning' : 'ok';
    title = t(`${k}.ready`);
    meta = check.system;
    const notes = [t(`${k}.${check.plan}`)];
    if (check.existing !== 'none') notes.push(t(`${k}.${check.existing}`));
    body = <p className="text-12 leading-[1.6] text-[var(--text-secondary)]">{notes.join(' ')}</p>;
  }
  return (
    <div role="status" className="flex items-start gap-2">
      <LineIcon tone={tone} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cn('text-13 leading-5', idle ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]')}>
          {title}
          {/* 行高收紧:小一号的字放在同一行里不把这一行撑高,检查结果出来时下面的表单不动。 */}
          {meta ? <span className="ml-2 text-12 leading-none text-[var(--text-tertiary)]">{meta}</span> : null}
        </p>
        {/* 未选、检查中、检查通过都先占两行说明的高度,结果出来时下面的表单不被推动。 */}
        <div className="min-h-[3.2em] text-12">{body}</div>
      </div>
      {tone === 'failed' ? (
        <Button variant="secondary" size="xs" compact onClick={onRecheck}>
          {t(`${k}.recheck`)}
        </Button>
      ) : null}
    </div>
  );
}

function FieldRow({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-13 text-[var(--text-primary)]">{label}</span>
        <div className="w-60 min-w-0 shrink">{children}</div>
      </div>
      {hint}
    </div>
  );
}

const ROUTE = 'settings.remoteControl.relay.route';
const DIALOG = 'settings.remoteControl.relay.dialog';
const MANAGE = 'settings.remoteControl.relay.manage';

/**
 * 线路行右侧只放同样大小的图标,贴右对齐:切换在前,这条线路自己的操作(改名、删除、设置)在后;
 * 没有的不占位,只有一个图标时它就在最右边。正在用的线路用名字旁边的绿点表示,不进这一列。
 */
function RouteSide({ switchAction, actions = [] }: { switchAction?: React.ReactNode; actions?: React.ReactNode[] }) {
  return (
    <>
      {[switchAction, ...actions].map((item, index) =>
        item ? <span key={index} className="flex w-7 shrink-0 justify-center">{item}</span> : null,
      )}
    </>
  );
}

/** 正在用的线路:名字旁边一个绿点,悬停和读屏给出「正在使用」。 */
function InUse() {
  const { t } = useTranslation();
  const label = t(`${SERVER}.inUse`);
  return (
    <Tip text={label}>
      <span role="img" aria-label={label} className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--status-success)]" />
      </span>
    </Tip>
  );
}

/** 部署窗口顶部的步骤条:当前步实心,已完成打勾,后面的描边(DESIGN.md「Multi-step dialogs」)。 */
function DialogSteps({ current }: { current: 0 | 1 | 2 }) {
  const { t } = useTranslation();
  const labels = [t(`${DIALOG}.steps.form`), t(`${DIALOG}.steps.deploy`), t(`${DIALOG}.steps.done`)];
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label={t(`${DIALOG}.steps.label`)}>
      {labels.map((label, index) => (
        <li key={label} className="flex items-center gap-1.5" aria-current={index === current ? 'step' : undefined}>
          {index > 0 ? <span aria-hidden className="h-px w-3 bg-[var(--border-default)]" /> : null}
          <span
            aria-hidden
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-11 font-medium',
              index < current && 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
              index === current && 'bg-[var(--accent-cta-bg)] text-[var(--surface-on-card)]',
              index > current && 'border border-[var(--border-default)] text-[var(--text-tertiary)]',
            )}
          >
            {index < current ? <Check size={11} /> : index + 1}
          </span>
          <span className={cn('text-12', index === current ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]')}>
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 部署进度:按已完成的步骤数算,失败或完成时不显示。 */
function DeployProgressBar({ job }: { job: SelfHostedRelayDeployJobView }) {
  const steps = job.steps ?? RELAY_DEPLOY_STEPS;
  const index = Math.max(0, steps.indexOf(job.step));
  const percent = Math.round(((index + 0.5) / steps.length) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1 overflow-hidden rounded-full bg-[var(--surface-chip)]"
    >
      <div
        className="h-full rounded-full bg-[var(--text-primary)] transition-[width] duration-300 motion-reduce:transition-none"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** 当前这一步的实时进展:固定在进度条下面占一行,内容变了只换文字,不推动下面的步骤列表。 */
function LiveProgress({ job }: { job: SelfHostedRelayDeployJobView }) {
  const { t } = useTranslation();
  const latest = job.logs?.at(-1);
  const text = latest?.message && latest.step === job.step ? t(`${DEPLOY}.progress.${latest.message}`) : '';
  return (
    <p role="status" title={text || undefined} className="min-h-[1.5em] truncate text-12 leading-[1.5] text-[var(--text-secondary)]">
      {text}
    </p>
  );
}

/** 第 1 步:选服务器后自动只读检查,检查通过才能开始。 */
function DeployFormStep({
  state,
  controller,
  hosts,
  initial,
  onCancel,
  onAbandon,
  onStarted,
}: {
  state: SelfHostedRelayState;
  controller: SelfHostedRelayController;
  hosts: SshHostOption[] | null;
  initial: DeployTarget | null;
  onCancel: () => void;
  onAbandon: (() => void) | null;
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const [hostId, setHostId] = useState(initial?.sshHostId ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [name, setName] = useState(initial?.name ?? t(`${DEPLOY}.defaultName`));
  const [addressTouched, setAddressTouched] = useState(Boolean(initial));
  const { result: check, checking, recheck } = useServerCheck(hostId);

  // 不替用户预选服务器:选了才连接检查。选中后访问地址默认取 SSH 主机地址(是 IP 或域名时),用户可以改。
  useEffect(() => {
    const selected = hosts?.find((host) => host.id === hostId);
    if (selected && !addressTouched) setAddress(normalizeRelayAddress(selected.hostname) ?? '');
  }, [hosts, hostId, addressTouched]);

  const normalized = normalizeRelayAddress(address);
  const ready = Boolean(!checking && check?.ok && check.sshHostId === hostId);
  // 服务器上的中转不归这台电脑:检查结果里已用警示写明后果,按钮也直接叫「清除并部署」。
  const replacing = Boolean(ready && check?.ok && check.existing === 'other');
  const canSubmit = ready && Boolean(normalized && name.trim() && state.bundledRelayVersion) && !controller.busy;

  const submit = async () => {
    const ok = await controller.run({
      type: 'deploy',
      sshHostId: hostId,
      address: normalized!,
      name: name.trim(),
      replaceExisting: replacing,
    });
    if (ok) onStarted();
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        {hosts && hosts.length === 0 ? (
          <Hint>{t(`${DEPLOY}.noHosts`)}</Hint>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <FieldRow label={t(`${DEPLOY}.server`)}>
                <Select
                  label={t(`${DEPLOY}.serverPlaceholder`)}
                  value={hostId}
                  className="w-full"
                  truncateOptions
                  disabled={!hosts}
                  onValueChange={(value) => {
                    setHostId(value);
                    setAddressTouched(false);
                  }}
                  options={(hosts ?? []).map((host) => ({ value: host.id, label: hostOptionLabel(host) }))}
                />
              </FieldRow>
              <div className="rounded-lg border border-[var(--border-default)] px-3 py-2.5">
                <ServerCheckLine idle={!hostId} check={check} checking={checking} onRecheck={recheck} />
              </div>
            </div>
            <FieldRow label={t(`${DEPLOY}.address`)} hint={<Hint>{t(`${DEPLOY}.addressHint`)}</Hint>}>
              <Input
                value={address}
                onChange={(value) => {
                  setAddress(value);
                  setAddressTouched(true);
                }}
                placeholder={t(`${DEPLOY}.addressPlaceholder`)}
                size="sm"
                mono
                className="w-full"
                error={Boolean(address.trim()) && !normalized}
                ariaLabel={t(`${DEPLOY}.address`)}
              />
            </FieldRow>
            <FieldRow label={t(`${DEPLOY}.name`)}>
              <Input value={name} onChange={setName} size="sm" className="w-full" ariaLabel={t(`${DEPLOY}.name`)} />
            </FieldRow>
          </>
        )}
      </div>
      <DialogFooter
        start={
          onAbandon ? (
            <Button variant="secondary" size="sm" disabled={controller.busy} onClick={onAbandon}>
              {t(`${DEPLOY}.abandon`)}
            </Button>
          ) : null
        }
      >
        <Button variant="secondary" size="sm" disabled={controller.busy} onClick={onCancel}>
          {t(`${DEPLOY}.cancel`)}
        </Button>
        <Button variant="cta" size="sm" disabled={!canSubmit} onClick={() => void submit()}>
          {t(replacing ? `${DEPLOY}.submitReplace` : `${DEPLOY}.submit`)}
        </Button>
      </DialogFooter>
    </>
  );
}

function DialogFooter({ start, children }: { start?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--border-default)] px-4 py-3">
      {start}
      <div className="ml-auto flex flex-wrap justify-end gap-2">{children}</div>
    </div>
  );
}

/**
 * 部署窗口:选择服务器 → 部署 → 完成。关掉窗口部署照样在后台继续,线路列表里那一行显示进度;
 * 失败时原因写在出错的那一步下面,可以重试、回到表单修改或放弃(清理服务器)。
 * 部署完成不切换线路:完成页给「使用这条线路」,切换照常先确认。
 */
function DeployDialog({
  open,
  onOpenChange,
  state,
  controller,
  hosts,
  initial,
  startInForm,
  openKey,
  onUse,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: SelfHostedRelayState;
  controller: SelfHostedRelayController;
  hosts: SshHostOption[] | null;
  initial: DeployTarget | null;
  /** 打开时直接显示表单(新部署、继续某条记录),不显示上一次任务的进度。 */
  startInForm: boolean;
  /** 列表每次打开窗口都换一个值;窗口为确认框临时关闭再打开时不变,不会退回表单。 */
  openKey: number;
  /** 完成页的「使用这条线路」:由列表弹切换确认。 */
  onUse: (relayId: string) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  // undefined:跟着部署任务显示;DeployTarget / null:显示表单(null 为空表单)。
  const [editing, setEditing] = useState<DeployTarget | null | undefined>(undefined);
  // 从任务的「修改设置」进来的表单,取消时回到任务;新开的表单取消就关窗口。
  const [backToJob, setBackToJob] = useState(false);
  const job = state.deployJob?.action === 'deploy' ? state.deployJob : null;
  const elapsed = useElapsed(job);
  useEffect(() => {
    setEditing(startInForm ? initial : undefined);
    setBackToJob(false);
    // 只跟着列表的打开动作重置(initial / startInForm 与 openKey 同时更新)。
  }, [openKey]);

  const view = editing !== undefined ? 'form' : job?.status === 'done' ? 'done' : job ? 'progress' : 'form';
  // 这次窗口对应的部署记录:修改中的、任务的、或打开时指定继续的那一条。
  const recordId = view === 'form' ? (editing ?? initial)?.relayId : job?.relayId;
  const record = state.deployments.find((deployment) => deployment.relayId === recordId) ?? null;
  const incomplete = Boolean(record && !record.relayVersion);
  const target = job?.target ?? record;
  const close = () => onOpenChange(false);
  // 确认框与本窗口同层,先关窗口再确认,确认框才不会被盖住。
  const abandon = () => {
    if (!record) return;
    const relayId = record.relayId;
    close();
    void confirm(t(`${DEPLOY}.abandonTitle`), t(`${DEPLOY}.abandonDescription`), t(`${DEPLOY}.abandon`)).then((ok) => {
      if (ok) void controller.run({ type: 'uninstall-deployment', relayId, removeData: true });
    });
  };
  const finish = () => {
    close();
    void controller.run({ type: 'dismiss-deploy-job' });
  };
  const done = view === 'done' && record?.relayVersion ? record : null;
  const canUse = Boolean(done && !done.active);
  const use = () => {
    if (!done) return;
    finish();
    onUse(done.relayId);
  };
  const retry = async () => {
    if (!target) return;
    const retryTarget = { sshHostId: target.sshHostId, address: target.address, name: target.name };
    const check = await controller.checkServer(retryTarget.sshHostId);
    if (!check) return;
    const replaceExisting = check.existing === 'other';
    if (replaceExisting) {
      // 服务器可能仍保留替换前的身份;重新确认清除,自己的未完成部署则保留身份继续。
      close();
      const approved = await confirm(t(`${DEPLOY}.replaceTitle`), t(`${DEPLOY}.replaceDescription`), t(`${DEPLOY}.submitReplace`));
      onOpenChange(true);
      if (!approved) return;
    }
    await controller.run({ type: 'deploy', ...retryTarget, replaceExisting });
  };
  const description =
    view === 'form'
      ? t(`${DEPLOY}.hint`)
      : view === 'done' && canUse
        ? t(`${DIALOG}.doneHint`)
        : target
          ? `${hostLabel(hosts, target.sshHostId)} · ${target.baseUrl}`
          : '';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          className="modal-panel fixed left-1/2 top-1/2 z-[10001] flex h-[min(560px,88vh)] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col outline-none"
        >
          {/* 三步共用一个固定高度:内容在中间区域滚动,换步骤、步骤推进时窗口不变高也不重新居中。 */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pb-3 pt-4">
            <Dialog.Title className="text-16 font-semibold text-[var(--confirm-title)]">{t(`${DEPLOY}.title`)}</Dialog.Title>
            <DialogSteps current={view === 'form' ? 0 : view === 'progress' ? 1 : 2} />
          </div>
          {controller.error ? (
            <div className="shrink-0 px-4 pb-3">
              <CommandError error={controller.error} port={state.host.port} detail={controller.errorDetail} />
            </div>
          ) : null}
          {view === 'form' ? (
            <>
              <Dialog.Description className="shrink-0 px-4 pb-4 text-12 leading-[1.5] text-[var(--text-tertiary)]">
                {description}
              </Dialog.Description>
              <DeployFormStep
                state={state}
                controller={controller}
                hosts={hosts}
                initial={editing !== undefined ? editing : initial}
                onCancel={() => (backToJob && job ? setEditing(undefined) : close())}
                onAbandon={incomplete ? abandon : null}
                onStarted={() => setEditing(undefined)}
              />
            </>
          ) : view === 'progress' && job ? (
            <>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
                <div className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 truncate text-13 font-medium text-[var(--text-primary)]">
                      {job.status === 'running'
                        ? t(`${DIALOG}.running`, { server: target ? hostLabel(hosts, target.sshHostId) : '' })
                        : t(`${DEPLOY}.failed.deploy`)}
                    </p>
                    {elapsed !== null ? (
                      <span className="shrink-0 text-12 tabular-nums text-[var(--text-tertiary)]">
                        {t(`${DEPLOY}.elapsed`, { time: formatDuration(elapsed) })}
                      </span>
                    ) : null}
                  </div>
                  <Dialog.Description className="truncate text-12 text-[var(--text-tertiary)]">{description}</Dialog.Description>
                  {job.status === 'running' ? (
                    <>
                      <DeployProgressBar job={job} />
                      <LiveProgress job={job} />
                    </>
                  ) : null}
                </div>
                <JobSteps job={job} liveDetail={false} />
                <JobLog job={job} />
              </div>
              {job.status === 'running' ? (
                <DialogFooter start={<span className="text-12 text-[var(--text-tertiary)]">{t(`${DIALOG}.backgroundHint`)}</span>}>
                  <Button variant="secondary" size="sm" onClick={close}>
                    {t(`${DIALOG}.background`)}
                  </Button>
                </DialogFooter>
              ) : (
                <DialogFooter
                  start={
                    record ? (
                      <Button variant="secondary" size="sm" disabled={controller.busy} onClick={abandon}>
                        {t(`${DEPLOY}.abandon`)}
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" disabled={controller.busy} onClick={finish}>
                        {t(`${DEPLOY}.cancel`)}
                      </Button>
                    )
                  }
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={controller.busy || !target}
                    onClick={() => {
                      if (!target) return;
                      setBackToJob(true);
                      setEditing({ sshHostId: target.sshHostId, address: target.address, name: target.name, relayId: job.relayId });
                    }}
                  >
                    {t(`${DEPLOY}.edit`)}
                  </Button>
                  <Button
                    variant="cta"
                    size="sm"
                    disabled={controller.busy || !target || !state.bundledRelayVersion}
                    onClick={() => void retry()}
                  >
                    {t(`${DEPLOY}.retry`)}
                  </Button>
                </DialogFooter>
              )}
            </>
          ) : (
            <>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--status-success)_14%,transparent)] text-[var(--status-success)]"
                  >
                    <Check size={18} />
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="truncate text-14 font-medium text-[var(--text-primary)]">
                      {t(`${DIALOG}.doneTitle`, { name: done?.name ?? target?.name ?? '' })}
                    </p>
                    <Dialog.Description className="text-12 leading-[1.5] text-[var(--text-secondary)]">
                      {description}
                    </Dialog.Description>
                  </div>
                </div>
                {done ? (
                  <dl className="flex flex-col divide-y divide-[var(--border-default)] rounded-lg border border-[var(--border-default)]">
                    {[
                      [t(`${DEPLOY}.server`), hostLabel(hosts, done.sshHostId)],
                      [t(`${DEPLOY}.address`), done.baseUrl],
                      [t(`${MANAGE}.version`), done.relayVersion],
                    ].map(([label, value]) => (
                      <div key={label} className="flex items-center justify-between gap-4 px-3 py-2.5 text-12">
                        <dt className="shrink-0 text-[var(--text-tertiary)]">{label}</dt>
                        <dd className="min-w-0 truncate font-mono text-[var(--text-primary)]">{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
              <DialogFooter start={canUse ? <span className="text-12 text-[var(--text-tertiary)]">{t(`${DIALOG}.doneLater`)}</span> : null}>
                <Button variant={canUse ? 'secondary' : 'cta'} size="sm" onClick={finish}>
                  {t(`${DIALOG}.finish`)}
                </Button>
                {canUse ? (
                  <Button variant="cta" size="sm" disabled={controller.busy} onClick={use}>
                    {t(`${DIALOG}.use`)}
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 改服务器中转在本机显示的名字。 */
function RenameForm({
  deployment,
  controller,
  onClose,
}: {
  deployment: SelfHostedRelayDeploymentView;
  controller: SelfHostedRelayController;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(deployment.name);
  const normalized = normalizeRelayName(name);
  const canSave = Boolean(normalized && normalized !== deployment.name) && !controller.busy;
  const save = async () => {
    if (!normalized) return;
    if (await controller.run({ type: 'rename-deployment', relayId: deployment.relayId, name: normalized })) onClose();
  };
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void save();
      }}
    >
      <div className="flex flex-col gap-3 px-4 pb-4">
        <Input
          value={name}
          onChange={setName}
          size="sm"
          maxLength={RELAY_NAME_MAX_LENGTH}
          autoFocus
          error={!normalized}
          ariaLabel={t(`${DEPLOY}.name`)}
        />
        <CommandError error={controller.error} port={0} detail={controller.errorDetail} />
      </div>
      <DialogFooter>
        <Button type="button" variant="secondary" size="sm" disabled={controller.busy} onClick={onClose}>
          {t(`${ROUTE}.renameCancel`)}
        </Button>
        <Button type="submit" variant="cta" size="sm" disabled={!canSave}>
          {t(`${ROUTE}.renameSave`)}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * 服务器中转的实时状态:进入页面时读一次,之后每分钟刷新;刷新时保留上一次结果,不闪空。
 * 查询本身失败(例如主进程还是旧版本)不等于服务器连不上:这时不下结论,不显示状态。
 */
function useDeploymentStatus(relayId: string | null) {
  const [status, setStatus] = useState<SelfHostedRelayDeploymentStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // 换了一个中转才清空;同一个中转定时刷新时保留上一次结果。
  useEffect(() => {
    setStatus(null);
  }, [relayId]);
  useEffect(() => {
    const api = window.electronAPI?.selfHostedRelay;
    if (!relayId || !api) return;
    let active = true;
    setChecking(true);
    void api
      .command({ type: 'deployment-status', relayId })
      .then((res) => {
        if (active && res.deploymentStatus) setStatus(res.deploymentStatus);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [relayId, attempt]);
  useEffect(() => {
    if (!relayId) return;
    const timer = setInterval(() => setAttempt((value) => value + 1), DEPLOYMENT_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [relayId]);
  return { status, checking, refresh: () => setAttempt((value) => value + 1) };
}

const DEPLOYMENT_STATUS_POLL_MS = 60_000;

function StatusLabel({ status, checking }: { status: SelfHostedRelayDeploymentStatus | null; checking: boolean }) {
  const { t } = useTranslation();
  if (!status) return checking ? <span className="text-[var(--text-tertiary)]">{t(`${ROUTE}.statusChecking`)}</span> : null;
  return (
    <span className={cn('inline-flex items-center gap-1.5', checking && 'opacity-70')}>
      <span
        aria-hidden
        className={cn('h-1.5 w-1.5 rounded-full', status.online ? 'bg-[var(--status-success)]' : 'bg-[var(--error-fg)]')}
      />
      {t(status.online ? `${ROUTE}.statusOnline` : `${ROUTE}.statusOffline`)}
    </span>
  );
}

/**
 * 线路列表的一行:左边单选标记,选中的那一行就是正在用的线路。
 * 选中的那一行在名字旁边写「正在使用」;右侧(`RouteSide`)与标题同一行、统一 28px 高、贴右对齐;
 * 这条线路的详情直接放在说明下面,不另起卡片。
 */
function RouteRow({
  selected,
  icon,
  title,
  tag,
  hint,
  side,
  children,
}: {
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  tag?: string | null;
  hint?: React.ReactNode;
  side?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li
      aria-current={selected ? 'true' : undefined}
      className={cn('flex items-start gap-3 px-4 py-3', selected && 'bg-[color-mix(in_srgb,var(--text-primary)_3%,transparent)]')}
    >
      <span
        aria-hidden
        className={cn(
          'mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px]',
          selected ? 'border-[var(--text-primary)]' : 'border-[var(--text-tertiary)]',
        )}
      >
        {selected ? <span className="h-2 w-2 rounded-full bg-[var(--text-primary)]" /> : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="shrink-0 text-[var(--text-tertiary)]">{icon}</span>
            <span className="truncate text-13 font-medium text-[var(--text-primary)]">{title}</span>
            {tag ? (
              <span className="shrink-0 rounded-full border border-[var(--border-default)] px-1.5 text-11 leading-[1.636] text-[var(--text-secondary)]">
                {tag}
              </span>
            ) : null}
            {selected ? <InUse /> : null}
          </div>
          {side ? <div className="flex h-7 shrink-0 items-center gap-1">{side}</div> : null}
        </div>
        {hint ? <div className="min-w-0 text-12 leading-[1.5] text-[var(--text-secondary)]">{hint}</div> : null}
        {children ? <div className="mt-3">{children}</div> : null}
      </div>
    </li>
  );
}

/** 升级或移除服务器中转时的进度与失败处理。 */
function TaskPanel({ job, controller }: { job: SelfHostedRelayDeployJobView; controller: SelfHostedRelayController }) {
  const { t } = useTranslation();
  const elapsed = useElapsed(job);
  const running = job.status === 'running';
  return (
    <div className="flex flex-col gap-3">
      <CardHeader
        title={t(`${DEPLOY}.${running ? 'running' : 'failed'}.${job.action}`)}
        trailing={elapsed !== null ? t(`${DEPLOY}.elapsed`, { time: formatDuration(elapsed) }) : null}
      />
      <JobSteps job={job} />
      <JobLog job={job} />
      {running || !job.relayId ? null : job.action === 'uninstall' ? (
        <RemovalFallback controller={controller} relayId={job.relayId} />
      ) : (
        <Actions>
          <Button size="sm" disabled={controller.busy} onClick={() => void controller.run({ type: 'upgrade-deployment', relayId: job.relayId! })}>
            {t(`${DEPLOY}.retry`)}
          </Button>
        </Actions>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
      <dt className="text-11 text-[var(--text-tertiary)]">{label}</dt>
      <dd className="break-words text-13 font-medium text-[var(--text-primary)]">{value}</dd>
      {sub ? <dd className="break-words text-11 text-[var(--text-tertiary)]">{sub}</dd> : null}
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 只有图标的操作:按 DESIGN.md §14.6 同时给可见 Tip 和无障碍名称。 */
function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tip text={label}>
      <Button
        variant="secondary"
        tone="quiet"
        size="sm"
        className="w-7 px-0"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tip>
  );
}

/** 正在用的服务器中转的详情:状态用数字说话(设备、证书、版本),下面就是添加设备。 */
function ServerDetails({
  state,
  deployment,
  controller,
  status,
}: {
  state: SelfHostedRelayState;
  deployment: SelfHostedRelayDeploymentView;
  controller: SelfHostedRelayController;
  status: SelfHostedRelayDeploymentStatus | null;
}) {
  const { t } = useTranslation();
  const job = state.deployJob;
  const task = job && job.relayId === deployment.relayId && job.action !== 'deploy' && job.status !== 'done' ? job : null;
  const busy = controller.busy || job?.status === 'running';
  const expiresAt = status?.certificateExpiresAt ? Date.parse(status.certificateExpiresAt) : NaN;
  const daysLeft = Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - Date.now()) / DAY_MS)) : null;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-default)]">
      {status && !status.online ? (
        <div className="border-b border-[var(--border-default)] px-3 py-2.5">
          <ErrorText>{t(`${MANAGE}.offline`)}</ErrorText>
        </div>
      ) : null}
      <dl className="grid grid-cols-3 divide-x divide-[var(--border-default)]">
        <Stat
          label={t(`${MANAGE}.devices`)}
          value={status?.devices !== undefined ? t(`${MANAGE}.deviceCount`, { count: status.devices }) : '—'}
          sub={status?.onlineDevices !== undefined ? t(`${MANAGE}.onlineCount`, { count: status.onlineDevices }) : null}
        />
        <Stat
          label={t(`${MANAGE}.certificate`)}
          value={
            !status?.online
              ? '—'
              : daysLeft !== null
                ? t(`${MANAGE}.certificateDays`, { count: daysLeft })
                : t(`${MANAGE}.certificateSite`)
          }
          sub={status?.online && daysLeft !== null ? t(`${MANAGE}.certificateRenew`) : null}
        />
        <Stat
          label={t(`${MANAGE}.version`)}
          value={deployment.relayVersion}
          sub={
            deployment.upgradeAvailable ? (
              <Button
                variant="secondary"
                size="xs"
                compact
                className="mt-1"
                disabled={busy}
                onClick={() => void controller.run({ type: 'upgrade-deployment', relayId: deployment.relayId })}
              >
                {t(`${SERVER}.upgrade`, { version: state.bundledRelayVersion ?? '' })}
              </Button>
            ) : (
              t(`${MANAGE}.latest`)
            )
          }
        />
      </dl>
      <div className="border-t border-[var(--border-default)] px-3 py-3">
        {task ? <TaskPanel job={task} controller={controller} /> : <AddDevice state={state} controller={controller} bare />}
      </div>
    </div>
  );
}

/**
 * 「连接线路」:所有线路是一个单选列表,选中的那条就是正在用的。切换线路都先确认;
 * 正在用的那条在自己那一行里展开详情(服务器中转的设备数、证书、添加设备;这台电脑当中转的加入链接)。
 * 部署到服务器的中转每台一行,各自可以切换、改名、移除;随时可以再部署到另一台服务器。
 */
export function RelayServicePanel({ controller }: { controller: SelfHostedRelayController }) {
  const { t } = useTranslation();
  const confirmDialog = useOptionalConfirmDialog();
  const confirm = useConfirm();
  const [form, setForm] = useState<'none' | 'host' | 'join'>('none');
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployInitial, setDeployInitial] = useState<DeployTarget | null>(null);
  const [deployInForm, setDeployInForm] = useState(false);
  const [deployOpenKey, setDeployOpenKey] = useState(0);
  const [renaming, setRenaming] = useState<SelfHostedRelayDeploymentView | null>(null);
  const { state, error } = controller;
  const hosts = useSshHosts(Boolean(state?.available), deployOpen);
  const k = 'settings.remoteControl.relay';
  const job = state?.deployJob ?? null;
  const previousJobStatus = useRef(job?.status);
  // 详情只给正在用的那个服务器中转:没在用时设备数、证书等没有意义,也不去请求。
  const activeServer = state?.deployments.find((deployment) => deployment.active && deployment.relayVersion) ?? null;
  const deploymentStatus = useDeploymentStatus(state?.available ? activeServer?.relayId ?? null : null);

  // 移除完成后这一行随之消失,用一条提示说明结果。
  useEffect(() => {
    if (previousJobStatus.current === 'running' && job?.status === 'done' && job.action === 'uninstall') {
      toast.success(t(`${DEPLOY}.done.uninstall`));
    }
    previousJobStatus.current = job?.status;
  }, [job?.status, job?.action, t]);

  // 加入成功后关掉窗口(main 已切换中转)。
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
  const isMember = relay?.origin === 'join';
  const confirmKey = isHost ? 'owner' : isServer ? 'server' : 'member';
  const busy = controller.busy || job?.status === 'running';

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
  // 切换到服务器中转前先确认,并说清楚原线路会怎样(从另一个服务器中转切过来时原中转继续运行)。
  const switchToDeployment = async (deployment: SelfHostedRelayDeploymentView) => {
    const ok = !confirmDialog || (await confirmDialog.confirm({
      title: t(`${ROUTE}.switchTitle`, { name: deployment.name }),
      description: t(
        isHost ? `${ROUTE}.switchFromHost` : isMember ? `${ROUTE}.switchFromMember` : `${ROUTE}.switchFromOfficial`,
        { name: isMember ? relay?.name ?? '' : deployment.name },
      ),
      confirmText: t(`${ROUTE}.switchConfirm`),
      confirmVariant: isHost ? 'destructive' : 'default',
    }));
    if (!ok) return;
    setForm('none');
    await controller.run({ type: 'use-deployment', relayId: deployment.relayId });
  };
  const switchToDeploymentById = (relayId: string) => {
    const deployment = state.deployments.find((item) => item.relayId === relayId);
    if (deployment) void switchToDeployment(deployment);
  };
  const removeDeployment = (relayId: string) => {
    void confirm(t(`${SERVER}.removeTitle`), t(`${SERVER}.removeDescription`), t(`${SERVER}.remove`)).then((ok) => {
      if (ok) void controller.run({ type: 'uninstall-deployment', relayId, removeData: true });
    });
  };
  /** `inForm`:直接显示表单(新部署、继续某条记录);否则跟着当前部署任务显示进度。 */
  const openDeploy = (initial: DeployTarget | null, inForm: boolean) => {
    controller.clearError();
    setForm('none');
    setDeployInitial(initial);
    setDeployInForm(inForm);
    setDeployOpenKey((value) => value + 1);
    setDeployOpen(true);
  };
  const openForm = (next: 'host' | 'join') => {
    controller.clearError();
    setForm(next);
  };
  const closeForm = () => {
    controller.clearError();
    setForm('none');
  };
  const openRename = (deployment: SelfHostedRelayDeploymentView) => {
    controller.clearError();
    setRenaming(deployment);
  };
  const closeRename = () => {
    controller.clearError();
    setRenaming(null);
  };
  // 等待主人同意时关窗口,就撤回这次加入申请。
  const closeJoin = () => {
    if (state.join.status === 'connecting' || state.join.status === 'waiting') void controller.run({ type: 'cancel-join' });
    closeForm();
  };
  const switchAction = (name: string, onClick: () => void) => (
    <IconAction label={t(`${ROUTE}.useNamed`, { name })} disabled={busy} onClick={onClick}>
      <ArrowRightLeft aria-hidden size={14} />
    </IconAction>
  );
  const runningHint = (text: string) => (
    <span className="inline-flex items-center gap-1.5">
      <Spinner size={12} />
      {text}
    </span>
  );

  const serverRow = (deployment: SelfHostedRelayDeploymentView) => {
    const rowJob = job?.relayId === deployment.relayId ? job : null;
    const running = rowJob?.status === 'running';
    const deploying = running && rowJob.action === 'deploy';
    const removing = running && rowJob.action === 'uninstall';
    const complete = Boolean(deployment.relayVersion);
    // 重新部署在改动服务器前失败时旧记录仍完整,也要保留查看原因和重试的入口。
    const needsResume = !complete || (rowJob?.action === 'deploy' && rowJob.status === 'failed');
    const inUse = Boolean(isServer && deployment.active);
    const showStatus = inUse && complete && (deploymentStatus.status || deploymentStatus.checking);
    const hint = deploying ? (
      runningHint(t(`${ROUTE}.deployingStep`, { step: stepLabel(t, rowJob.step) }))
    ) : removing ? (
      runningHint(t(`${DEPLOY}.running.uninstall`))
    ) : needsResume ? (
      t(`${DEPLOY}.failed.deploy`)
    ) : (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        <span className="truncate">
          {hostLabel(hosts, deployment.sshHostId)} · <span className="font-mono">{deployment.address}</span>
        </span>
        {showStatus ? (
          <>
            <span aria-hidden>·</span>
            <StatusLabel status={deploymentStatus.status} checking={deploymentStatus.checking} />
            <IconAction label={t(`${MANAGE}.check`)} disabled={deploymentStatus.checking} onClick={deploymentStatus.refresh}>
              <RefreshCw aria-hidden size={12} className={cn(deploymentStatus.checking && 'animate-spin motion-reduce:animate-none')} />
            </IconAction>
          </>
        ) : null}
      </span>
    );
    const side = deploying ? (
      <Button variant="secondary" size="sm" onClick={() => openDeploy(null, false)}>
        {t(`${ROUTE}.viewProgress`)}
      </Button>
    ) : removing ? null : needsResume ? (
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() =>
          // 这一条刚失败过:回到它的进度看原因、重试;否则用记录里的设置打开表单。
          rowJob?.action === 'deploy'
            ? openDeploy(null, false)
            : openDeploy({ sshHostId: deployment.sshHostId, address: deployment.address, name: deployment.name, relayId: deployment.relayId }, true)
        }
      >
        {t(`${ROUTE}.resume`)}
      </Button>
    ) : (
      <RouteSide
        switchAction={deployment.active ? null : switchAction(deployment.name, () => void switchToDeployment(deployment))}
        actions={[
          <IconAction key="rename" label={t(`${ROUTE}.rename`)} disabled={busy} onClick={() => openRename(deployment)}>
            <Pencil aria-hidden size={14} />
          </IconAction>,
          <IconAction key="remove" label={t(`${MANAGE}.remove`)} disabled={busy} onClick={() => removeDeployment(deployment.relayId)}>
            <Trash2 aria-hidden size={14} />
          </IconAction>,
        ]}
      />
    );
    const failedTask = rowJob && rowJob.action !== 'deploy' && rowJob.status === 'failed' ? rowJob : null;
    return (
      <RouteRow
        key={deployment.relayId}
        selected={inUse}
        icon={<Server size={15} />}
        title={deploying && rowJob.target ? rowJob.target.name : deployment.name}
        tag={t(`${ROUTE}.kindServer`)}
        hint={hint}
        side={side}
      >
        {inUse && complete && !removing ? (
          <ServerDetails state={state} deployment={deployment} controller={controller} status={deploymentStatus.status} />
        ) : failedTask ? (
          <div className="rounded-lg border border-[var(--border-default)] px-3 py-3">
            <TaskPanel job={failedTask} controller={controller} />
          </div>
        ) : null}
      </RouteRow>
    );
  };
  // 检查通过前停下或还在进行的部署还没有记录:用任务里的目标单独占一行。
  const pendingDeploy =
    job?.action === 'deploy' && job.status !== 'done' && !state.deployments.some((deployment) => deployment.relayId === job.relayId)
      ? job
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <ul className="flex flex-col divide-y divide-[var(--border-default)] overflow-hidden rounded-xl bg-[var(--settings-input-bg)]">
          <RouteRow
            selected={!relay}
            icon={<Cloud size={15} />}
            title={t(`${k}.summary.official`)}
            tag={t(`${ROUTE}.defaultTag`)}
            hint={t(`${ROUTE}.officialHint`)}
            side={<RouteSide switchAction={relay ? switchAction(t(`${k}.summary.official`), () => void switchToOfficial()) : null} />}
          />
          {state.deployments.map(serverRow)}
          {pendingDeploy ? (
            <RouteRow
              selected={false}
              icon={<Server size={15} />}
              title={pendingDeploy.target?.name ?? ''}
              tag={t(`${ROUTE}.kindServer`)}
              hint={
                pendingDeploy.status === 'running'
                  ? runningHint(t(`${ROUTE}.deployingStep`, { step: stepLabel(t, pendingDeploy.step) }))
                  : t(`${DEPLOY}.failed.deploy`)
              }
              side={
                <Button variant="secondary" size="sm" onClick={() => openDeploy(null, false)}>
                  {t(pendingDeploy.status === 'running' ? `${ROUTE}.viewProgress` : `${ROUTE}.resume`)}
                </Button>
              }
            />
          ) : null}
          <RouteRow
            selected={isHost}
            icon={<Monitor size={15} />}
            title={t(`${ROUTE}.hostTitle`)}
            hint={
              isHost && state.host.running
                ? t(`${k}.host.running`, {
                    address: state.host.externalUrl ?? state.host.suggestedUrls[0] ?? `127.0.0.1:${state.host.port}`,
                  })
                : t(`${ROUTE}.hostHint`)
            }
            side={
              <RouteSide
                // 这台电脑当中转要先填端口等设置,切换就是打开设置窗口,在窗口里点「开启」。
                switchAction={isHost ? null : switchAction(t(`${ROUTE}.hostTitle`), () => openForm('host'))}
                actions={[
                  isHost ? (
                    <IconAction key="settings" label={t(`${k}.actions.editHost`)} onClick={() => openForm('host')}>
                      <Settings2 aria-hidden size={14} />
                    </IconAction>
                  ) : null,
                ]}
              />
            }
          >
            {isHost && state.host.running ? (
              <div className="rounded-lg border border-[var(--border-default)] px-3 py-3">
                <AddDevice state={state} controller={controller} bare />
              </div>
            ) : null}
          </RouteRow>
          {isMember && relay ? (
            <RouteRow
              selected
              icon={<Link2 size={15} />}
              title={relay.name}
              tag={t(`${ROUTE}.kindJoined`)}
              hint={<span className="font-mono">{relay.baseUrl}</span>}
              side={<RouteSide />}
            />
          ) : null}
          <li className="px-4 py-2">
            <div className="-mx-3 flex flex-wrap items-center gap-1">
              <Button
                variant="secondary"
                size="sm"
                tone="quiet"
                compact
                disabled={!state.bundledRelayVersion || busy}
                onClick={() => openDeploy(null, true)}
              >
                <Plus aria-hidden size={13} />
                {t(`${k}.actions.deploy`)}
              </Button>
              {!relay ? (
                <Button variant="secondary" size="sm" tone="quiet" compact disabled={busy} onClick={() => openForm('join')}>
                  <Link2 aria-hidden size={13} />
                  {t(`${k}.actions.join`)}
                </Button>
              ) : null}
            </div>
          </li>
        </ul>
        {state.issue ? (
          <ErrorText>
            {t(`${k}.issue.${state.issue}`)} {t(`${k}.issue.next`)}
          </ErrorText>
        ) : null}
        {isHost && state.host.error ? (
          <ErrorText>{t(`${k}.errors.${state.host.error}`, { port: state.host.port })}</ErrorText>
        ) : null}
        <p className="flex items-start gap-2 text-12 leading-[1.5] text-[var(--text-tertiary)]">
          <Info aria-hidden size={13} className="mt-0.5 shrink-0" />
          {t(`${k}.limits`)}
        </p>
      </div>
      {/* 窗口里的命令失败写在窗口里,这里只显示列表上的操作(切换、移除等)出的错。 */}
      {!deployOpen && form === 'none' && !renaming && error && error !== 'CANCELLED' ? (
        <CommandError error={error} port={state.host.port} detail={controller.errorDetail} />
      ) : null}
      <FormDialog
        open={form === 'host'}
        onClose={closeForm}
        title={isHost ? t(`${ROUTE}.hostTitle`) : t(`${k}.host.title`)}
        description={t(`${k}.host.hint`)}
      >
        <HostForm
          state={state}
          controller={controller}
          notice={!isHost && isMember ? t(`${ROUTE}.switchFromMember`, { name: relay?.name ?? '' }) : null}
          onDone={closeForm}
        />
      </FormDialog>
      <FormDialog open={form === 'join'} onClose={closeJoin} title={t(`${k}.join.title`)} description={t(`${k}.join.hint`)}>
        <JoinForm state={state} controller={controller} onClose={closeJoin} />
      </FormDialog>
      <FormDialog open={Boolean(renaming)} onClose={closeRename} title={t(`${ROUTE}.rename`)} description={t(`${ROUTE}.renameHint`)}>
        {renaming ? <RenameForm key={renaming.relayId} deployment={renaming} controller={controller} onClose={closeRename} /> : null}
      </FormDialog>
      <DeployDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        state={state}
        controller={controller}
        hosts={hosts}
        initial={deployInitial}
        startInForm={deployInForm}
        openKey={deployOpenKey}
        onUse={switchToDeploymentById}
      />
    </div>
  );
}
