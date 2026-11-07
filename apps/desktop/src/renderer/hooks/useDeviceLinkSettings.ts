/**
 * useDeviceLinkSettings —— device-link「远程控制」设置页的共享数据层。
 * ---------------------------------------------------------------------------
 * 从原 DevicesSection 抽出的数据逻辑,供合并后的「远程控制」页两个子面板共享一份
 * 状态(被控开关 + relay 状态 + 同账号设备列表 + 当前控制本机的设备),避免两个面板
 * 各自重复订阅 presence。
 *
 * - 列表来自 main 转发的 REST(device-link:list-devices)
 * - presence push(device-link:presence-changed)触发即时刷新;30s 轮询兜底
 * - controlledBy 来自 getState() 初值 + onControlledState push(谁在控制本机)
 * - 开关 / 重命名 / 删除 写 main,失败 toast,成功后 refresh
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { extractIpcError } from '@/utils/ipcError';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { renameDeviceLinkDevice, removeDeviceLinkDevice } from '@/features/device-link/useDeviceLinkDeviceList';

const log = createLogger('useDeviceLinkSettings');

export type DeviceLinkLinkStatus = 'stopped' | 'connecting' | 'online';

export interface ActiveController {
  deviceId: string;
  name: string;
}

export interface DeviceLinkSettings {
  /** 「允许同账号设备控制本机」开关。 */
  enabled: boolean;
  /** 本机 relay 连接状态。 */
  linkStatus: DeviceLinkLinkStatus;
  /** 本机 relay 连接问题(鉴权失效/被顶号/超限/版本不符/反复掉线;null = 无异常)。 */
  connectionIssue: DeviceLinkConnectionIssuePayload | null;
  /** 本机另一个 Cindy 实例正持有 device-link 连接,本实例处于待命。 */
  standby: boolean;
  /** 同账号设备列表(含本机 isSelf);null = 尚未加载。 */
  devices: DeviceLinkDeviceView[] | null;
  /** 当前正在控制本机的控制端。 */
  controlledBy: ActiveController[];
  /** 被撤销访问权限的控制端 deviceId 列表(逐设备黑名单)。 */
  revokedControllers: string[];
  /** 本机主动关闭控制的目标设备 deviceId 列表(控制端本地偏好)。 */
  disabledControlDeviceIds: string[];
  listError: string | null;
  refreshing: boolean;
  refresh: (showSpinner?: boolean) => Promise<void>;
  setEnabled: (next: boolean) => Promise<void>;
  rename: (deviceId: string, name: string | null) => Promise<void>;
  /** 删除设备;返回是否真正删除成功(失败已内部 toast,调用方据此决定后续清理)。 */
  remove: (deviceId: string) => Promise<boolean>;
  /** 一键断开当前所有正在控制本机的链路(被控开关 / WS 保持)。 */
  disconnectAll: () => Promise<void>;
  /** 撤销某设备的访问权限(逐设备黑名单,持久化;立即踢断 + 后续连接被拒)。 */
  revoke: (deviceId: string) => Promise<void>;
  /** 恢复某设备的访问权限(对方控制端随后自动重连)。 */
  restore: (deviceId: string) => Promise<void>;
  /** 控制端本地偏好:是否允许本机主动控制某个目标设备。 */
  setDeviceControlEnabled: (deviceId: string, enabled: boolean) => Promise<void>;
}

const POLL_INTERVAL_MS = 30_000;
/** 删除被拒后补拉列表的最长等待:列表请求没有截止时间,不能让删除弹窗一直停在「删除中」。 */
const REJECTED_DELETE_REFRESH_TIMEOUT_MS = 5_000;

