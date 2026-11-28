import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoginBrandStage } from '@/components/login/LoginBrandStage';
import { LoginPageView } from '@/components/login/LoginPage';
import { ThemeProvider } from '@/hooks/useTheme';
import { FontSettingsProvider } from '@/hooks/useFontSettings';
import { LocaleProvider } from '@/hooks/useLocale';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { createLogger } from '@/lib/logger';
import type { CloudLoginApi, CloudLoginWindowState } from '../../../shared/cloudLoginWindow';
import { CloudInstanceLoginFlow } from './CloudInstanceLoginPage';
import { cloudLoginWindowApi } from './cloudBridge';

const log = createLogger('CloudLoginWindow');

export function CloudLoginWindowLayout() {
  const bridge = useMemo(cloudLoginWindowApi, []);
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<CloudLoginWindowState>({ generation: -1, target: null });
  useEffect(() => {
    let live = true;
    const accept = (next: CloudLoginWindowState) => {
      if (!live) return;
      setState((previous) => (next.generation >= previous.generation ? next : previous));
      if (!next.target && document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    };
    const off = bridge.onChanged(accept);
    const offLocale = bridge.onLocaleChanged((locale) => {
      void i18n.changeLanguage(locale);
    });
    void bridge
      .getState()
      .then(accept)
      .catch(() => log.warn('read window state failed'));
    void bridge.rendererReady().catch(() => log.warn('report shell ready failed'));
    // The shared login shell has committed, including loading/error/close controls.
    const frame = requestAnimationFrame(() => {
      void bridge.presentationReady().catch(() => log.warn('report presentation ready failed'));
    });
    return () => {
      live = false;
      off();
      offLocale();
      cancelAnimationFrame(frame);
    };
  }, [bridge, i18n]);
  const close = useCallback(() => {
    void bridge.close(state.generation).catch(() => log.warn('close window failed'));
  }, [bridge, state.generation]);
  useAppShortcut('close-tab-or-window', () => {
    close();
    return true;
  });
  const api = useMemo<CloudLoginApi>(
    () => ({
      instanceLoginStart: () => bridge.start(state.generation),
      instanceLoginDispatch: (input) => bridge.dispatch(state.generation, input),
      instanceLoginPoll: (input) => bridge.poll(state.generation, input),
      instanceLoginClose: (input) => bridge.end(state.generation, input),
    }),
    [bridge, state.generation],
  );
  return (
    <>
      <LoginBrandStage />
      {state.target ? (
        <CloudInstanceLoginFlow
          key={state.generation}
          target={state.target}
          api={api}
          onClose={close}
        />
      ) : (
        <LoginPageView
          key={state.generation}
          intent="cloud-instance"
          targetLabel={t('cloudSettings.onboarding.initialize')}
          onClose={close}
          login={{
            isLoading: true,
            errorCode: null,
            retryAt: undefined,
            loginState: null,
            clearError: () => {},
            dispatch: async () => false,
            dispatchWithResult: async () => ({ success: false, code: null }),
          }}
        />
      )}
    </>
  );
}
export function CloudLoginWindowRoot() {
  return (
    <ThemeProvider>
      <FontSettingsProvider>
        <LocaleProvider>
          <CloudLoginWindowLayout />
        </LocaleProvider>
      </FontSettingsProvider>
    </ThemeProvider>
  );
}
