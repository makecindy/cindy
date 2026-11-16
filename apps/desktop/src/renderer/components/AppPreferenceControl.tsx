import { setModelVisibility, resetModelVisibilities, isModelEnabled, isModelVisibilityCustomized } from '@/state/modelVisibilityPrefs';
import { setMakerMemoryEnabled } from '@/lib/memorySettingsStore';
import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { appPreferenceSchema, type AppPreferencePatch } from '../../shared/appPreferenceControl';
import { useTheme } from '@/hooks/useTheme';
import { useLocale } from '@/hooks/useLocale';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';
import { useComposerSendShortcutPreference } from '@/hooks/useComposerSendShortcutPreference';
import { useLinkOpenPreference } from '@/hooks/useLinkOpenPreference';
import { useStreamFadePreference } from '@/hooks/useStreamFadePreference';
import { useMessageNavRailPreference } from '@/hooks/useMessageNavRailPreference';
import { useFileBrowserPreference } from '@/hooks/useFileBrowserPreference';
import { useHomeUsageDashboardPreference } from '@/hooks/useHomeUsageDashboardPreference';
import { usePromptRecommendationPreference } from '@/hooks/usePromptRecommendationPreference';
import { getThemeFamilies, tryGetFamily } from '@/themes/families';
import { refreshLocalThemes } from '@/themes/local-themes';

/** Validate persistence separately from hook memory: legacy setters may swallow quota errors. */
const persisted: Record<keyof AppPreferencePatch, { key: string; absent?: unknown }> = {
  theme: { key: 'theme' }, themeFamily: { key: 'theme.familyId' }, language: { key: 'language' },
  notifications: { key: 'notifications.enabled' }, sendShortcut: { key: 'chat.sendShortcutPreference', absent: 'enter' },
  webLinks: { key: 'chat.webLinkOpenPreference', absent: 'external' },
  localLinks: { key: 'chat.localLinkOpenPreference', absent: 'sidebar' },
  streamFade: { key: 'chat.streamFadePreference', absent: 'on' },
  messageNavigation: { key: 'chat.messageNavRail.enabled', absent: true },
  showIgnoredDirectories: { key: 'fileBrowser.showIgnoredDirs', absent: false },
  homeUsageDashboard: { key: 'home.usageDashboard.enabled' },
  promptRecommendations: { key: 'prompt-recommendation-enabled' },
};

