// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import { MAKE_DOCTOR_CHECK_IDS, type MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';
import { CindyMakePreflightDialog } from '../CindyMakePreflightDialog';

const h = vi.hoisted(() => ({
  publish: undefined as undefined | ((report: MakeDoctorReport) => void),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/lib/cindyMakeDoctor', () => ({
  startMakeDoctor: (publish: (report: MakeDoctorReport) => void) => {
    h.publish = publish;
    return 'run';
  },
  cancelMakeDoctor: async () => {},
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));

const ready: MakeDoctorReport = {
  runId: 'run',
  mode: 'prepare',
  status: 'completed',
  platform: 'win32',
  arch: 'x64',
  checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'passed' })),
  source: { status: 'ready', path: '/source' },
  upstream: { status: 'notFound', items: [] },
};

beforeEach(() => {
  h.publish = undefined;
  setDataOwnerGeneration('preflight-locales');
});
afterEach(() => {
  cleanup();
  setDataOwnerGeneration(null);
});

describe('Cindy Make close confirmation with real translations', () => {
  it.each([
    {
      locale: 'en',
      resource: en,
      close: 'Dismiss',
      title: 'Close Cindy Make?',
      keep: 'Keep Viewing',
      source: 'Source preparation is still running.',
      complete: 'Preparation is complete, but work has not started.',
    },
    {
      locale: 'zh-CN',
      resource: zhCN,
      close: '关闭',
      title: '关闭 Cindy Make？',
      keep: '继续查看',
      source: '源码准备尚未完成。',
      complete: '准备已完成，尚未开始制作。',
    },
    {
      locale: 'zh-TW',
      resource: zhTW,
      close: '關閉',
      title: '關閉 Cindy Make？',
      keep: '繼續查看',
      source: '原始碼準備尚未完成。',
      complete: '準備已完成，尚未開始製作。',
    },
    {
      locale: 'ja',
      resource: ja,
      close: '閉じる',
      title: 'Cindy Make を閉じますか？',
      keep: '表示を続ける',
      source: 'ソースコードの準備が進行中です。',
      complete: '準備は完了していますが、制作はまだ始まっていません。',
    },
    {
      locale: 'ko',
      resource: ko,
      close: '닫기',
      title: 'Cindy Make를 닫을까요?',
      keep: '계속 보기',
      source: '소스 코드를 준비하고 있습니다.',
      complete: '준비가 완료되었지만 제작은 아직 시작되지 않았습니다.',
    },
  ])(
    'renders $locale state and actions without fallback or damaged text',
    async ({ locale, resource, close, title, keep, source, complete }) => {
      const i18n = createInstance();
      await i18n.use(initReactI18next).init({
        lng: locale,
        fallbackLng: false,
        defaultNS: 'common',
        resources: { [locale]: { common: resource } },
        interpolation: { escapeValue: false },
      });
      render(
        <I18nextProvider i18n={i18n}>
          <CindyMakePreflightDialog request="Change the background" onOpenChange={vi.fn()} />
        </I18nextProvider>,
      );
      await waitFor(() => expect(h.publish).toBeTypeOf('function'));
      act(() =>
        h.publish!({
          ...ready,
          status: 'running',
          source: { status: 'preparing', path: '/source' },
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: close }));
      const dialog = screen.getByRole('alertdialog', { name: title });
      expect(dialog.textContent).toContain(source);
      expect(screen.getByRole('button', { name: keep })).toBeTruthy();
      act(() => h.publish!(ready));
      expect(dialog.textContent).toContain(complete);
      expect(dialog.textContent).not.toContain(source);
      expect(dialog.textContent).not.toMatch(/cindyMake[.]|[{][{]|[?]{2,}|�/);
    },
  );
});
