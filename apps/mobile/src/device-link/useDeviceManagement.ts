import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceView } from '@cindy/device-link';
import type { ApiFetchOptions } from '@/api/client';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { revokedDevicesStore } from '@/device-link/revokedDevicesStore';
import { i18n } from '@/i18n';
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from '@/auth/authOwnerGeneration';
import {
  hydrateDeviceIdentityCache,
  normalizeDeviceDisplayName,
  reconcileDeviceIdentities,
} from './deviceIdentityStore';
import { MAX_DEVICE_NAME_LENGTH } from './deviceName';

type ApiFetch = <T>(path: string, options: ApiFetchOptions) => Promise<T>;
const DEVICE_TIMEOUT_MS = 8_000;

/** The screen is keyed by accountGeneration so a previous account never shares this state. */
export function useDeviceManagement(apiFetch: ApiFetch, focused: boolean) {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [renameTarget, setRenameTarget] = useState<DeviceView | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<Error | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeviceView | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const editingRef = useRef(false);
  editingRef.current = renameTarget !== null || deleteTarget !== null;
  const lifetimeRef = useRef({ active: true, owner: getMobileAuthOwner() });
  useEffect(() => {
    const lifetime = { active: true, owner: lifetimeRef.current.owner };
    lifetimeRef.current = lifetime;
    return () => {
      lifetime.active = false;
    };
  }, []);

  useEffect(() => {
    // Closing an editor must preserve scroll position and keep the next action
    // immediately available. Refresh only on focus or an explicit retry.
    if (!focused || editingRef.current) return;
    let cancelled = false;
    const owner = lifetimeRef.current.owner;
    const isCurrent = () => !cancelled && isMobileAuthOwnerCurrent(owner);
    if (!isCurrent()) return;
    setLoading(true);
    setError(null);
    void apiFetch<{ devices: DeviceView[] }>('/api/device-link/devices', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      timeoutMs: DEVICE_TIMEOUT_MS,
    })
      .then((result) => {
        if (!isCurrent()) return;
        setDevices((current) => {
          if (!isCurrent()) return current;
          // Prefer home's latest valid identities, falling back to this account's
          // last successful view. No extra persistent cache is needed.
          const known = [...current, ...remoteSessionStore.getDeviceIdentity()];
          const cache = hydrateDeviceIdentityCache({
            names: Object.fromEntries(
              known
                .filter((item) => normalizeDeviceDisplayName(item.name))
                .map((item) => [item.deviceId, item.name]),
            ),
            order: Object.fromEntries(
              known.map((item, index) => [item.deviceId, index]),
            ),
          });
          return reconcileDeviceIdentities(result.devices, cache).devices;
        });
      })
      .catch((cause) => {
        // Keep the last successful list on transient network errors.
        if (isCurrent()) setError(formatRemoteError(cause));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, focused, refreshVersion]);

  const refresh = useCallback(() => {
    if (!savingRef.current && !renameTarget && !deleteTarget)
      setRefreshVersion((value) => value + 1);
  }, [renameTarget, deleteTarget]);

  const openRename = useCallback(
    (device: DeviceView) => {
      // Do not race a pending list snapshot or another rename.
      if (loading || savingRef.current || deleteTarget) return;
      setRenameTarget(device);
      setRenameDraft(device.name);
      setRenameError(null);
    },
    [loading, deleteTarget],
  );

  const closeRename = useCallback(() => {
    if (!savingRef.current) setRenameTarget(null);
  }, []);

  const confirmRename = useCallback(
    async (draft?: string) => {
      const target = renameTarget;
      const name = (draft ?? renameDraft).trim();
      const lifetime = lifetimeRef.current;
      const owner = lifetime.owner;
      const isCurrent = () =>
        lifetime.active && isMobileAuthOwnerCurrent(owner);
      if (!isCurrent() || !target || !name || savingRef.current) return;
      if (name === target.name.trim()) {
        setRenameTarget(null);
        return;
      }
      if (name.length > MAX_DEVICE_NAME_LENGTH) {
        setRenameDraft(name);
        // A fresh error also reopens the native prompt after repeated invalid submissions.
        setRenameError(
          new Error(
            i18n.t('devices.management.nameTooLong', {
              limit: MAX_DEVICE_NAME_LENGTH,
            }),
          ),
        );
        return;
      }
      savingRef.current = true;
      setRenameSaving(true);
      setRenameError(null);
      try {
        const result = await apiFetch<{ deviceId: string; name: string }>(
          `/api/device-link/devices/${encodeURIComponent(target.deviceId)}`,
          {
            baseUrl: DEVICE_LINK_API_BASE_URL,
            body: { name },
            method: 'PATCH',
            timeoutMs: DEVICE_TIMEOUT_MS,
          },
        );
        if (!isCurrent()) return;
        setDevices((current) =>
          current.map((device) =>
            device.deviceId === target.deviceId
              ? { ...device, name: result.name }
              : device,
          ),
        );
        remoteSessionStore.renameDevice(target.deviceId, result.name);
        remoteSessionStore.setDeviceIdentity(
          remoteSessionStore
            .getDeviceIdentity()
            .map((item) =>
              item.deviceId === target.deviceId
                ? { ...item, name: result.name }
                : item,
            ),
        );
        setRenameTarget(null);
      } catch (cause) {
        if (isCurrent()) setRenameError(new Error(formatRemoteError(cause)));
      } finally {
        if (isCurrent()) {
          savingRef.current = false;
          setRenameSaving(false);
        }
      }
    },
    [apiFetch, renameDraft, renameTarget],
  );

  const openDelete = useCallback(
    (device: DeviceView) => {
      if (loading || savingRef.current || renameTarget) return;
      setDeleteError(null);
      setDeleteTarget(device);
    },
    [loading, renameTarget],
  );

  const closeDelete = useCallback(() => {
    if (!savingRef.current) setDeleteTarget(null);
  }, []);

  const confirmDelete = useCallback(async () => {
    const target = deleteTarget;
    const lifetime = lifetimeRef.current;
    const owner = lifetime.owner;
    const isCurrent = () => lifetime.active && isMobileAuthOwnerCurrent(owner);
    if (!isCurrent() || !target || savingRef.current) return false;
    savingRef.current = true;
    setDeleteSaving(true);
    setDeleteError(null);
    try {
      const result = await apiFetch<{ deviceId: string; deleted: boolean }>(
        `/api/device-link/devices/${encodeURIComponent(target.deviceId)}`,
        {
          baseUrl: DEVICE_LINK_API_BASE_URL,
          method: 'DELETE',
          timeoutMs: DEVICE_TIMEOUT_MS,
        },
      );
      if (!isCurrent()) return false;
      if (!result.deleted)
        throw new Error(i18n.t('devices.management.deleteFailed'));
      setDevices((current) =>
        current.filter((device) => device.deviceId !== target.deviceId),
      );
      remoteSessionStore.removeDevice(target.deviceId);
      remoteSessionStore.setDeviceIdentity(
        remoteSessionStore
          .getDeviceIdentity()
          .filter((item) => item.deviceId !== target.deviceId),
      );
      revokedDevicesStore.clearRevoked(target.deviceId);
      setDeleteTarget(null);
      return true;
    } catch (cause) {
      if (isCurrent())
        setDeleteError(
          (cause as { code?: string })?.code === 'ALREADY_EXISTS'
            ? i18n.t('devices.management.deleteOnline')
            : formatRemoteError(cause),
        );
      return false;
    } finally {
      if (isCurrent()) {
        savingRef.current = false;
        setDeleteSaving(false);
      }
    }
  }, [apiFetch, deleteTarget]);

  return {
    devices,
    loading,
    error,
    refresh,
    openRename,
    closeRename,
    confirmRename,
    renameTarget,
    renameDraft,
    setRenameDraft,
    renameSaving,
    renameError,
    deleteTarget,
    deleteSaving,
    deleteError,
    openDelete,
    closeDelete,
    confirmDelete,
  };
}
