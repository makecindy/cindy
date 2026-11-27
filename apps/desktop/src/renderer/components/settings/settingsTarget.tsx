import { createContext, useContext, type ReactNode } from 'react';

type Api = Window['electronAPI'];

/**
 * The settings calls the IM cards make. By default they are this computer's own APIs, read at
 * call time; another surface may supply the same calls for a different computer.
 */
export interface SettingsTargetApi {
  hookControl: Api['hookControl'];
  telegramBot: Pick<
    Api['telegramBot'],
    'getBehavior' | 'setBehavior' | 'getPersona' | 'setPersona' | 'listGroups' | 'setGroupActivation'
  >;
  imDefaultSettingsGet: Api['maker']['imDefaultSettingsGet'];
  showOpenDirectoryDialog: Api['showOpenDirectoryDialog'];
}

export interface SettingsTarget {
  /** null = this computer. Otherwise model pickers and capabilities read that device. */
  deviceId: string | null;
  api: SettingsTargetApi;
}

const localApi: SettingsTargetApi = {
  get hookControl() {
    return window.electronAPI.hookControl;
  },
  get telegramBot() {
    return window.electronAPI.telegramBot;
  },
  imDefaultSettingsGet: (channel) => window.electronAPI.maker.imDefaultSettingsGet(channel),
  showOpenDirectoryDialog: () => window.electronAPI.showOpenDirectoryDialog(),
};
const LOCAL_TARGET: SettingsTarget = { deviceId: null, api: localApi };

const SettingsTargetContext = createContext<SettingsTarget>(LOCAL_TARGET);

/** Scope the enclosed settings cards to another computer; keep the value stable. */
export function SettingsTargetProvider({
  target,
  children,
}: {
  target: SettingsTarget;
  children: ReactNode;
}) {
  return <SettingsTargetContext.Provider value={target}>{children}</SettingsTargetContext.Provider>;
}

export function useSettingsTarget(): SettingsTarget {
  return useContext(SettingsTargetContext);
}
