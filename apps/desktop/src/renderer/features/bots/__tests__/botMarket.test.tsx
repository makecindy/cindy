// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { BotMarketApi, BotMarketCopy, BotMarketEntry } from '../../../../shared/botMarket';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
const h = vi.hoisted(() => ({ language: 'zh-CN', navigate: vi.fn(), owner: 'market-owner', load: vi.fn(async () => []),
  translate: (key: string) => key, lifecycle: vi.fn(), profiles: [] as Array<{ id: string; name: string }> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: h.translate, i18n: { language: h.language, resolvedLanguage: h.language } }) }));
vi.mock('react-router-dom', async original => ({ ...await original<typeof import('react-router-dom')>(), useNavigate: () => h.navigate }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: h.owner }) }));
vi.mock('../botStore', () => ({ useBotProfiles: () => h.profiles, ensureBotProfilesLoaded: h.load, runBotLifecycleAction: h.lifecycle }));
import { BotMarketDialog } from '../BotMarketDialog';
const enCopy: BotMarketCopy = { name: 'Engineering Delivery Teammate', description: 'Follows delegated code work', bubble: 'Tracks your delivery', welcome: 'Hi, I can follow your delivery. Which project do you want to move forward?',
  capabilities: [{ icon: 'code', label: 'Follow code progress' }, { icon: 'check', label: 'Verify check results' }, { icon: 'folder', label: 'Organize delivery evidence' }],
  skills: [{ name: 'Delivery Check', description: 'Checks whether a delivery can be reviewed.' }],
  knowledge: [{ title: 'Method Reference', summary: 'Delivery evidence should say what changed and why.' }], remembers: ['Test environment URL', 'Walkthrough time'],
  routines: [{ name: 'PR/MR Status Follow-up', summary: 'Follows only the PR/MR you name.', cron: '0 13 * * 1-5' }],
  tools: [{ id: 'cindy-gitlab', purpose: 'See MR checks and reviews' }], itemNames: { 'routine-pr-follow': 'PR/MR Status Follow-up', 'skill-delivery': 'Delivery Check' } };
const entry: BotMarketEntry = { packageId: 'engineer-bot', packageVersion: '0.5.0', packageHash: 'a'.repeat(64),
  name: '工程交付伙伴', description: '跟进代码交付', avatar: 'data:image/jpeg;base64,fixture', bubble: '帮你跟进交付进展',
  welcome: '你好，我能帮你跟进交付。你现在想推进哪个项目？', itemNames: { 'routine-pr-follow': 'PR/MR 状态跟进', 'skill-delivery': '交付检查' },
  capabilities: [{ icon: 'code', label: '跟进代码进展' }, { icon: 'check', label: '核对检查结果' }, { icon: 'folder', label: '整理交付证据' }],
  skills: [{ name: '交付检查', description: '核对交付是否可评审。' }],
  knowledge: [{ title: '方法参考', summary: '交付证据应回答：改了什么、为什么。' }], remembers: ['测试环境地址', '走查时间'],
  routines: [{ name: 'PR/MR 状态跟进', summary: '只跟进用户指定的PR/MR。', cron: '0 13 * * 1-5' }],
  tools: [{ id: 'cindy-gitlab', purpose: '查看 MR 的检查与评审' }], requiredInputs: [],
  locales: {
    en: enCopy,
    'zh-TW': { name: '工程交付夥伴', description: '跟進受託的程式碼工作', bubble: '幫你跟進交付進展', welcome: '你好，我能幫你跟進交付。你現在想推進哪個專案？',
      capabilities: [{ icon: 'code', label: '跟進程式碼進度' }, { icon: 'check', label: '核對檢查結果' }, { icon: 'folder', label: '整理交付證據' }],
      skills: [{ name: '交付檢查', description: '核對交付是否可審查。' }],
      knowledge: [{ title: '方法參考', summary: '交付證據應說明改了什麼、為什麼。' }], remembers: ['測試環境網址'],
      routines: [{ name: 'PR/MR 狀態跟進', summary: '只跟進你指定的 PR/MR。', cron: '0 13 * * 1-5' }],
      tools: [{ id: 'cindy-gitlab', purpose: '查看 MR 的檢查與審查' }], itemNames: { 'routine-pr-follow': 'PR/MR 狀態跟進', 'skill-delivery': '交付檢查' } },
    ja: { ...enCopy, name: '開発デリバリーの仲間', bubble: '納品の進み具合を追います',
      capabilities: [{ icon: 'code', label: 'コードの進み具合を追う' }, { icon: 'check', label: 'チェック結果を確認' }, { icon: 'folder', label: '納品の根拠を整理' }] },
    ko: { ...enCopy, name: '개발 전달 동료', bubble: '전달 진행을 따라갑니다' },
  } };
