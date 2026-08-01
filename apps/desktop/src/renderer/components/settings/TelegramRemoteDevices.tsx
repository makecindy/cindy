/**
 * TelegramRemoteDevices —— 个人 Telegram bot 设置卡里的「我的其他设备」区块。
 *
 * 为什么需要它: 个人 bot 是 BYO token 直连 Bot API 的长轮询, 同一 token 同时
 * 只有一台设备能收消息, 而两台设备之间没有任何通信通道。想让另一端让位, 原本
 * 只能人肉跑去那台机器上操作 —— 这里借 device-link 隧道补上这一步。
 *
 * 边界(与被控端 telegramRemoteControl.ts 对称): 只能让对方**下线**(停轮询),
 * 拿不到也删不掉对方的凭证; 解绑仍然只能在那台机器本地做。
 *
 * 老被控端没有这两个 channel → 隧道回 CHANNEL_NOT_ALLOWED, 这里显示「该设备
 * 版本不支持」而不是静默失败 —— 远程下线要等对方升级到含此功能的版本才可用,
 * 这一点必须让用户当场看见, 否则会以为是自己点错了。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, PowerOff, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { useSelectableDevices } from '@/hooks/useControllableDevices';

const log = createLogger('TelegramRemoteDevices');

const STATUS_CHANNEL = 'device-link:telegram:status';
const SET_ONLINE_CHANNEL = 'device-link:telegram:set-online';

/** 与被控端 TelegramRemoteStatus 同形(无凭证 / 无 owner id / 无 bot 身份)。 */
interface RemoteStatus {
  kind: 'idle' | 'connecting' | 'connected' | 'conflict' | 'offline' | 'error';
  appId: string | null;
  /** 诊断原文(可能是英文技术串), 不直接展示。 */
  reason: string | null;
  /** 稳定错误分类, 展示走 i18n。 */
  code: 'invalid-token' | 'provider-api' | 'network' | 'secret-unavailable' | null;
}

/** 每台设备的探测结果:未知(拉取中)/ 拿到状态 / 版本太老 / 拉取失败。 */
type Probe =
  | { state: 'loading' }
  | { state: 'ok'; status: RemoteStatus }
  | { state: 'unsupported' }
  | { state: 'failed' };

function isChannelNotAllowed(err: unknown): boolean {
  return extractIpcError(err)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
}

/** Stable device-link IPC codes → localized copy; never surface transport messages in UI. */
const TELEGRAM_REMOTE_FAILURE_I18N: Record<string, string> = {
  PRECONDITION_FAILED: 'settings.telegramBot.remoteDevices.state.otherBot',
  DEVICE_LINK_REMOTE_DISABLED: 'settings.telegramBot.remoteDevices.failure.remoteDisabled',
  DEVICE_LINK_ACCESS_REVOKED: 'settings.telegramBot.remoteDevices.failure.accessRevoked',
  DEVICE_LINK_CONTROL_DISABLED: 'settings.telegramBot.remoteDevices.failure.controlDisabled',
  DEVICE_LINK_NOT_CONNECTED: 'settings.telegramBot.remoteDevices.failure.unreachable',
  DEVICE_LINK_DEVICE_OFFLINE: 'settings.telegramBot.remoteDevices.failure.unreachable',
  DEVICE_LINK_TIMEOUT: 'settings.telegramBot.remoteDevices.failure.unreachable',
  DEVICE_LINK_UNAVAILABLE: 'settings.telegramBot.remoteDevices.failure.unreachable',
  DEVICE_LINK_STANDBY: 'settings.telegramBot.remoteDevices.failure.unreachable',
  DEVICE_LINK_VERSION_MISMATCH: 'settings.telegramBot.remoteDevices.state.unsupported',
};

export function telegramRemoteFailureKey(err: unknown): string {
  const code = extractIpcError(err)?.code;
  return (
    (code && TELEGRAM_REMOTE_FAILURE_I18N[code])
    || 'settings.telegramBot.remoteDevices.failure.unknown'
  );
}