/** Mounted once in the main App. Reuses the same setters and subscribers as Settings. */
export function AppPreferenceControl() {
  const theme = useTheme(); const locale = useLocale(); const notifications = useNotificationSettings();
  const shortcut = useComposerSendShortcutPreference(); const web = useLinkOpenPreference('web');
  const local = useLinkOpenPreference('local'); const fade = useStreamFadePreference();
  const navigation = useMessageNavRailPreference(); const files = useFileBrowserPreference();
  const home = useHomeUsageDashboardPreference(); const recommendations = usePromptRecommendationPreference();
  const state: Required<AppPreferencePatch> = { theme: theme.theme, themeFamily: theme.familyId,
    language: locale.locale, notifications: notifications.enabled, sendShortcut: shortcut.preference,
    webLinks: web.preference, localLinks: local.preference, streamFade: fade.preference,
    messageNavigation: navigation.enabled, showIgnoredDirectories: files.showIgnoredDirs,
    homeUsageDashboard: home.enabled, promptRecommendations: recommendations.enabled };
  const current = useRef<{ state: Required<AppPreferencePatch>; apply: (patch: AppPreferencePatch, active: () => boolean) => Promise<void> | undefined }>({ state, apply: () => undefined });
  current.current = { state, apply: (patch, active) => {
    if (patch.themeFamily !== undefined && !tryGetFamily(patch.themeFamily)) throw new Error('UNKNOWN_THEME');
    // The shortcut setter can reject a voice-input conflict, before other fields change.
    if (patch.sendShortcut !== undefined && !shortcut.setPreference(patch.sendShortcut).ok) throw new Error('SHORTCUT_CONFLICT');
    const applyOtherFields = () => {
      if (patch.language !== undefined) locale.setLocale(patch.language);
      if (patch.notifications !== undefined) notifications.setEnabled(patch.notifications);
      if (patch.webLinks !== undefined) web.setPreference(patch.webLinks);
      if (patch.localLinks !== undefined) local.setPreference(patch.localLinks);
      if (patch.streamFade !== undefined) fade.setPreference(patch.streamFade);
      if (patch.messageNavigation !== undefined) navigation.setEnabled(patch.messageNavigation);
      if (patch.showIgnoredDirectories !== undefined) files.setShowIgnoredDirs(patch.showIgnoredDirectories);
      if (patch.homeUsageDashboard !== undefined) home.setEnabled(patch.homeUsageDashboard);
      if (patch.promptRecommendations !== undefined) recommendations.setEnabled(patch.promptRecommendations);
    };
    const pending = patch.theme !== undefined || patch.themeFamily !== undefined
      ? theme.setSelection({ theme: patch.theme, familyId: patch.themeFamily }, active) : undefined;
    if (pending) return pending.then(applied => {
      if (!applied) throw new Error('THEME_PREPARATION_NOT_CONFIRMED');
      flushSync(applyOtherFields);
    });
    applyOtherFields();
  } };
  useEffect(() => window.electronAPI?.appPreferenceControl?.onSettingsChanged(event => {
    if (event.section !== 'memory' || !isDataOwnerPushStampCurrent(event.ownerStamp)) return;
    void window.electronAPI.maker.memoryGetSettings().then(settings => {
      if (isDataOwnerPushStampCurrent(event.ownerStamp)) setMakerMemoryEnabled(settings.maker);
    }).catch(() => {});
  }), []);
  useEffect(() => {
    const bridge = window.electronAPI?.appPreferenceControl;
    if (!bridge) return;
    return bridge.onRequest(async request => {
      if (!isDataOwnerPushStampCurrent(request.ownerStamp) || Date.now() > request.expiresAt) {
        bridge.reply({ requestId: request.requestId, ok: false }); return;
      }
      try {
        if (request.operation === 'refresh-themes') {
          const refreshed = await refreshLocalThemes();
          if (!refreshed.success || !isDataOwnerPushStampCurrent(request.ownerStamp) || Date.now() > request.expiresAt)
            throw new Error('THEME_REFRESH_NOT_CONFIRMED');
        }
        let modelVisibility: { visible: boolean; customized: boolean } | undefined;
        if (request.operation === 'model-visibility') {
          const change = request.modelVisibility;
          if (!change) throw new Error('MISSING_MODEL');
          const { target, visible, defaultEnabled } = change;
          const saved = visible === null
            ? await resetModelVisibilities(target.providerId, [{ agent: target.agent, modelId: target.modelId }])
            : await setModelVisibility(target.agent, target.providerId, target.modelId, visible);
          if (!saved || !isDataOwnerPushStampCurrent(request.ownerStamp)) throw new Error('MODEL_VISIBILITY_NOT_SAVED');
          modelVisibility = { visible: isModelEnabled(target.agent, target.providerId, { id: target.modelId, defaultEnabled }),
            customized: isModelVisibilityCustomized(target.agent, target.providerId, target.modelId) };
        }
        if (request.operation === 'reset') throw new Error('RESET_NOT_SUPPORTED');
        if (request.operation === 'update') {
          const patch = appPreferenceSchema.parse(request.patch);
          let pending: Promise<void> | undefined;
          flushSync(() => { pending = current.current.apply(patch,
            () => isDataOwnerPushStampCurrent(request.ownerStamp) && Date.now() <= request.expiresAt); });
          if (pending) await pending;
          for (const [key, expected] of Object.entries(patch)) {
            const storage = persisted[key as keyof AppPreferencePatch];
            const raw = localStorage.getItem(storage.key);
            const actual = raw === null ? storage.absent : typeof expected === 'boolean' ? raw === 'true' : raw;
            if (actual !== expected) throw new Error('PERSISTENCE_NOT_CONFIRMED');
          }
        }
        bridge.reply({ requestId: request.requestId, ok: true, state: current.current.state,
          themeFamilies: getThemeFamilies().map(family => family.id), ...(modelVisibility ? { modelVisibility } : {}) });
      } catch { bridge.reply({ requestId: request.requestId, ok: false }); }
    });
  }, []);
  return null;
}