beforeEach(() => { h.language = 'zh-CN'; h.owner = 'market-owner'; setDataOwnerGeneration(h.owner); h.navigate.mockReset(); h.load.mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const api = (): BotMarketApi => ({ list: vi.fn(async () => [entry]), invite: vi.fn(async () => ({ requestId: 'request', botId: 'import_bot', saved: true, status: 'complete' as const, checks: [] })), status: vi.fn() });
it('lists identity with the action in the header row and opens the designed detail', async () => {
  render(<MemoryRouter><BotMarketDialog api={api()} onClose={() => {}} /></MemoryRouter>);
  expect(await screen.findByText(entry.description)).toBeTruthy();
  expect(screen.getByText('bots.market.heading')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  // The invite action shares the name row, not a separate row under the description.
  const nameRow = screen.getByRole('button', { name: 'bots.market.invite' }).closest('div.flex.items-center.justify-between');
  expect(nameRow?.textContent).toContain(entry.name);
  expect(nameRow?.textContent).not.toContain(entry.description);
  fireEvent.click(screen.getAllByRole('button', { name: entry.name })[0]!);
  const capabilities = await screen.findByRole('list', { name: 'bots.market.capabilities' });
  expect([...capabilities.querySelectorAll('li')].map(item => item.textContent)).toEqual(entry.capabilities.map(item => item.label));
  expect(screen.getByText('bots.market.workTogether')).toBeTruthy();
  // Four vertical modules in a fixed order, each labelled with its count where it has one.
  expect([...document.querySelectorAll('h4')].map(heading => heading.textContent)).toEqual(
    ['bots.market.skills · 1', 'bots.market.knowledge · 1', 'bots.market.tools', 'bots.market.routines · 1']);
  expect(screen.getByText('GitLab')).toBeTruthy();
  expect(screen.getByText('PR/MR 状态跟进')).toBeTruthy();
  // The authored bubble sits in the identity block as a clickable bubble; the welcome itself is not shown.
  expect(screen.getByRole('button', { name: '帮你跟进交付进展' })).toBeTruthy();
  expect(screen.queryByText(entry.welcome)).toBeNull();
  // Detail header: no one-line subtitle (the list keeps it) and no mini avatar in front of the bubble.
  expect(screen.queryByText(entry.description)).toBeNull();
  const bubble = screen.getByRole('button', { name: '帮你跟进交付进展' });
  expect(bubble.querySelector('img')).toBeNull();
  expect(bubble.querySelector('svg[aria-hidden]')).toBeTruthy();
  expect(screen.queryByText('查看原作')).toBeNull();
  expect(screen.queryByText('cindy-gitlab')).toBeNull();
});
it('makes the whole list row open the detail without nesting buttons, while the invite action stays independent', async () => {
  const testApi = api();
  vi.mocked(testApi.invite).mockImplementation(() => new Promise(() => {}));
  render(<MemoryRouter><BotMarketDialog api={testApi} onClose={() => {}} /></MemoryRouter>);
  // One name button per row (no duplicate avatar button) whose overlay stretches over the row.
  const open = await screen.findByRole('button', { name: entry.name });
  expect(screen.getAllByRole('button', { name: entry.name })).toHaveLength(1);
  expect(open.className).toContain('after:absolute');
  expect(open.className).toContain('after:inset-0');
  expect(open.className).toContain('cursor-pointer');
  expect(open.closest('button')).toBe(open);
  const invite = screen.getByRole('button', { name: 'bots.market.invite' });
  expect(invite.closest('div.relative.z-10')).toBeTruthy();
  expect(open.contains(invite)).toBe(false);
  // The invite action does not open the detail; it only invites.
  fireEvent.click(invite);
  expect(testApi.invite).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('bots.market.workTogether')).toBeNull();
  cleanup();
  render(<MemoryRouter><BotMarketDialog api={api()} onClose={() => {}} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: entry.name }));
  expect(await screen.findByText('bots.market.workTogether')).toBeTruthy();
});
it('updates an external Add selection and returns to the list without remounting', async () => {
  const testApi = api();
  const view = render(<MemoryRouter><BotMarketDialog initialPackageId={entry.packageId} api={testApi} onClose={() => {}} /></MemoryRouter>);
  expect(await screen.findByText('bots.market.workTogether')).toBeTruthy();
  view.rerender(<MemoryRouter><BotMarketDialog api={testApi} onClose={() => {}} /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: 'bots.market.invite' })).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByText('bots.market.workTogether')).toBeNull();
  expect(testApi.invite).not.toHaveBeenCalled();
});
it('blocks duplicate clicks, invites only a package identity, and closes into the same saved teammate', async () => {
  const testApi = api(), close = vi.fn();
  let finish!: (value: Awaited<ReturnType<BotMarketApi['invite']>>) => void;
  vi.mocked(testApi.invite).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<MemoryRouter><BotMarketDialog api={testApi} onClose={close} /></MemoryRouter>);
  const invite = await screen.findByRole('button', { name: 'bots.market.invite' });
  fireEvent.click(invite); fireEvent.click(invite);
  expect(testApi.invite).toHaveBeenCalledTimes(1);
  expect(testApi.invite).toHaveBeenCalledWith({ packageId: entry.packageId, packageVersion: '0.5.0', packageHash: entry.packageHash, locale: 'zh-CN' });
  await act(async () => finish({ requestId: 'original-request', botId: 'same-bot', status: 'complete', saved: true, checks: [] }));
  expect(close).toHaveBeenCalledTimes(1); expect(h.navigate).toHaveBeenCalledWith('/bots/same-bot');
});
it('opens an existing package without creating or replaying work', async () => {
  const testApi = api();
  vi.mocked(testApi.list).mockResolvedValue([{ ...entry, installation: { requestId: 'existing', botId: 'installed', saved: true, status: 'complete', checks: [] } }]);
  render(<MemoryRouter><BotMarketDialog api={testApi} onClose={() => {}} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'bots.market.open' }));
  await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/installed'));
  expect(testApi.invite).not.toHaveBeenCalled();
});
it('keeps a saved partial teammate openable and names the item that failed', async () => {
  const testApi = api();
  vi.mocked(testApi.list).mockResolvedValue([{ ...entry, installation: { requestId: 'partial', botId: 'installed', saved: true, status: 'needs-attention',
    checks: [{ entryId: 'routine-pr-follow', status: 'needs-attention' }, { entryId: 'method', status: 'needs-attention', message: 'MEMORY_DISABLED' }] } }]);
  render(<MemoryRouter><BotMarketDialog initialPackageId={entry.packageId} api={testApi} onClose={() => {}} /></MemoryRouter>);
  expect(await screen.findByText('bots.market.memoryDisabled')).toBeTruthy();
  expect(screen.getByText('bots.market.itemFailed.routine')).toBeTruthy();
  expect(screen.getByText('bots.market.partialReady')).toBeTruthy();
  expect(screen.queryByText('bots.market.partialUnsaved')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'bots.market.open' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'bots.market.invite' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.market.retry' }));
  await waitFor(() => expect(testApi.invite).toHaveBeenCalledTimes(1));
});
it('opens the saved teammate from the opening bubble, and invites from it when not joined', async () => {
  const testApi = api();
  vi.mocked(testApi.list).mockResolvedValue([{ ...entry, installation: { requestId: 'existing', botId: 'installed', saved: true, status: 'complete', checks: [] } }]);
  const view = render(<MemoryRouter><BotMarketDialog initialPackageId={entry.packageId} api={testApi} onClose={() => {}} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '帮你跟进交付进展' }));
  await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/installed'));
  expect(testApi.invite).not.toHaveBeenCalled();
  view.unmount();
  const fresh = api();
  render(<MemoryRouter><BotMarketDialog initialPackageId={entry.packageId} api={fresh} onClose={() => {}} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '帮你跟进交付进展' }));
  await waitFor(() => expect(fresh.invite).toHaveBeenCalledTimes(1));
});
it('does not open a teammate whose removal is still in flight', async () => {
  const testApi = api();
  vi.mocked(testApi.list).mockResolvedValue([{ ...entry, installation: { requestId: 'existing', botId: 'installed', saved: true, status: 'complete', checks: [] } }]);
  h.profiles = [{ id: 'installed', name: '工程交付伙伴' }];
  h.lifecycle.mockImplementation(() => new Promise(() => {}));
  render(<MemoryRouter><BotMarketDialog initialPackageId={entry.packageId} api={testApi} onClose={() => {}} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'bots.market.remove' }));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.lifecycle.delete' }));
  await waitFor(() => expect(h.lifecycle).toHaveBeenCalledTimes(1));
  // The modal hides the page behind it from users; a stale click (script, race) must still be inert.
  fireEvent.click(screen.getByRole('button', { name: '帮你跟进交付进展', hidden: true }));
  fireEvent.click(screen.getAllByRole('button', { name: 'bots.market.open', hidden: true })[0]!);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(h.navigate).not.toHaveBeenCalled();
  expect(testApi.invite).not.toHaveBeenCalled();
  h.profiles = [];
});
it('ignores an invitation acknowledgement after the data owner changes', async () => {
  const testApi = api();
  let finish!: (value: Awaited<ReturnType<BotMarketApi['invite']>>) => void;
  vi.mocked(testApi.invite).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<MemoryRouter><BotMarketDialog api={testApi} onClose={() => {}} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'bots.market.invite' }));
  h.owner = 'another-owner'; setDataOwnerGeneration(h.owner);
  view.rerender(<MemoryRouter><BotMarketDialog api={testApi} onClose={() => {}} /></MemoryRouter>);
  await act(async () => finish({ requestId: 'old', botId: 'old-bot', saved: true, status: 'complete', checks: [] }));
  expect(h.navigate).not.toHaveBeenCalled(); expect(h.load).not.toHaveBeenCalled();
});
it('keeps installation observation out of the client after close', async () => {
  const testApi = api();
  let finish!: (value: Awaited<ReturnType<BotMarketApi['invite']>>) => void;
  vi.mocked(testApi.invite).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<MemoryRouter><BotMarketDialog api={testApi} onClose={() => {}} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'bots.market.invite' }));
  view.unmount();
  await act(async () => finish({ requestId: 'retained', botId: 'saved-bot', saved: true, status: 'complete', checks: [] }));
  expect(h.navigate).not.toHaveBeenCalled(); expect(testApi.status).not.toHaveBeenCalled();
});

