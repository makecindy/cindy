// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '@/i18n/locales/en/common.json';
import ja from '@/i18n/locales/ja/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import type { SshAccessLocalState } from '../../../../shared/sshAccess';
import { SshAccessSetting } from '../SshAccessSetting';

// 测试价值
// - 生产入口与可观察结果：SshAccessSetting 用真实语言包渲染时，「说明 + 默认值」两句与终端命令那一行在界面上的
//   实际文字：英文句间一个空格；中文、日文句间不留空格，中文全角冒号后直接接命令。
// - Bug／规则依据：用 {' '} 拼两句译文时中文多出空格（「一起收回。 云主机默认打开。」「连接： ssh …」）；多句文案
//   由各语言的整句字符串负责间隔（engineering-conventions §5、DESIGN §11.2）。
// - 现有覆盖缺口：sshAccessSetting.test.tsx 把 react-i18next 换成只回显 key 的替身，看不到各语言实际的间隔；
//   这里要真实的 i18next，所以不能并进那个文件。
// - 最小失败输入：zh-CN，云主机默认打开、已开启且未受阻（会显示终端命令）。
// - tier：unit（jsdom，真实 i18next 实例与三个语言包，宿主接口为内存 fake）；单独运行约 1.9 秒。
/** The part of a catalog this test reads (the catalogs differ elsewhere, in their plural keys). */
type Catalog = { settings: { remoteControl: { sshAccess: { description: string; defaultOn: string; aliasIntro: string } } } };

const state: SshAccessLocalState = {
  supported: true, remoteControlEnabled: true, setting: true, defaultSetting: true, customized: false, cloudGuest: true,
  enabled: true, blocked: null, endpoint: null, devices: [], manualKeys: [], recordUnreadable: false, lastSessionCleanup: null,
  endsDeviceSessions: true,
};

afterEach(cleanup);

// Columns: the text between the two sentences, and what leads into the command.
it.each([
  ['en', en, ' ', ': ssh '],
  ['zh-CN', zhCN, '', '：ssh '],
  ['ja', ja, '', ': ssh '],
] as const)('spaces the sentences and the command the way %s writes them', async (locale, catalog: Catalog, between, intoCommand) => {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: locale,
    resources: { [locale]: { translation: catalog } },
    interpolation: { escapeValue: false },
  });
  Object.assign(window, { electronAPI: { sshAccess: { read: async () => state, onChanged: () => () => {} } } });
  render(
    <I18nextProvider i18n={i18n}>
      <SshAccessSetting selfName="VM-4-7-ubuntu" selfDeviceId="abc" deviceNames={new Map()} />
    </I18nextProvider>,
  );
  await act(async () => {});

  const copy = catalog.settings.remoteControl.sshAccess;
  expect(screen.getByText(`${copy.description}${between}${copy.defaultOn}`)).toBeTruthy();
  const command = screen.getByText('ssh cindy-vm-4-7-ubuntu');
  expect(command.tagName).toBe('CODE');
  const line = command.parentElement?.textContent;
  expect(line).toBe(copy.aliasIntro.replace(/<command>.*<\/command>/, 'ssh cindy-vm-4-7-ubuntu'));
  expect(line).toContain(`${intoCommand}cindy-vm-4-7-ubuntu`);
});
