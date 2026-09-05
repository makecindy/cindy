import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceView } from '@cindy/device-link';
import type { ApiFetchOptions } from '@/api/client';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { revokedDevicesStore } from '@/device-link/revokedDevicesStore';
import { i18n } from '@/i18n';

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
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeviceView | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const editingRef = useRef(false);
  editingRef.current = renameTarget !== null || deleteTarget !== null;
  const lifetimeRef = useRef({ active: true });
  useEffect(() => {
    const lifetime = { active: true };
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
    setLoading(true);
    setError(null);
    void apiFetch<{ devices: DeviceView[] }>('/api/device-link/devices', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      timeoutMs: DEVICE_TIMEOUT_MS,
    })
      .then((result) => {
        if (!cancelled) setDevices(result.devices);
      })
      .catch((cause) => {
        // Keep the last successful list on transient network errors.
        if (!cancelled) setError(formatRemoteError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
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
      if (!lifetime.active || !target || !name || savingRef.current) return;
      if (name === target.name.trim()) {
        setRenameTarget(null);
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
        if (!lifetime.active) return;
        setDevices((current) =>
          current.map((device) =>
            device.deviceId === target.deviceId
              ? { ...device, name: result.name }
              : device,
          ),
        );
        remoteSessionStore.renameDevice(target.deviceId, result.name);
        setRenameTarget(null);
      } catch (cause) {
        if (lifetime.active) setRenameError(formatRemoteError(cause));
      } finally {
        if (lifetime.active) {
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
    if (!lifetime.active || !target || savingRef.current) return false;
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
      if (!lifetime.active) return false;
      if (!result.deleted)
        throw new Error(i18n.t('devices.management.deleteFailed'));
      setDevices((current) =>
        current.filter((device) => device.deviceId !== target.deviceId),
      );
      remoteSessionStore.removeDevice(target.deviceId);
      revokedDevicesStore.clearRevoked(target.deviceId);
      setDeleteTarget(null);
      return true;
    } catch (cause) {
      if (lifetime.active)
        setDeleteError(
          (cause as { code?: string })?.code === 'ALREADY_EXISTS'
            ? i18n.t('devices.management.deleteOnline')
            : formatRemoteError(cause),
        );
      return false;
    } finally {
      if (lifetime.active) {
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
