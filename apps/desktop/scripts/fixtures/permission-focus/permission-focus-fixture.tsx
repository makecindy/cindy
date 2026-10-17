import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from '../../../src/renderer/i18n/locales/zh-CN/common.json';
import '../../../src/renderer/themes/colors';
import { ThemeService } from '../../../src/renderer/themes/theme-service';
import { cindyLight } from '../../../src/renderer/themes/builtin/cindy-light';
import { cindyDark } from '../../../src/renderer/themes/builtin/cindy-dark';
import {
  SessionItem,
  hasSessionSelectionModifier,
} from '../../../src/renderer/features/cc-agent/sidebar/SessionItem';
import { SessionCard } from '../../../src/renderer/features/cc-agent/sidebar/SessionCard';
import { SessionEntryList } from '../../../src/renderer/features/cc-agent/sidebar/SessionEntryList';
import { CardMasonry } from '../../../src/renderer/features/cc-agent/sidebar/CardMasonry';
import { SyntheticInteraction, type InteractionKind } from './interaction-cards';
import { PermissionPrompt } from '../../../src/renderer/components/new-chat/PermissionPrompt';
import { shouldCardShortcutYield } from '../../../src/renderer/lib/editableKeyboardTarget';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';

const query = new URLSearchParams(location.search);
const dark = query.get('theme') === 'dark';
new ThemeService().applyTheme(dark ? cindyDark : cindyLight);
document.documentElement.classList.toggle('dark', dark);
await i18next
  .use(initReactI18next)
  .init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zh } } });
const noop = () => {};
const sessions = ['A', 'B', 'C', 'D', 'E', 'F'].map(
  (id) =>
    ({
      id,
      title: `演示任务 ${id}`,
      status: 'active',
      agentKind: 'cc',
      source: 'desktop',
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
      workingDir: '/synthetic',
      pinnedAt: '2026-10-15T00:00:00Z',
      preview: '仅合成演示数据，未运行任何工具',
      _count: { messages: 1 },
    }) as unknown as Session,
);
const data = ((window as any).permissionFocus = {
  responses: [],
  events: [],
  active: 'A',
  pending: 'A',
  selections: [],
});
function describe(el: EventTarget | null) {
  if (!(el instanceof HTMLElement)) return null;
  return { tag: el.tagName, role: el.getAttribute('role'), session: el.dataset.sessionId ?? null };
}
window.addEventListener('keydown', (event) => {
  if (!['Enter', 'Escape'].includes(event.key)) return;
  const owner = document.querySelector('[data-permission] > div');
  const kind =
    event.key === 'Escape'
      ? 'dismiss'
      : event.ctrlKey || event.metaKey
        ? 'modifiedActivate'
        : 'activate';
  data.events.push({
    active: data.active,
    request: `request-${data.pending}`,
    key: event.key,
    ctrl: event.ctrlKey,
    target: describe(event.target),
    focus: describe(document.activeElement),
    prevented: event.defaultPrevented,
    yield: shouldCardShortcutYield(event, kind, owner),
  });
});
function Fixture() {
  const [active, setActive] = useState('A');
  const route = useLocation();
  const navigate = useNavigate();
  const fromFiles = query.has('files');
  const routeReady = !fromFiles || route.pathname === `/cc-agent/${active}`;
  data.route = route.pathname;
  const completeNavigation = (id: string) => {
    setActive(id);
    if (fromFiles) navigate(`/cc-agent/${id}`);
  };
  const portal = (children: ReactNode) => fromFiles
    ? createPortal(children, document.getElementById('rail-portal')!) : children;
  const [pending, setPending] = useState(!query.has('empty'));
  const [hover, setHover] = useState(true);
  data.finish = () => completeNavigation(data.next ?? 'B');
  data.arrive = () => setPending(true);
  data.active = active;
  data.pending = active;
  const layout = query.get('layout') ?? 'rows';
  const mountedOrder = query.get('split')?.split(',');
  const cardKinds = { A: query.get('cardA'), B: query.get('cardB') };
  const width = layout === 'three' ? 466 : layout === 'two' ? 340 : 240;
  const row = (session: Session) => {
    const Component = layout === 'rows' ? SessionItem : SessionCard;
    return (
      <Component
        key={session.id}
        session={session}
        isActive={active === session.id}
        isRunning={false}
        hasAttentionNotification={false}
        onClick={(id, modifiers) => {
          data.selections.push({ id, modifiers });
          if (hasSessionSelectionModifier(modifiers)) return;
          if (query.has('defer')) data.next = id;
          else completeNavigation(id);
        }}
        onAction={noop}
        onRename={noop}
        onTogglePin={noop}
      />
    );
  };
  return (
    <>
      <p className="fixture-caption">
        #5936 · {dark ? 'Dark' : 'Light'} · 源码组件浏览器验证 · 合成数据 · 非完整客户端
      </p>
      <div className="fixture-shell">
        {layout === 'rail' && (
          <nav style={{ width: 64 }} onMouseEnter={() => setHover(true)}>
            <span>C</span>
          </nav>
        )}
        {(layout !== 'rail' || hover) && portal(
          <aside
            style={{
              width,
              ...(layout === 'rail' || fromFiles ? { position: 'absolute', left: 64, top: 50, zIndex: 10 } : {}),
            }}
          >
            <p className="fixture-label">置顶</p>
            {fromFiles ? (
              <SessionEntryList
                sessions={sessions}
                activeSessionId={active}
                navigationActiveSessionId={routeReady ? active : null}
                sessionVariant={layout === 'rows' ? 'text' : 'list'}
                runningSessionIds={new Set()}
                attachedSessionIds={new Set()}
                notifications={new Set()}
                scheduleSessionIndex={new Map()}
                onSessionClick={(id) => {
                  if (query.has('defer')) data.next = id;
                  else completeNavigation(id);
                }}
                onAction={noop} onRename={noop} onTogglePin={noop} onScheduleAction={noop}
              />
            ) : layout === 'rows' ? (
              sessions.map(row)
            ) : (
              <CardMasonry
                items={sessions}
                getId={(s) => s.id}
                renderItem={row}
                onReorder={noop}
                reducedMotion
              />
            )}
          </aside>
        )}
        <main>
          <header>演示任务 {active}</header>
          <section className="fixture-chat">
            <p>两个模拟待授权任务：鼠标切换后直接使用快捷键。</p>
            <div data-permission>
              {pending && (mountedOrder ?? [active]).map((id) => cardKinds.A ? (
                <SyntheticInteraction key={id} kind={cardKinds[id as 'A' | 'B'] as InteractionKind}
                  session={id} enabled={id === active}
                  onRespond={(session, request, result) => data.responses.push({ session, request, result })} />
              ) : (
                <PermissionPrompt
                  key={mountedOrder ? id : 'current'}
                  keyboardShortcutsEnabled={id === active}
                  permission={{
                    requestId: `request-${id}`,
                    toolName: 'Bash',
                    input: { command: 'echo synthetic-demo' },
                    description: '仅验证界面响应，不执行命令。',
                    suggestions: [
                      {
                        type: 'addRules',
                        rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }],
                        behavior: 'allow',
                        destination: 'session',
                      },
                    ],
                  }}
                  onRespond={(decision) =>
                    data.responses.push({ session: id, request: `request-${id}`, decision })
                  }
                />
              ))}
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[query.has('files') ? '/cc-agent/files/A' : '/']}>
    <Fixture />
  </MemoryRouter>,
);