const detail = async (value: BotMarketEntry = entry) => {
  const testApi = api();
  vi.mocked(testApi.list).mockResolvedValue([value]);
  render(<MemoryRouter><BotMarketDialog initialPackageId={value.packageId} api={testApi} onClose={() => {}} /></MemoryRouter>);
  await screen.findByText('bots.market.workTogether');
  return testApi;
};
it('shows the authored fields in each module and hides modules the package has no data for', async () => {
  await detail();
  // Skill: name and a description clamped to two lines; no step list, no expander.
  const skillCard = screen.getByText('交付检查').closest('li')!;
  expect(skillCard.querySelector('p')!.className).toContain('line-clamp-2');
  expect(document.querySelector('ol')).toBeNull();
  expect(screen.queryByRole('button', { name: /bots\.market\.(expand|collapse)/ })).toBeNull();
  // Knowledge: title plus a three-line summary, then one labelled line of what the companion remembers about the user.
  expect(screen.getByText('交付证据应回答：改了什么、为什么。').className).toContain('line-clamp-3');
  const lead = screen.getByText('bots.market.remembersLead');
  expect(lead.parentElement!.textContent).toBe('bots.market.remembersLead测试环境地址走查时间');
  for (const field of entry.remembers) expect(screen.getByText(field)).toBeTruthy();
  // Tool: name and the authored purpose share one row, no plugin icon or placeholder; the install state sits at its end.
  const toolRow = screen.getByText('GitLab').closest('li')!;
  expect(toolRow.textContent).toContain('查看 MR 的检查与评审');
  expect(screen.getByText('GitLab').parentElement).toBe(screen.getByText('查看 MR 的检查与评审').parentElement);
  expect(toolRow.querySelector('[data-plugin-status]')).toBeTruthy();
  expect(toolRow.querySelector('img, svg')).toBeNull();
  // Routine: title and readable rhythm on one line, no row icon (never the package's example time zone), a one-line summary, off by default.
  const title = screen.getByRole('heading', { level: 5, name: /PR\/MR 状态跟进/ });
  expect(title.textContent).toBe('PR/MR 状态跟进·scheduler.builtinTemplates.schedule.weekdays');
  expect(title.parentElement!.querySelector('svg')).toBeNull();
  expect(screen.queryByText(/UTC|Etc/)).toBeNull();
  expect(screen.getByText('只跟进用户指定的PR/MR。').className).toContain('truncate');
  expect(screen.getByText('bots.market.routineOff')).toBeTruthy();
  // Module titles carry the icon of the entry they correspond to (settings list / sidebar Plugins); tools are plugins, not the skills icon.
  const moduleIcon = (key: string) => screen.getByText(new RegExp(`^bots\\.market\\.${key}`)).querySelector('svg')!.getAttribute('class') ?? '';
  expect(moduleIcon('skills')).toContain('lucide-settings2');
  expect(moduleIcon('knowledge')).toContain('lucide-brain');
  expect(moduleIcon('tools')).toContain('lucide-plug');
  expect(moduleIcon('routines')).toContain('lucide-clock3');
  cleanup();
  // No knowledge, preferences, tools or routines: those modules simply do not appear (no "built-in tools" placeholder).
  await detail({ ...entry, skills: [{ name: '交付检查', description: '说明' }], knowledge: [], remembers: [], routines: [], tools: [] });
  expect([...document.querySelectorAll('h4')].map(heading => heading.textContent)).toEqual(['bots.market.skills · 1']);
});
it('keeps the memory module for remembered preferences alone', async () => {
  await detail({ ...entry, knowledge: [] });
  expect([...document.querySelectorAll('h4')].map(heading => heading.textContent)).toContain('bots.market.knowledge');
  expect(screen.getByText('bots.market.remembersLead')).toBeTruthy();
});
it('moves identity and a compact action into the header once the large avatar scrolls away, sharing one busy state', async () => {
  const observers: Array<{ callback: (changes: Array<{ isIntersecting: boolean }>) => void; target?: Element }> = [];
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (changes: Array<{ isIntersecting: boolean }>) => void) { observers.push({ callback }); }
    observe(target: Element) { observers[observers.length - 1]!.target = target; }
    disconnect() {}
  });
  try {
    const testApi = await detail();
    vi.mocked(testApi.invite).mockImplementation(() => new Promise(() => {}));
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    const sticky = document.querySelector('[data-sticky-identity]')!;
    expect(sticky.getAttribute('aria-hidden')).toBe('true');
    expect(sticky.className).toContain('invisible');
    // The observed element is the large avatar, and only one invite button is reachable while it is on screen.
    expect(observers.at(-1)!.target?.getAttribute('class')).toContain('h-[72px]');
    expect(screen.getAllByRole('button', { name: 'bots.market.invite' })).toHaveLength(1);
    act(() => observers.at(-1)!.callback([{ isIntersecting: false }]));
    expect(sticky.getAttribute('aria-hidden')).toBe('false');
    expect(sticky.className).toContain('opacity-100');
    expect(sticky.textContent).toContain(entry.name);
    const [compact, main] = screen.getAllByRole('button', { name: 'bots.market.invite' });
    fireEvent.click(compact!);
    // One request in flight locks both copies, so neither can start a second one.
    fireEvent.click(main!); fireEvent.click(compact!);
    expect(testApi.invite).toHaveBeenCalledTimes(1);
    expect((main as HTMLButtonElement).disabled && (compact as HTMLButtonElement).disabled).toBe(true);
    act(() => observers.at(-1)!.callback([{ isIntersecting: true }]));
    expect(sticky.getAttribute('aria-hidden')).toBe('true');
  } finally { vi.unstubAllGlobals(); }
});
it('shows placeholders only after 300ms of loading, then the content', async () => {
  vi.useFakeTimers();
  try {
    const testApi = api();
    let finish!: (items: BotMarketEntry[]) => void;
    vi.mocked(testApi.list).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<MemoryRouter><BotMarketDialog api={testApi} onClose={() => {}} /></MemoryRouter>);
    expect(screen.getByRole('status').textContent).toBe('bots.market.loading');
    act(() => { vi.advanceTimersByTime(299); });
    expect(document.querySelector('.animate-fade-in')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(document.querySelector('.animate-fade-in')).toBeTruthy();
    // Static: no shimmer or pulse classes.
    expect(document.querySelector('[class*="animate-pulse"], [class*="shimmer"]')).toBeNull();
    await act(async () => finish([entry]));
    expect(document.querySelector('.animate-fade-in')).toBeNull();
    expect(screen.getByText(entry.description)).toBeTruthy();
  } finally { vi.useRealTimers(); }
});
it('enters the detail with a staggered rise of at most six segments', async () => {
  await detail();
  const indexes = [...document.querySelectorAll<HTMLElement>('.bot-market-rise')].map(node => Number(node.style.getPropertyValue('--rise-index')));
  expect(indexes).toEqual([0, 1, 2, 3, 4, 5]);
});

