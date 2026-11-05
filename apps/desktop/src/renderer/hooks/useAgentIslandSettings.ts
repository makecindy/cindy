/**
 * useAgentIslandSettings — macOS Agent Island 的全局开关。
 *
 * 与通知设置同源存储在 localStorage,默认关闭;用户显式开启后才持久化。renderer 是
 * 用户偏好的持久化位置;main 进程通过轻量 IPC 接收当前开关,负责真正隐藏 native
 * island。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_AGENT_ISLAND_DISPLAY_TARGET,
  DEFAULT_AGENT_ISLAND_MASCOT_SKIN,
  DEFAULT_AGENT_ISLAND_SOUND_SETTINGS,
  cloneAgentIslandDisplayTarget,
  cloneAgentIslandSoundSettings,
  isAgentIslandMascotSkin,
  normalizeAgentIslandDisplayTarget,
  normalizeAgentIslandSoundSettings,
  isAgentIslandSupportedPlatform,
  type AgentIslandDisplayOption,
  type AgentIslandDisplayTarget,
  type AgentIslandMascotSkin,
  type AgentIslandSoundChoice,
  type AgentIslandSoundEvent,
  type AgentIslandSoundSettings,
} from '../../shared/agentIsland';
import { createLogger } from '@/lib/logger';

const STORAGE_KEY = 'notifications.agentIslandEnabled';
const SOUND_STORAGE_KEY = 'notifications.agentIslandSoundSettings';
const MASCOT_SKIN_STORAGE_KEY = 'notifications.agentIslandMascotSkin';
const DISPLAY_TARGET_STORAGE_KEY = 'notifications.agentIslandDisplayTarget';
const SUBTLE_REMINDERS_STORAGE_KEY = 'notifications.agentIslandSubtleReminders';
const DEFAULT_ENABLED = false;
const DEFAULT_SUBTLE_REMINDERS = false;

const log = createLogger('AgentIslandSettings');
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const cb of subscribers) cb();
}

/** Observe preferences without syncing native state or loading display options. */
export function subscribeAgentIslandSettings(onChange: () => void): () => void {
  subscribers.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    subscribers.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function persistAgentIslandDisplayTargetLocally(target: AgentIslandDisplayTarget): void {
  if (sameAgentIslandDisplayTarget(getAgentIslandDisplayTarget(), target)) return;
  try {
    localStorage.setItem(DISPLAY_TARGET_STORAGE_KEY, JSON.stringify(target));
  } catch {
    // localStorage 不可用时忽略，主进程仍使用本次解析出的目标。
    return;
  }
  notifySubscribers();
}

function sameAgentIslandDisplayTarget(
  a: AgentIslandDisplayTarget,
  b: AgentIslandDisplayTarget,
): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'all') return true;
  if (b.mode !== 'display' || a.displayId !== b.displayId) return false;
  return a.displayName === b.displayName
    && a.displayIndex === b.displayIndex
    && a.displayInternal === b.displayInternal
    && a.displayBounds?.x === b.displayBounds?.x
    && a.displayBounds?.y === b.displayBounds?.y
    && a.displayBounds?.width === b.displayBounds?.width
    && a.displayBounds?.height === b.displayBounds?.height;
}

export function isAgentIslandSupported(): boolean {
  return isAgentIslandSupportedPlatform(window.electronAPI?.platform, window.electronAPI?.osRelease);
}

/** 同步读 localStorage。坏数据按默认关闭处理。 */
export function getAgentIslandEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // localStorage 不可用——退回默认。
  }
  return DEFAULT_ENABLED;
}

