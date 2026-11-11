import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { resolveRemoteText, type RemoteResourceRef, type RemoteText } from '@cindy/device-link';
import { invokeRemoteResourceAction } from '@/device-link/remoteResources';
import type { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { loadCompanionProfile, type CompanionProfileData } from './companionProfileData';

type DeviceLink = ReturnType<typeof useDeviceLink>;

export interface CompanionAutomationRow { id: string; title: RemoteText; subtitle?: RemoteText; on: boolean }

/**
 * The teammate's automations shown in place on its settings home (2026-11-10 owner): each with its
 * timing and a switch that applies at once. Read from the host page `settings:<id>/automations`;
 * a host whose page has no switches yields null, so the caller keeps its row to that page.
 */
export function useCompanionAutomations(input: {
  invoke: DeviceLink['invoke']; openLink: DeviceLink['openLink']; deviceId: string; deviceName: string;
  botRef: RemoteResourceRef | null; resourceId?: string; online: boolean; visible: boolean; binding: string; locale: string;
}) {
  const { invoke, openLink, deviceId, deviceName, botRef, resourceId, online, visible, binding, locale } = input;
  const [data, setData] = useState<CompanionProfileData | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const current = useRef(binding);
  current.current = binding;
  const load = useCallback(async () => {
    if (!online || !visible || !botRef || !resourceId) return;
    const started = binding;
    try {
      await openLink(deviceId);
      const next = await loadCompanionProfile(invoke, deviceId, { ...botRef, id: resourceId }, locale);
      if (current.current === started) { setData(next); setError(false); }
    } catch { if (current.current === started) setError(true); }
  }, [online, visible, botRef?.collectionId, botRef?.kind, botRef?.id, resourceId, binding, openLink, deviceId, invoke, locale]);
  useEffect(() => { setData(null); setError(false); }, [binding, resourceId]);
  useEffect(() => { void load(); }, [load]);

  const panel = data?.panels.find(item => item.id === 'automations' && item.action);
  const rows: CompanionAutomationRow[] | null = panel?.action ? (panel.entries ?? []).flatMap(entry =>
    typeof panel.values[entry.id] === 'boolean'
      ? [{ id: entry.id, title: entry.title, ...(entry.subtitle ? { subtitle: entry.subtitle } : {}), on: panel.values[entry.id] === true }]
      : []) : null;

  const apply = async (id: string, on: boolean) => {
    if (!panel?.action || !data || pending) return;
    const started = binding;
    setPending(id); setError(false);
    try {
      await openLink(deviceId);
      await invokeRemoteResourceAction(invoke, { deviceId, deviceName }, {
        collectionId: data.resource.ref.collectionId, resourceRef: data.resource.ref, actionId: panel.action.id, input: { [id]: on },
      }, locale);
    } catch { if (current.current === started) setError(true); }
    finally {
      if (current.current === started) { setPending(null); void load(); }
    }
  };
  const toggle = (id: string, on: boolean) => {
    const confirmation = panel?.action?.confirmation;
    // Same as the Automations page: pausing stops runs in progress, so it asks first.
    if (!on && confirmation) {
      const text = (value?: RemoteText) => value === undefined ? undefined : resolveRemoteText(value, locale);
      Alert.alert(text(confirmation.title) ?? '', text(confirmation.body), [
        { text: resolveRemoteText({ fallback: 'Cancel', translations: { 'zh-CN': '取消', 'zh-TW': '取消', ja: 'キャンセル', ko: '취소' } }, locale), style: 'cancel' },
        { text: text(confirmation.confirmLabel) ?? 'OK', style: 'destructive', onPress: () => void apply(id, on) },
      ]);
      return;
    }
    void apply(id, on);
  };
  return { title: panel?.title, rows, pending, error, toggle };
}