it('says a routine rhythm in the current language or leaves the line out, never a cron string or English', async () => {
  await detail({ ...entry, routines: [
    { name: '半点检查', summary: '每半小时看一眼。', cron: '0,30 * * * *' },
    { name: '每小时检查', summary: '每小时看一眼。', cron: '0 * * * *' },
    { name: '年度检查', summary: '每年六月看一眼。', cron: '15 3 1 6 *' },
    { name: '周末检查', summary: '周末看一眼。', cron: '0 9 * * 0,6' }] });
  expect(screen.getAllByText('routines.everyMinutes')).toHaveLength(1);
  expect(screen.getAllByText('routines.hourly')).toHaveLength(1);
  // The two shapes the shared formatter would print in English are simply not shown.
  expect(screen.getByText('年度检查')).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/At minute|15 3 1 6|0 9 \* \* 0,6|\bevery\b/i);
});

it('shows the authored short bubble in the UI language', async () => {
  for (const [language, bubble] of [['zh-CN', '帮你跟进交付进展'], ['en', 'Tracks your delivery'], ['zh-TW', '幫你跟進交付進展'], ['ja', '納品の進み具合を追います']] as const) {
    h.language = language;
    await detail();
    expect(screen.getByRole('button', { name: bubble }), language).toBeTruthy();
    cleanup();
  }
});
it('shows the package copy in the UI language', async () => {
  h.language = 'en';
  await detail();
  expect(screen.getByText('Follow code progress')).toBeTruthy();
  expect(screen.getByText('Delivery Check')).toBeTruthy();
  expect(screen.getByText('Method Reference')).toBeTruthy();
  for (const field of entry.locales!.en!.remembers) expect(screen.getByText(field)).toBeTruthy();
  expect(screen.getByText('See MR checks and reviews')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 5, name: /PR\/MR Status Follow-up/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Tracks your delivery' })).toBeTruthy();
  expect(screen.queryByText('交付检查')).toBeNull();
  cleanup();
  h.language = 'zh-TW';
  await detail();
  expect(screen.getByText('核對檢查結果')).toBeTruthy();
  expect(screen.getByText('PR/MR 狀態跟進', { exact: false })).toBeTruthy();
  cleanup();
  h.language = 'ja';
  await detail();
  expect(screen.getByText('コードの進み具合を追う')).toBeTruthy();
  expect(screen.queryByText('跟进代码进展')).toBeNull();
});
it('lists the localized name and one-line description, and names a failed item in the UI language', async () => {
  h.language = 'en';
  const testApi = api();
  vi.mocked(testApi.list).mockResolvedValue([{ ...entry, installation: { requestId: 'r', botId: 'b', saved: true, status: 'needs-attention' as const,
    checks: [{ entryId: 'routine-pr-follow', status: 'needs-attention' as const }] } as never }]);
  render(<MemoryRouter><BotMarketDialog initialPackageId="engineer-bot" api={testApi} onClose={() => {}} /></MemoryRouter>);
  await screen.findByText('bots.market.workTogether');
  // Chinese name never reaches the English UI; the failure notice interpolates the English routine name.
  expect(document.body.textContent).not.toContain('工程交付伙伴');
  expect(screen.getByRole('status', { name: '' }).textContent).toContain('bots.market.itemFailed.routine');
});
it('keeps the tool state labels in one grid cell so a longer language never changes the row', async () => {
  await detail();
  const status = document.querySelector('[data-plugin-status]')!;
  expect(status.className).toContain('inline-grid');
  expect(status.className).toContain('whitespace-nowrap');
  expect(status.className).not.toContain('w-16');
  const labels = [...status.children];
  expect(labels.map(label => label.textContent)).toEqual(['bots.market.pluginInstalled', 'bots.market.pluginNotInstalled']);
  // Without a projection neither label is shown (and neither is announced).
  expect(labels.every(label => label.getAttribute('aria-hidden') === 'true' && label.className.includes('opacity-0'))).toBe(true);
  expect(labels.every(label => label.className.includes('col-start-1') && label.className.includes('row-start-1'))).toBe(true);
});
const partial = { requestId: 'partial', botId: 'partial-bot', saved: true, status: 'needs-attention' as const, checks: [{ entryId: 'routine-pr-follow', status: 'needs-attention' as const }] };
it('opens the detail when an invitation from the list saves only part of the teammate, so the failed item and retry are visible', async () => {
  const testApi = api();
  vi.mocked(testApi.invite).mockResolvedValue(partial);
  render(<MemoryRouter><BotMarketDialog api={testApi} onClose={() => {}} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'bots.market.invite' }));
  expect(await screen.findByText('bots.market.partialReady')).toBeTruthy();
  expect(screen.getByText('bots.market.itemFailed.routine')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'bots.market.retry' })).toBeTruthy();
});
it('never shows or retries another teammate\'s partial result after the user moves to a different detail', async () => {
  const testApi = api();
  vi.mocked(testApi.list).mockResolvedValue([entry, { ...entry, packageId: 'other-bot', name: '另一个伙伴' }]);
  let finish!: (value: typeof partial) => void;
  vi.mocked(testApi.invite).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<MemoryRouter><BotMarketDialog api={testApi} onClose={() => {}} /></MemoryRouter>);
  fireEvent.click((await screen.findAllByRole('button', { name: 'bots.market.invite' }))[0]!);
  fireEvent.click(await screen.findByRole('button', { name: '另一个伙伴' }));
  await act(async () => finish(partial));
  expect(screen.getAllByRole('heading', { name: '另一个伙伴' }).length).toBeGreaterThan(0);
  expect(screen.queryByText('bots.market.partialReady')).toBeNull();
  expect(screen.queryByRole('button', { name: 'bots.market.retry' })).toBeNull();
});