export function getAgentIslandSubtleReminders(): boolean {
  try {
    const raw = localStorage.getItem(SUBTLE_REMINDERS_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // localStorage 不可用时使用当前默认值。
  }
  return DEFAULT_SUBTLE_REMINDERS;
}

function isAgentIslandSubtleRemindersCustomized(): boolean {
  try {
    return localStorage.getItem(SUBTLE_REMINDERS_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

async function applyAgentIslandSubtleRemindersToMain(enabled: boolean): Promise<boolean> {
  if (!isAgentIslandSupported()) return false;
  const apply = window.electronAPI?.agentIsland?.setSubtleReminders;
  if (typeof apply !== 'function') return false;
  try {
    await apply(enabled);
    return true;
  } catch (err) {
    log.warn('agent island setSubtleReminders failed', err);
    return false;
  }
}

export async function setAgentIslandSubtleReminders(next: boolean): Promise<boolean> {
  return updateAgentIslandSubtleRemindersOverride(next);
}

export async function resetAgentIslandSubtleReminders(): Promise<boolean> {
  return updateAgentIslandSubtleRemindersOverride(null);
}

async function updateAgentIslandSubtleRemindersOverride(next: boolean | null): Promise<boolean> {
  const previous = getAgentIslandSubtleReminders();
  if (!await applyAgentIslandSubtleRemindersToMain(next ?? DEFAULT_SUBTLE_REMINDERS)) return false;
  try {
    if (next === null) localStorage.removeItem(SUBTLE_REMINDERS_STORAGE_KEY);
    else localStorage.setItem(SUBTLE_REMINDERS_STORAGE_KEY, String(next));
  } catch {
    await applyAgentIslandSubtleRemindersToMain(previous);
    return false;
  }
  notifySubscribers();
  return true;
}

export function getAgentIslandSoundSettings(): AgentIslandSoundSettings {
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    if (!raw) return normalizeAgentIslandSoundSettings(null);
    return normalizeAgentIslandSoundSettings(JSON.parse(raw) as unknown);
  } catch {
    return normalizeAgentIslandSoundSettings(null);
  }
}

export function isAgentIslandSoundSettingsCustomized(): boolean {
  try {
    return localStorage.getItem(SOUND_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function getAgentIslandMascotSkin(): AgentIslandMascotSkin {
  try {
    const raw = localStorage.getItem(MASCOT_SKIN_STORAGE_KEY);
    if (isAgentIslandMascotSkin(raw)) return raw;
  } catch {
    // ignore
  }
  return DEFAULT_AGENT_ISLAND_MASCOT_SKIN;
}

export function getAgentIslandDisplayTarget(): AgentIslandDisplayTarget {
  try {
    const raw = localStorage.getItem(DISPLAY_TARGET_STORAGE_KEY);
    if (!raw) return cloneAgentIslandDisplayTarget(DEFAULT_AGENT_ISLAND_DISPLAY_TARGET);
    return normalizeAgentIslandDisplayTarget(JSON.parse(raw) as unknown);
  } catch {
    return cloneAgentIslandDisplayTarget(DEFAULT_AGENT_ISLAND_DISPLAY_TARGET);
  }
}

function getAgentIslandSetEnabledApi():
  | ((enabled: boolean) => Promise<{ ok: true }>)
  | null {
  const setEnabled = window.electronAPI?.agentIsland?.setEnabled;
  return typeof setEnabled === 'function' ? setEnabled : null;
}

function getAgentIslandSetSoundSettingsApi():
  | ((settings: AgentIslandSoundSettings) => Promise<{ ok: true }>)
  | null {
  const setSoundSettings = window.electronAPI?.agentIsland?.setSoundSettings;
  return typeof setSoundSettings === 'function' ? setSoundSettings : null;
}

function getAgentIslandSetMascotSkinApi():
  | ((skin: AgentIslandMascotSkin) => Promise<{ ok: true }>)
  | null {
  const setMascotSkin = window.electronAPI?.agentIsland?.setMascotSkin;
  return typeof setMascotSkin === 'function' ? setMascotSkin : null;
}

function getAgentIslandSetDisplayTargetApi():
  | ((target: AgentIslandDisplayTarget) => Promise<{ ok: true }>)
  | null {
  const setDisplayTarget = window.electronAPI?.agentIsland?.setDisplayTarget;
  return typeof setDisplayTarget === 'function' ? setDisplayTarget : null;
}

function getAgentIslandGetDisplayOptionsApi():
  | (() => Promise<{
      ok: true;
      options: AgentIslandDisplayOption[];
      target?: AgentIslandDisplayTarget;
    }>)
  | null {
  const getDisplayOptions = window.electronAPI?.agentIsland?.getDisplayOptions;
  return typeof getDisplayOptions === 'function' ? getDisplayOptions : null;
}

async function applyAgentIslandEnabledToMain(next: boolean): Promise<boolean> {
  if (!isAgentIslandSupported()) return false;
  const setEnabled = getAgentIslandSetEnabledApi();
  if (!setEnabled) {
    log.warn('agent island setEnabled unavailable; restart desktop to load the latest preload');
    return false;
  }
  try {
    await setEnabled(next);
    return true;
  } catch (err) {
    log.warn('agent island setEnabled failed', err);
    return false;
  }
}

async function applyAgentIslandSoundSettingsToMain(settings: AgentIslandSoundSettings): Promise<boolean> {
  if (!isAgentIslandSupported()) return false;
  const setSoundSettings = getAgentIslandSetSoundSettingsApi();
  if (!setSoundSettings) {
    log.warn('agent island setSoundSettings unavailable; restart desktop to load the latest preload');
    return false;
  }
  try {
    await setSoundSettings(settings);
    return true;
  } catch (err) {
    log.warn('agent island setSoundSettings failed', err);
    return false;
  }
}

async function applyAgentIslandMascotSkinToMain(skin: AgentIslandMascotSkin): Promise<boolean> {
  if (!isAgentIslandSupported()) return false;
  const setMascotSkin = getAgentIslandSetMascotSkinApi();
  if (!setMascotSkin) {
    log.warn('agent island setMascotSkin unavailable; restart desktop to load the latest preload');
    return false;
  }
  try {
    await setMascotSkin(skin);
    return true;
  } catch (err) {
    log.warn('agent island setMascotSkin failed', err);
    return false;
  }
}

async function applyAgentIslandDisplayTargetToMain(target: AgentIslandDisplayTarget): Promise<boolean> {
  if (!isAgentIslandSupported()) return false;
  const setDisplayTarget = getAgentIslandSetDisplayTargetApi();
  if (!setDisplayTarget) {
    log.warn('agent island setDisplayTarget unavailable; restart desktop to load the latest preload');
    return false;
  }
  try {
    await setDisplayTarget(target);
    return true;
  } catch (err) {
    log.warn('agent island setDisplayTarget failed', err);
    return false;
  }
}

export async function loadAgentIslandDisplayOptions(): Promise<AgentIslandDisplayOption[]> {
  if (!isAgentIslandSupported()) return [];
  const getDisplayOptions = getAgentIslandGetDisplayOptionsApi();
  if (!getDisplayOptions) {
    log.warn('agent island getDisplayOptions unavailable; restart desktop to load the latest preload');
    return [];
  }
  try {
    const result = await getDisplayOptions();
    const resolvedTarget = result.target
      ? normalizeAgentIslandDisplayTarget(result.target)
      : null;
    if (resolvedTarget) {
      persistAgentIslandDisplayTargetLocally(resolvedTarget);
    }
    return normalizeAgentIslandDisplayOptions(result.options);
  } catch (err) {
    log.warn('agent island getDisplayOptions failed', err);
    return [];
  }
}

export function syncAgentIslandEnabledToMain(): void {
  if (!isAgentIslandSupported()) return;
  void (async () => {
    await Promise.all([
      applyAgentIslandSubtleRemindersToMain(getAgentIslandSubtleReminders()),
      applyAgentIslandSoundSettingsToMain(getAgentIslandSoundSettings()),
      applyAgentIslandMascotSkinToMain(getAgentIslandMascotSkin()),
      applyAgentIslandDisplayTargetToMain(getAgentIslandDisplayTarget()),
    ]);
    await applyAgentIslandEnabledToMain(getAgentIslandEnabled());
  })();
}

export function useResyncAgentIslandSettingsAfterLogin(isAuthenticated: boolean): void {
  const previousAuthRef = useRef<boolean | null>(null);

  useEffect(() => {
    const previous = previousAuthRef.current;
    previousAuthRef.current = isAuthenticated;
    if (isAuthenticated && previous !== true) {
      syncAgentIslandEnabledToMain();
    }
  }, [isAuthenticated]);
}

export async function setAgentIslandEnabled(next: boolean): Promise<boolean> {
  const applied = await applyAgentIslandEnabledToMain(next);
  if (!applied) {
    notifySubscribers();
    return false;
  }
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // localStorage 不可用——忽略,UI 仍以内存值为准。
  }
  notifySubscribers();
  return true;
}

export async function setAgentIslandSoundSettings(next: AgentIslandSoundSettings): Promise<boolean> {
  const settings = cloneAgentIslandSoundSettings(next);
  const applied = await applyAgentIslandSoundSettingsToMain(settings);
  if (!applied) {
    notifySubscribers();
    return false;
  }
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
  notifySubscribers();
  return true;
}

export async function resetAgentIslandSoundSettings(): Promise<boolean> {
  const settings = cloneAgentIslandSoundSettings(DEFAULT_AGENT_ISLAND_SOUND_SETTINGS);
  const applied = await applyAgentIslandSoundSettingsToMain(settings);
  if (!applied) {
    notifySubscribers();
    return false;
  }
  try {
    localStorage.removeItem(SOUND_STORAGE_KEY);
  } catch {
    // ignore
  }
  notifySubscribers();
  return true;
}

export async function setAgentIslandMascotSkin(next: AgentIslandMascotSkin): Promise<boolean> {
  const applied = await applyAgentIslandMascotSkinToMain(next);
  if (!applied) {
    notifySubscribers();
    return false;
  }
  try {
    localStorage.setItem(MASCOT_SKIN_STORAGE_KEY, next);
  } catch {
    // ignore
  }
  notifySubscribers();
  return true;
}

export async function setAgentIslandDisplayTarget(next: AgentIslandDisplayTarget): Promise<boolean> {
  const target = cloneAgentIslandDisplayTarget(normalizeAgentIslandDisplayTarget(next));
  const applied = await applyAgentIslandDisplayTargetToMain(target);
  if (!applied) {
    notifySubscribers();
    return false;
  }
  persistAgentIslandDisplayTargetLocally(target);
  return true;
}

export function toggleAgentIslandSoundEnabled(): void {
  const current = getAgentIslandSoundSettings();
  void setAgentIslandSoundSettings({ ...current, enabled: !current.enabled });
}

export function previewAgentIslandSound(sound: AgentIslandSoundChoice): void {
  if (!isAgentIslandSupported() || (sound.type === 'builtin' && sound.id === 'none')) return;
  void window.electronAPI?.agentIsland?.previewSound?.(sound).catch((err) => {
    log.warn('agent island previewSound failed', err);
  });
}

export function useAgentIslandSettings(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  subtleReminders: boolean;
  subtleRemindersCustomized: boolean;
  setSubtleReminders: (next: boolean) => Promise<boolean>;
  resetSubtleReminders: () => Promise<boolean>;
  soundSettings: AgentIslandSoundSettings;
  soundCustomized: boolean;
  mascotSkin: AgentIslandMascotSkin;
  displayTarget: AgentIslandDisplayTarget;
  displayOptions: AgentIslandDisplayOption[];
  setSoundEnabled: (next: boolean) => void;
  setSound: (event: AgentIslandSoundEvent, sound: AgentIslandSoundChoice) => void;
  resetSoundSettings: () => Promise<boolean>;
  setMascotSkin: (skin: AgentIslandMascotSkin) => void;
  setDisplayTarget: (target: AgentIslandDisplayTarget) => void;
  previewSound: (sound: AgentIslandSoundChoice) => void;
  selectSoundFile: () => Promise<AgentIslandSoundChoice | null>;
  supported: boolean;
} {
  const [enabled, setEnabledState] = useState<boolean>(getAgentIslandEnabled);
  const [subtleReminders, setSubtleRemindersState] = useState(getAgentIslandSubtleReminders);
  const [subtleRemindersCustomized, setSubtleRemindersCustomizedState] = useState(isAgentIslandSubtleRemindersCustomized);
  const [soundSettings, setSoundSettingsState] = useState<AgentIslandSoundSettings>(getAgentIslandSoundSettings);
  const [soundCustomized, setSoundCustomizedState] = useState<boolean>(isAgentIslandSoundSettingsCustomized);
  const [mascotSkin, setMascotSkinState] = useState<AgentIslandMascotSkin>(getAgentIslandMascotSkin);
  const [displayTarget, setDisplayTargetState] = useState<AgentIslandDisplayTarget>(getAgentIslandDisplayTarget);
  const [displayOptions, setDisplayOptionsState] = useState<AgentIslandDisplayOption[]>([]);
  const supported = isAgentIslandSupported();

  const setEnabled = useCallback((next: boolean) => {
    void setAgentIslandEnabled(next);
  }, []);

  const setSoundEnabled = useCallback((next: boolean) => {
    const current = getAgentIslandSoundSettings();
    void setAgentIslandSoundSettings({ ...current, enabled: next });
  }, []);

  const setSound = useCallback((event: AgentIslandSoundEvent, sound: AgentIslandSoundChoice) => {
    const current = getAgentIslandSoundSettings();
    void setAgentIslandSoundSettings({
      ...current,
      sounds: {
        ...current.sounds,
        [event]: sound,
      },
    });
  }, []);

  const resetSoundSettings = useCallback(async () => {
    return resetAgentIslandSoundSettings();
  }, []);

  const setMascotSkin = useCallback((skin: AgentIslandMascotSkin) => {
    void setAgentIslandMascotSkin(skin);
  }, []);

  const setDisplayTarget = useCallback((target: AgentIslandDisplayTarget) => {
    let nextTarget = target;
    if (target.mode === 'display') {
      const option = displayOptions.find((item) => item.id === target.displayId);
      if (option) {
        nextTarget = {
          ...target,
          displayName: option.name || undefined,
          displayIndex: option.index,
          displayInternal: option.internal,
          displayBounds: { ...option.bounds },
        };
      }
    }
    void setAgentIslandDisplayTarget(nextTarget);
  }, [displayOptions]);

  const previewSound = useCallback((sound: AgentIslandSoundChoice) => {
    previewAgentIslandSound(sound);
  }, []);

  const selectSoundFile = useCallback(async (): Promise<AgentIslandSoundChoice | null> => {
    if (!isAgentIslandSupported()) return null;
    const result = await window.electronAPI?.agentIsland?.selectSoundFile?.();
    if (!result?.path) return null;
    return {
      type: 'custom',
      path: result.path,
      name: result.name ?? agentIslandSoundFileName(result.path),
    };
  }, []);

  useEffect(() => {
    syncAgentIslandEnabledToMain();
  }, []);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const refreshOptions = () => {
      void loadAgentIslandDisplayOptions().then((options) => {
        if (!cancelled) setDisplayOptionsState(options);
      });
    };
    refreshOptions();
    window.addEventListener('focus', refreshOptions);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshOptions);
    };
  }, [supported]);

  useEffect(() => {
    const onChange = () => {
      setEnabledState(getAgentIslandEnabled());
      setSubtleRemindersState(getAgentIslandSubtleReminders());
      setSubtleRemindersCustomizedState(isAgentIslandSubtleRemindersCustomized());
      setSoundSettingsState(getAgentIslandSoundSettings());
      setSoundCustomizedState(isAgentIslandSoundSettingsCustomized());
      setMascotSkinState(getAgentIslandMascotSkin());
      setDisplayTargetState(getAgentIslandDisplayTarget());
    };
    return subscribeAgentIslandSettings(onChange);
  }, []);

  return {
    enabled,
    setEnabled,
    subtleReminders,
    subtleRemindersCustomized,
    setSubtleReminders: setAgentIslandSubtleReminders,
    resetSubtleReminders: resetAgentIslandSubtleReminders,
    soundSettings,
    soundCustomized,
    mascotSkin,
    displayTarget,
    displayOptions,
    setSoundEnabled,
    setSound,
    resetSoundSettings,
    setMascotSkin,
    setDisplayTarget,
    previewSound,
    selectSoundFile,
    supported,
  };
}

function normalizeAgentIslandDisplayOptions(raw: unknown): AgentIslandDisplayOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): AgentIslandDisplayOption[] => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const bounds = record.bounds;
    if (
      typeof record.id !== 'number'
      || !Number.isFinite(record.id)
      || typeof record.index !== 'number'
      || !Number.isFinite(record.index)
      || typeof bounds !== 'object'
      || bounds === null
    ) {
      return [];
    }
    const boundsRecord = bounds as Record<string, unknown>;
    if (
      typeof boundsRecord.x !== 'number'
      || typeof boundsRecord.y !== 'number'
      || typeof boundsRecord.width !== 'number'
      || typeof boundsRecord.height !== 'number'
    ) {
      return [];
    }
    return [{
      id: record.id,
      index: record.index,
      name: typeof record.name === 'string' ? record.name.trim() : '',
      isPrimary: record.isPrimary === true,
      internal: record.internal === true,
      bounds: {
        x: boundsRecord.x,
        y: boundsRecord.y,
        width: boundsRecord.width,
        height: boundsRecord.height,
      },
    }];
  });
}

function agentIslandSoundFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) ?? filePath;
}