export function TelegramRemoteDevices({ selfAppId }: { selfAppId: string | null }) {
  const { t } = useTranslation();
  const { devices, loaded } = useSelectableDevices();
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  /** 请求序号: presence 抖动会重触发探测, 老响应不得覆盖新一轮结果。 */
  const probeSeq = useRef(0);

  const probeAll = useCallback(async () => {
    const seq = ++probeSeq.current;
    const online = devices.filter((d) => d.online);
    if (online.length === 0) {
      setProbes({});
      return;
    }
    setProbes((prev) => {
      const next: Record<string, Probe> = {};
      for (const d of online) next[d.deviceId] = prev[d.deviceId] ?? { state: 'loading' };
      return next;
    });
    await Promise.all(
      online.map(async (d) => {
        let probe: Probe;
        try {
          const result = (await window.electronAPI.deviceLink.invoke(
            d.deviceId,
            STATUS_CHANNEL,
            [],
          )) as RemoteStatus;
          probe = { state: 'ok', status: result };
        } catch (err) {
          probe = isChannelNotAllowed(err) ? { state: 'unsupported' } : { state: 'failed' };
          if (probe.state === 'failed') {
            log.debug('telegram status probe failed', {
              deviceId: d.deviceId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (probeSeq.current !== seq) return;
        setProbes((prev) => ({ ...prev, [d.deviceId]: probe }));
      }),
    );
  }, [devices]);

  useEffect(() => {
    if (!loaded) return;
    void probeAll();
  }, [loaded, probeAll]);

  const takeOffline = useCallback(
    async (deviceId: string, expectedAppId: string) => {
      if (busyDeviceId) return;
      setBusyDeviceId(deviceId);
      try {
        const result = (await window.electronAPI.deviceLink.invoke(deviceId, SET_ONLINE_CHANNEL, [
          { online: false, expectedAppId },
        ])) as RemoteStatus;
        setProbes((prev) => ({ ...prev, [deviceId]: { state: 'ok', status: result } }));
        // 远端执行失败也会作为成功的 device-link 响应回来(例如目标机写不进下线标志时
        // 只落 error 并保持轮询)。不核对终态就报成功, 会让人以为冲突已经解除。
        if (result.kind !== 'offline') {
          toast.error(
            t('logic.toasts.telegramRemoteFailed', {
              // 远端的 reason 同样是诊断原文, 展示一律走 code / 状态 i18n。
              message:
                result.kind === 'error' && result.code
                  ? t(`settings.telegramBot.errorCode.${result.code}`)
                  : t(`settings.telegramBot.remoteDevices.state.${result.kind}`),
            }),
          );
          return;
        }
        toast.success(t('logic.toasts.telegramRemoteWentOffline'));
      } catch (err) {
        if (isChannelNotAllowed(err)) {
          setProbes((prev) => ({ ...prev, [deviceId]: { state: 'unsupported' } }));
          toast.error(t('logic.toasts.telegramRemoteUnsupported'));
        } else {
          const ipcError = extractIpcError(err);
          if (ipcError?.code === 'PRECONDITION_FAILED') await probeAll();
          // 原始 message 只写诊断日志；toast 只能展示稳定 code 对应的 locale 文案。
          log.error('remote set-online failed', {
            code: ipcError?.code ?? null,
            error: err instanceof Error ? err.message : String(err),
          });
          toast.error(
            t('logic.toasts.telegramRemoteFailed', {
              message: t(telegramRemoteFailureKey(err)),
            }),
          );
        }
      } finally {
        setBusyDeviceId(null);
      }
    },
    [busyDeviceId, probeAll, t],
  );

  // 一台其他设备都没有时整块不出现 —— 单机用户不该看到一个恒空的区块。
  if (!loaded || devices.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-12 font-medium text-[var(--settings-section-desc)]">
          {t('settings.telegramBot.remoteDevices.title')}
        </span>
        <button
          type="button"
          onClick={() => void probeAll()}
          aria-label={t('settings.telegramBot.remoteDevices.refresh')}
          className="flex shrink-0 items-center justify-center bg-transparent p-0 text-[var(--settings-trash-icon)] transition-colors hover:text-[var(--settings-trash-icon-hover)]"
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <p className="text-11 leading-[1.6] text-[var(--settings-source-meta)]">
        {t('settings.telegramBot.remoteDevices.hint')}
      </p>
      <div className="flex flex-col gap-1.5">
        {devices.map((d) => {
          const probe: Probe = d.online
            ? (probes[d.deviceId] ?? { state: 'loading' })
            : { state: 'failed' };
          const status = probe.state === 'ok' ? probe.status : null;
          // 只有"正在占着同一个 bot"才值得给下线按钮: 不同 bot 根本不冲突,
          // 已下线/未绑定的更没有可下线的东西。
          const sameBot = !!status?.appId && (!selfAppId || status.appId === selfAppId);
          const canTakeOffline =
            d.online && sameBot && (status.kind === 'connected' || status.kind === 'conflict');
          const detail = !d.online
            ? t('settings.telegramBot.remoteDevices.state.offlineDevice')
            : probe.state === 'loading'
              ? t('settings.telegramBot.remoteDevices.state.checking')
              : probe.state === 'unsupported'
                ? t('settings.telegramBot.remoteDevices.state.unsupported')
                : probe.state === 'failed'
                  ? t('settings.telegramBot.remoteDevices.state.unreachable')
                  : status && !status.appId
                    ? t('settings.telegramBot.remoteDevices.state.notConfigured')
                    : status && !sameBot
                      ? t('settings.telegramBot.remoteDevices.state.otherBot')
                      : t(`settings.telegramBot.remoteDevices.state.${status?.kind ?? 'idle'}`);
          return (
            <div
              key={d.deviceId}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2',
                'border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
                !d.online && 'opacity-50',
              )}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-12 font-medium text-[var(--settings-section-title)]">
                  {d.name}
                </span>
                <span className="truncate text-11 text-[var(--settings-source-meta)]">{detail}</span>
              </div>
              {canTakeOffline ? (
                <button
                  type="button"
                  onClick={() => void takeOffline(d.deviceId, status.appId!)}
                  disabled={busyDeviceId !== null}
                  className={cn(
                    'flex h-[28px] shrink-0 items-center justify-center gap-1.5 rounded-full px-3',
                    'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
                    'text-11 font-medium text-[var(--settings-btn-secondary-text)]',
                    busyDeviceId !== null && 'cursor-not-allowed opacity-40',
                  )}
                >
                  {busyDeviceId === d.deviceId ? (
                    <span
                      className="inline-flex animate-spin motion-reduce:animate-none"
                      aria-hidden
                    >
                      <Loader2 size={12} />
                    </span>
                  ) : (
                    <PowerOff size={12} />
                  )}
                  {t('settings.telegramBot.remoteDevices.takeOffline')}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