export function useDeviceLinkSettings(active = true): DeviceLinkSettings {
  const { t } = useTranslation();
  const [enabled, setEnabledState] = useState(false);
  const [linkStatus, setLinkStatus] = useState<DeviceLinkLinkStatus>('stopped');
  const [connectionIssue, setConnectionIssue] = useState<DeviceLinkConnectionIssuePayload | null>(
    null,
  );
  const [standby, setStandby] = useState(false);
  const [devices, setDevices] = useState<DeviceLinkDeviceView[] | null>(null);
  const [controlledBy, setControlledBy] = useState<ActiveController[]>([]);
  const [revokedControllers, setRevokedControllers] = useState<string[]>([]);
  const [disabledControlDeviceIds, setDisabledControlDeviceIds] = useState<string[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const refreshGeneration = useRef(0);
  // 最近一次已返回（成功或失败）的刷新代次；与 refreshGeneration 不同说明还有刷新在途。
  const settledRefreshGeneration = useRef(0);
  const disabledControlDeviceIdsRef = useRef<string[]>([]);
  // getState() 与 ownership push 可能乱序返回;事件版本推进后,旧快照不得覆盖新事实。
  const ownershipEventVersion = useRef(0);
  // 界面此刻展示的列表。删除被拒时要按它选提示:异步调用里读闭包的 devices 会拿到发起删除
  // 那一刻的旧列表;ok 记录最近一次拉取是否成功(失败时界面显示错误块,不再显示设备行)。
  const latestList = useRef<{ devices: DeviceLinkDeviceView[] | null; ok: boolean }>({
    devices: null,
    ok: false,
  });

  const applyDisabledControlDeviceIds = useCallback((ids: string[]) => {
    disabledControlDeviceIdsRef.current = ids;
    setDisabledControlDeviceIds(ids);
    const disabled = new Set(ids);
    setDevices(
      (current) =>
        current?.map((device) => ({
          ...device,
          controlEnabled: !disabled.has(device.deviceId),
        })) ?? current,
    );
  }, []);

  const refresh = useCallback(
    async (showSpinner = false) => {
      if (!active) return;
      const generation = ++refreshGeneration.current;
      if (showSpinner) setRefreshing(true);
      try {
        const { devices: list } = await window.electronAPI.deviceLink.listDevices();
        if (!mounted.current || generation !== refreshGeneration.current) return;
        settledRefreshGeneration.current = generation;
        latestList.current = { devices: list, ok: true };
        setDevices(list);
        setListError(null);
      } catch (err) {
        log.warn('listDevices failed', err);
        if (!mounted.current || generation !== refreshGeneration.current) return;
        settledRefreshGeneration.current = generation;
        latestList.current = { ...latestList.current, ok: false };
        const ipcErr = extractIpcError(err);
        setListError(
          ipcErr?.code === 'DEVICE_LINK_UNAVAILABLE'
            ? t('settings.devices.error.unavailable')
            : t('settings.devices.error.listFailed'),
        );
      } finally {
        if (mounted.current && showSpinner) setRefreshing(false);
      }
    },
    [active, t],
  );

  useEffect(() => {
    mounted.current = true;
    if (!active) {
      setDevices([]);
      return () => {
        mounted.current = false;
      };
    }
    const offOwnership = window.electronAPI.deviceLink.onOwnershipChanged((p) => {
      ownershipEventVersion.current += 1;
      setStandby(p.standby === true);
    });
    const ownershipVersionAtGetState = ownershipEventVersion.current;
    let controllerRevision = 0;
    let disposed = false;
    const offControlled = window.electronAPI.deviceLink.onControlledState((p) => {
      controllerRevision++;
      setControlledBy(p.controllers ?? []);
    });
    void window.electronAPI.deviceLink
      .getState()
      .then((s) => {
        if (disposed || !mounted.current) return;
        setEnabledState(s.remoteControlEnabled);
        setLinkStatus(s.linkStatus);
        setConnectionIssue(s.connectionIssue ?? null);
        if (ownershipEventVersion.current === ownershipVersionAtGetState) {
          setStandby(s.standby === true);
        }
        if (controllerRevision === 0) setControlledBy(s.controlledBy ?? []);
        setRevokedControllers(s.revokedControllers ?? []);
        applyDisabledControlDeviceIds(s.disabledControlDeviceIds ?? []);
      })
      .catch((err) => log.warn('getState failed', err));
    void refresh();

    const offPresence = window.electronAPI.deviceLink.onPresenceChanged(() => {
      void refresh();
    });
    const offStatus = window.electronAPI.deviceLink.onStatusChanged((p) => {
      setLinkStatus(p.status);
      if (p.status === 'online') void refresh();
    });
    const offIssue = window.electronAPI.deviceLink.onConnectionIssue((p) => {
      setConnectionIssue(p.issue);
    });
    const offControlTarget = window.electronAPI.deviceLink.onControlTargetChanged((p) => {
      applyDisabledControlDeviceIds(p.disabledControlDeviceIds ?? []);
    });
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      mounted.current = false;
      offPresence();
      offStatus();
      offIssue();
      offOwnership();
      offControlled();
      offControlTarget();
      clearInterval(timer);
    };
  }, [active, applyDisabledControlDeviceIds, refresh]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      const prev = enabled;
      setEnabledState(next);
      try {
        await window.electronAPI.deviceLink.setEnabled(next);
        toast.success(
          t(next ? 'settings.devices.toast.enabled' : 'settings.devices.toast.disabled'),
        );
      } catch (err) {
        log.warn('setEnabled failed', err);
        setEnabledState(prev);
        toast.error(t('settings.devices.toast.toggleFailed'));
      }
    },
    [enabled, t],
  );

  const rename = useCallback(
    async (deviceId: string, name: string | null) => {
      const nextName = typeof name === 'string' ? name.trim() : null;
      if (typeof name === 'string' && !nextName) return;
      try {
        const result = await window.electronAPI.deviceLink.renameDevice(deviceId, nextName);
        // 服务端会广播在线设备 presence,但发起改名的窗口先乐观推进两份渲染层缓存,
        // 使离线设备 / 被拒设备 / 已同步分片也能立刻显示新名:
        //  - remoteProjectsStore:已同步设备的会话分片名(tooltip 用的 deviceLinkDeviceName)+ 接入器缓存名;
        //  - useDeviceLinkDeviceList:切换栏「全量设备」单例,覆盖连接中 / 被拒(无同步分片)设备的 chip 名。
        remoteProjectsStore.renameDevice(deviceId, result.name);
        renameDeviceLinkDevice(deviceId, result.name);
        void refresh();
      } catch (err) {
        log.warn('renameDevice failed', err);
        toast.error(t('settings.devices.toast.renameFailed'));
      }
    },
    [refresh, t],
  );

  const remove = useCallback(
    async (deviceId: string): Promise<boolean> => {
      try {
        const result = await window.electronAPI.deviceLink.deleteDevice(deviceId);
        if (!result.deleted || result.deviceId !== deviceId) {
          toast.error(t('settings.devices.toast.deleteFailed'));
          return false;
        }
        refreshGeneration.current += 1;
        setDevices((current) => current?.filter((device) => device.deviceId !== deviceId) ?? current);
        remoteProjectsStore.removeDevice(deviceId);
        removeDeviceLinkDevice(deviceId);
        void refresh();
        toast.success(t('settings.devices.toast.deleted'));
        return true;
      } catch (err) {
        log.warn('deleteDevice failed', err);
        const ipcErr = extractIpcError(err);
        if (ipcErr?.code !== 'ALREADY_EXISTS') {
          toast.error(t('settings.devices.toast.deleteFailed'));
          return false;
        }
        // 服务端以「设备在线」拒绝删除，删除没有发生。先刷新一次列表与服务端对齐(最多等一会儿)，
        // 再按此刻界面上的列表选提示：仍显示离线(含刷新超时、界面仍是原列表)说明两边的在线判断
        // 不一致，不能再提示「尚不支持移除在线设备」让用户误以为设备真在线；显示在线或刷新失败
        // (界面换成错误块、看不到设备行)时沿用原提示；列表里暂时没有这台设备时只报删除失败——
        // 在线设备可能被单次列表偶发漏掉，没有服务端的删除确认就不能推断已删除。
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const refreshing = refresh();
        const rejectedRefreshGeneration = refreshGeneration.current;
        await Promise.race([
          refreshing,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, REJECTED_DELETE_REFRESH_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
        // 超时后才返回的这次补拉作废：提示与返回值按此刻的列表给出，迟到结果不能再改动设备行，
        // 否则保持打开的确认框会指向一个已经消失的设备。期间若已有更新的刷新发起，它不受影响；
        // 它还没返回时列表的在线状态未定，提示不引用在线状态。
        const newerPending =
          timedOut &&
          refreshGeneration.current !== rejectedRefreshGeneration &&
          refreshGeneration.current !== settledRefreshGeneration.current;
        if (timedOut && refreshGeneration.current === rejectedRefreshGeneration) {
          refreshGeneration.current += 1;
        }
        const { devices: listed, ok } = latestList.current;
        const target = ok ? listed?.find((device) => device.deviceId === deviceId) : undefined;
        toast.error(
          t(
            newerPending || (ok && listed && !target)
              ? 'settings.devices.toast.deleteFailed'
              : target && !target.online
                ? 'settings.devices.toast.deleteRejectedWhileOffline'
                : 'settings.devices.toast.deleteOnline',
          ),
        );
        return false;
      }
    },
    [refresh, t],
  );

  const disconnectAll = useCallback(async () => {
    try {
      await window.electronAPI.deviceLink.disconnectAll();
      toast.success(t('settings.devices.toast.disconnected'));
    } catch (err) {
      log.warn('disconnectAll failed', err);
      toast.error(t('settings.devices.toast.disconnectFailed'));
    }
  }, [t]);

  const revoke = useCallback(
    async (deviceId: string) => {
      const prev = revokedControllers;
      setRevokedControllers((r) => (r.includes(deviceId) ? r : [...r, deviceId])); // 乐观
      try {
        await window.electronAPI.deviceLink.revoke(deviceId);
        toast.success(t('settings.remoteControl.toast.revoked'));
      } catch (err) {
        log.warn('revoke failed', err);
        setRevokedControllers(prev);
        toast.error(t('settings.remoteControl.toast.revokeFailed'));
      }
    },
    [revokedControllers, t],
  );

  const restore = useCallback(
    async (deviceId: string) => {
      const prev = revokedControllers;
      setRevokedControllers((r) => r.filter((id) => id !== deviceId)); // 乐观
      try {
        await window.electronAPI.deviceLink.restore(deviceId);
        toast.success(t('settings.remoteControl.toast.restored'));
      } catch (err) {
        log.warn('restore failed', err);
        setRevokedControllers(prev);
        toast.error(t('settings.remoteControl.toast.restoreFailed'));
      }
    },
    [revokedControllers, t],
  );

  const setDeviceControlEnabled = useCallback(
    async (deviceId: string, next: boolean) => {
      const prev = disabledControlDeviceIdsRef.current;
      applyDisabledControlDeviceIds(
        next
          ? prev.filter((id) => id !== deviceId)
          : prev.includes(deviceId)
            ? prev
            : [...prev, deviceId],
      );
      try {
        const result = await window.electronAPI.deviceLink.setDeviceControlEnabled(deviceId, next);
        applyDisabledControlDeviceIds(result.disabledControlDeviceIds);
        toast.success(
          t(
            next
              ? 'settings.devices.toast.controlEnabled'
              : 'settings.devices.toast.controlDisabled',
          ),
        );
      } catch (err) {
        log.warn('setDeviceControlEnabled failed', err);
        const current = disabledControlDeviceIdsRef.current;
        applyDisabledControlDeviceIds(
          next
            ? current.includes(deviceId)
              ? current
              : [...current, deviceId]
            : current.filter((id) => id !== deviceId),
        );
        toast.error(t('settings.devices.toast.controlToggleFailed'));
      }
    },
    [applyDisabledControlDeviceIds, t],
  );

  return {
    enabled,
    linkStatus,
    connectionIssue,
    standby,
    devices,
    controlledBy,
    revokedControllers,
    disabledControlDeviceIds,
    listError,
    refreshing,
    refresh,
    setEnabled,
    rename,
    remove,
    disconnectAll,
    revoke,
    restore,
    setDeviceControlEnabled,
  };
}
