import React from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import zh from '../../../src/renderer/i18n/locales/zh-CN/common.json';
import '../../../src/renderer/themes/colors';
import { ThemeService } from '../../../src/renderer/themes/theme-service';
import { defaultLight } from '../../../src/renderer/themes/builtin/default-light';
import { defaultDark } from '../../../src/renderer/themes/builtin/default-dark';
import {
  FeatureSidebarSlotProvider,
  useFeatureContentHeader,
} from '../../../src/renderer/features/feature-context';
import { BotGroupChatView } from '../../../src/renderer/features/bots/BotGroupChatView';
import { ControlledBanner } from '../../../src/renderer/features/remote-device/ControlledBanner';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
const q = new URLSearchParams(location.search);
const dark = q.get('theme') === 'dark';
new ThemeService().applyTheme(dark ? defaultDark : defaultLight);
document.documentElement.classList.toggle('dark', dark);
await i18next
  .use(initReactI18next)
  .init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { translation: zh } },
    interpolation: { escapeValue: false },
  });
const member = (botId: string, name: string) => ({
  botId,
  name,
  avatar: '',
  avatarColor: 'gray',
  status: 'active',
});
const group = {
  id: 'fixture-group',
  name: '设计讨论',
  replyMode: 'all',
  speakingMode: 'auto',
  members: [member('a', 'Aster'), member('b', 'Nova')],
  organizerBotId: 'a',
  projectDir: null,
  lastMessage: null,
  speakingBotIds: [],
  planningBotId: null,
  openPlan: null,
  createdAt: 1,
  updatedAt: 1,
  plans: [],
  messages: q.has('thread')
    ? Array.from({ length: 40 }, (_, i) => ({
        id: `m${i}`,
        sequence: i + 1,
        kind: 'message',
        authorKind: 'user',
        authorBotId: null,
        authorName: '',
        content: `布局回归消息 ${i + 1}`,
        mentions: { all: false, botIds: [] },
        noticeCode: null,
        planId: null,
        files: [],
        createdAt: 1700000000000 + i,
      }))
    : [],
  hasMoreBefore: false,
  round: { status: 'idle', speakers: [], canContinue: false },
};
(window as any).fixtureMutations = [];
const blocked = () => {
  (window as any).fixtureMutations.push('forbidden mutation');
  throw Error('Fixture forbids mutations');
};
window.electronAPI = {
  maker: {
    listBotGroups: async () => ({ ok: true, groups: [] }),
    getBotGroup: async () => ({ ok: true, group }),
    onBotGroupChanged: () => () => {},
    sendBotGroupMessage: blocked,
    stopBotGroupRound: blocked,
  },
  deviceLink: {
    getState: async () => ({ controlledBy: [] }),
    onControlledState: (
      cb: (payload: { controllers: Array<{ deviceId: string; name: string }> }) => void,
    ) => {
      (window as any).fixturePush = cb;
      return () => {};
    },
    revoke: blocked,
  },
} as any;
function Header() {
  return <header>{useFeatureContentHeader()}</header>;
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/bots/groups/fixture-group']}>
    <ConfirmDialogProvider>
      <FeatureSidebarSlotProvider isCollapsed={false}>
        <div className="fixture-caption">
          {q.get('stage')} · {dark ? '深色' : '浅色'} · 生产群聊组件 Fixture，非实机
        </div>
        <div className="fixture-shell">
          <aside style={{ width: Number(q.get('sidebar')) }}>
            伙伴
            <br />
            <br />
            Aster
            <br />
            <br />
            Nova
            <br />
            <br />
            群聊
            <br />
            <br />
            设计讨论
          </aside>
          <section className="fixture-content">
            <Header />
            <div className="fixture-view">
              <Routes>
                <Route path="/bots/groups/:groupId" element={<BotGroupChatView />} />
              </Routes>
            </div>
          </section>
        </div>
        <ControlledBanner />
      </FeatureSidebarSlotProvider>
    </ConfirmDialogProvider>
  </MemoryRouter>,
);
