// @vitest-environment jsdom

/**
 * GhostSummonCard chip 形态(2026-07-29 改版)回归:
 * - 标注行渲染意识名 + 状态文字;不再渲「调用插件 · GHOST」overline,
 *   也不再吞用户 prompt(合并形态已取消,正文由 UserMessage 气泡承载)。
 * - 状态文字对齐兑现事实:running「调用中…」;turn 结束后按
 *   GhostFulfillmentContext 区分「已调用/已完成」,不替 AI 撒谎。
 * - 法阵终态编舞:running→false 时缺口收拢(dasharray → 100 0)+ ✓ 弹出;
 *   历史消息(挂载即非 running)直接静态落终态帧,不播编舞。
 * - 展开抽屉保留透明性:$指令 徽章 + 指令原文双色分段。
 * - 未兑现软提示保持低调胶囊形态不变。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n';
import i18n from '@/i18n';
import { GhostFulfillmentContext, GhostSummonCard } from '@/components/chat/GhostSummonCard';
import { expandCollapsedMessages, stripMessageSources } from '@/lib/shareConversationImage';
import {
  commandDirectiveSegments,
  mentionDirectiveSegments,
  type GhostDirectiveDisplay,
} from '@/cindy-brain/ghostCommand';
import type { HostCapabilityDirectiveDisplay } from '@/cindy-brain/hostCapabilityInvocation';
import type { InstalledGhost } from '../../shared/ghost';
import { collectGhostCallsByUserTurn } from '@/components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';
import { UserMessage } from '@/components/chat/UserMessage';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { Tooltip } from '@/components/ui/tooltip';

const { installedGhostsMock } = vi.hoisted(() => ({
  installedGhostsMock: vi.fn(() => [] as InstalledGhost[]),
}));

vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => installedGhostsMock(),
}));

const commandDirective: GhostDirectiveDisplay = {
  kind: 'command',
  command: 'xd-feishu',
  name: 'XD Feishu',
  ghostId: 'xd-feishu',
  raw: '[插件指令] 用户显式点名插件 XD Feishu(id: xd-feishu)',
};

const mentionDirective: GhostDirectiveDisplay = {
  kind: 'mention',
  ghosts: [{ name: 'XD Feishu', ghostId: 'xd-feishu' }],
  raw: '[插件提示] 消息提及了插件 XD Feishu(id: xd-feishu)',
};

const hostCapabilityDirective: HostCapabilityDirectiveDisplay = {
  kind: 'host-capability',
  capability: 'ios-simulator',
  route: 'cindy_ios_simulator',
  name: 'iOS 模拟器',
  ghostId: 'ios-simulator',
  raw: '[Cindy Host 能力] iOS 模拟器',
};

/** 模拟 prefers-reduced-motion 匹配结果(jsdom 默认无 matchMedia)。 */
function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function fulfillmentOf(clientId: string, ghostIds: string[]) {
  return new Map<string, ReadonlySet<string>>([[clientId, new Set(ghostIds)]]);
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
  installedGhostsMock.mockReturnValue([]);
  vi.useRealTimers();
  // biome-ignore lint/performance/noDelete: 还原 jsdom 默认(无 matchMedia)。
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const ROOT_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOwbvpGEmIY1TCqYfhqAACHB7MQtEO1oAAAAABJRU5ErkJggg==';
const ORG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOYbPyKJMQwqmFUw/DVAABSy7AQ0SGg2gAAAABJRU5ErkJggg==';

describe('GhostSummonCard(chip 形态)', () => {
  // PR #6392 P2 reviews: existing coverage starts with a prebuilt directive and
  // misses persisted directives through UserMessage's pill/chip decision.
  // Unit tier: one user message plus root/org ghost_call messages are parsed and
  // projected by production code; only the installed-list hook is replaced.
  describe('legacy directive fulfillment compatibility', () => {
    const legacyCommand = {
      kind: 'command',
      command: 'draw',
      name: 'Saved Helper',
      ghostId: 'helper',
      raw: '',
    } as const;
    const legacyMention = {
      kind: 'mention',
      ghosts: [{ name: 'Saved Helper', ghostId: 'helper' }],
      raw: '',
    } satisfies GhostDirectiveDisplay;
    const rootCall = { ghost_id: 'helper', namespace: null };
    const orgCall = { ghost_id: 'helper', namespace: 'acme' };
    const mixedMention = {
      kind: 'mention',
      ghosts: [
        { name: 'Saved Helper', ghostId: 'helper' },
        { name: 'Saved Organization', ghostId: '_ns__acme__helper' },
      ],
      raw: '',
    } satisfies GhostDirectiveDisplay;

    it.each<{
      label: string;
      directive: GhostDirectiveDisplay;
      body: string;
      calls: Record<string, unknown>[];
      called: boolean;
      icon: string | null;
      names?: string;
    }>([
      {
        label: 'old unqualified command / explicit root call',
        directive: legacyCommand,
        body: '$draw help',
        calls: [rootCall],
        called: true,
        icon: null,
      },
      {
        label: 'old unqualified command / encoded root call',
        directive: legacyCommand,
        body: '$draw help',
        calls: [{ ghost_id: '_root__helper' }],
        called: true,
        icon: null,
      },
      {
        label: 'old unqualified command / bare call',
        directive: legacyCommand,
        body: '$draw help',
        calls: [{ ghost_id: 'helper' }],
        called: true,
        icon: null,
      },
      {
        label: 'old unqualified command / organization only',
        directive: legacyCommand,
        body: '$draw help',
        calls: [orgCall],
        called: false,
        icon: null,
      },
      {
        label: 'old command with root suffix',
        directive: legacyCommand,
        body: '$draw/@root help',
        calls: [rootCall],
        called: true,
        icon: ROOT_ICON,
      },
      {
        label: 'old command with organization suffix / root only',
        directive: legacyCommand,
        body: '$draw/acme help',
        calls: [rootCall],
        called: false,
        icon: ORG_ICON,
      },
      {
        label: 'old command with organization suffix / organization',
        directive: legacyCommand,
        body: '$draw/acme help',
        calls: [orgCall],
        called: true,
        icon: ORG_ICON,
      },
      {
        label: 'explicit null command',
        directive: { ...legacyCommand, namespace: null },
        body: '$draw help',
        calls: [rootCall],
        called: true,
        icon: ROOT_ICON,
      },
      {
        label: 'explicit organization command / root only',
        directive: { ...legacyCommand, namespace: 'acme' },
        body: '$draw help',
        calls: [rootCall],
        called: false,
        icon: ORG_ICON,
      },
      {
        label: 'explicit organization command / organization',
        directive: { ...legacyCommand, namespace: 'acme' },
        body: '$draw help',
        calls: [orgCall],
        called: true,
        icon: ORG_ICON,
      },
      {
        label: 'old mention / explicit root call',
        directive: legacyMention,
        body: 'help',
        calls: [rootCall],
        called: true,
        icon: null,
      },
      {
        label: 'old mention / encoded root call',
        directive: legacyMention,
        body: 'help',
        calls: [{ ghost_id: '_root__helper' }],
        called: true,
        icon: null,
      },
      {
        label: 'old mention / bare call',
        directive: legacyMention,
        body: 'help',
        calls: [{ ghost_id: 'helper' }],
        called: true,
        icon: null,
      },
      {
        label: 'old mention / organization only',
        directive: legacyMention,
        body: 'help',
        calls: [orgCall],
        called: false,
        icon: null,
      },
      {
        label: 'mixed mentions / organization only',
        directive: mixedMention,
        body: 'help',
        calls: [orgCall],
        called: true,
        icon: ORG_ICON,
        names: 'Saved Organization',
      },
      {
        label: 'mixed mentions / both instances',
        directive: mixedMention,
        body: 'help',
        calls: [rootCall, orgCall],
        called: true,
        icon: null,
        names: 'Saved Helper、Saved Organization',
      },
    ])(
      '$label preserves status separately from installed identity',
      async ({ directive, body, calls, called, icon, names }) => {
        stubMatchMedia(true);
        installedGhostsMock.mockReturnValue([
          {
            manifest: { id: 'helper', name: 'Installed Root', version: '1' },
            dir: '/tmp/_ns/_root/helper',
            instanceKey: '_root__helper',
            namespace: null,
            iconDataUrl: ROOT_ICON,
          },
          {
            manifest: {
              id: 'helper',
              name: 'Installed Organization',
              version: '2',
            },
            dir: '/tmp/_ns/acme/helper',
            instanceKey: '_ns__acme__helper',
            namespace: 'acme',
            iconDataUrl: ORG_ICON,
          },
        ] as InstalledGhost[]);
        const raw = (
          directive.kind === 'command'
            ? commandDirectiveSegments(directive)
            : mentionDirectiveSegments(directive.ghosts)
        )
          .map((segment) => segment.text)
          .join('');
        const content = body + '\n\n' + raw;
        const messages = [
          { clientId: 'm1', role: 'user', content },
          ...calls.map((input, index) => ({
            clientId: 'call-' + index,
            role: 'tool_use',
            toolName: 'mcp__cindy__ghost_call',
            toolInput: { ...input, tool: 'run' },
          })),
        ] as ChatMessage[];
        let container!: HTMLElement;
        await act(async () => {
          const view = render(
            <GhostFulfillmentContext.Provider
              value={collectGhostCallsByUserTurn(messages)}
            >
              <ConfirmDialogProvider>
                <MemoryRouter>
                  <Tooltip.Provider>
                    <UserMessage
                      workingDir="/synthetic/issue-6386"
                      content={content}
                      messageClientId="m1"
                      isLastUserMessage
                      sessionRunning={false}
                    />
                  </Tooltip.Provider>
                </MemoryRouter>
              </ConfirmDialogProvider>
            </GhostFulfillmentContext.Provider>,
          );
          container = view.container;
        });
        if (directive.kind === 'mention' && !called) {
          expect(screen.getByText(/提及插件/)).toBeTruthy();
          expect(screen.queryByText('已调用')).toBeNull();
        } else {
          expect(screen.getByText(called ? '已调用' : '已完成')).toBeTruthy();
          expect(screen.queryByText(called ? '已完成' : '已调用')).toBeNull();
          expect(screen.getByText(names ?? 'Saved Helper')).toBeTruthy();
          expect(screen.queryByText(/提及插件/)).toBeNull();
        }
        expect(
          [...container.querySelectorAll('img')].map((img) =>
            img.getAttribute('src'),
          ),
        ).toEqual(icon ? [icon] : []);
        expect(screen.queryByText('Installed Root')).toBeNull();
        expect(screen.queryByText('Installed Organization')).toBeNull();
      },
    );
  });

  // #6386: existing tests covered org calls and ambiguous bare history, but not
  // explicit root messages through the production projection into this chip.
  // Unit tier: only the installed-list hook is replaced; no runtime/credentials.
  it.each([
    {
      label: 'explicit root',
      input: { ghost_id: 'helper', namespace: null },
      name: 'Root',
      icon: ROOT_ICON,
    },
    { label: 'encoded root', input: { ghost_id: '_root__helper' }, name: 'Root', icon: ROOT_ICON },
    {
      label: 'explicit organization',
      input: { ghost_id: 'helper', namespace: 'acme' },
      name: 'Organization',
      icon: ORG_ICON,
    },
    {
      label: 'legacy unqualified history',
      input: { ghost_id: 'helper' },
      name: 'helper',
      icon: null,
    },
  ])(
    'keeps $label name and icon together while running, settled and reloaded',
    ({ input, name, icon }) => {
      stubMatchMedia(true);
      installedGhostsMock.mockReturnValue([
        {
          manifest: { id: 'helper', name: 'Root', version: '1' },
          dir: '/tmp/_ns/_root/helper',
          instanceKey: '_root__helper',
          namespace: null,
          iconDataUrl: ROOT_ICON,
        },
        {
          manifest: { id: 'helper', name: 'Organization', version: '2' },
          dir: '/tmp/_ns/acme/helper',
          instanceKey: '_ns__acme__helper',
          namespace: 'acme',
          iconDataUrl: ORG_ICON,
        },
      ] as InstalledGhost[]);
      const messages = [
        { clientId: 'm1', role: 'user', content: 'help' },
        {
          clientId: 'call',
          role: 'tool_use',
          toolUseId: 'call-1',
          toolName: 'mcp__cindy__ghost_call',
          toolInput: { ...input, tool: 'run' },
        },
      ] as ChatMessage[];
      const chip = (history: ChatMessage[], running: boolean) => {
        const fulfilled = collectGhostCallsByUserTurn(history);
        return (
          <GhostFulfillmentContext.Provider value={fulfilled}>
            <GhostSummonCard
              directive={{ kind: 'semantic', ghostIds: [...(fulfilled.get('m1') ?? [])] }}
              messageClientId="m1"
              running={running}
            />
          </GhostFulfillmentContext.Provider>
        );
      };
      const assertIdentity = (container: HTMLElement) => {
        expect(screen.getByText(name)).toBeTruthy();
        const images = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
        expect(images).toEqual(icon ? [icon] : []);
        for (const other of ['Root', 'Organization'].filter((value) => value !== name)) {
          expect(screen.queryByText(other)).toBeNull();
        }
      };
      const view = render(chip(messages, true));
      assertIdentity(view.container);
      expect(screen.getByText('调用中…')).toBeTruthy();
      const settled = [
        ...messages,
        {
          clientId: 'result',
          role: 'tool_result',
          toolUseId: 'call-1',
          content: 'ok',
        } as ChatMessage,
      ];
      view.rerender(chip(settled, false));
      assertIdentity(view.container);
      expect(screen.getByText('已调用')).toBeTruthy();
      view.unmount();
      const reloaded = render(chip(JSON.parse(JSON.stringify(settled)) as ChatMessage[], false));
      assertIdentity(reloaded.container);
      expect(screen.getByText('已调用')).toBeTruthy();
    },
  );

  it('does not attach a newly installed root version to an ambiguous historical bare id', () => {
    installedGhostsMock.mockReturnValue([
      { manifest: { id: 'helper', name: 'New Root', version: '99' },
        dir: '/tmp/helper', namespace: null, iconDataUrl: 'data:image/png;base64,AAAA' },
    ] as InstalledGhost[]);
    const { container } = render(
      <GhostSummonCard directive={{ kind: 'semantic', ghostIds: ['helper'] }} />,
    );
    expect(screen.queryByText('v99')).toBeNull();
    expect(container.querySelector('img[src="data:image/png;base64,AAAA"]')).toBeNull();
  });

  it.each([undefined, '@root'])(
    'keeps an explicit root command fulfilled with namespace token %s',
    (commandNamespace) => {
      installedGhostsMock.mockReturnValue([
        {
          manifest: { id: 'helper', name: 'Root', version: '1' },
          dir: '/tmp/_ns/_root/helper',
          instanceKey: '_root__helper',
          namespace: null,
          iconDataUrl: ROOT_ICON,
        },
        {
          manifest: { id: 'helper', name: 'Organization', version: '2' },
          dir: '/tmp/_ns/acme/helper',
          namespace: 'acme',
          iconDataUrl: ORG_ICON,
        },
      ] as InstalledGhost[]);
      const directive = {
        kind: 'command',
        command: 'draw',
        name: 'Root',
        ghostId: 'helper',
        namespace: null,
        raw: '',
      } as const;
      const messages = [
        { clientId: 'm1', role: 'user', content: 'draw' },
        {
          clientId: 'call',
          role: 'tool_use',
          toolName: 'mcp__cindy__ghost_call',
          toolInput: { ghost_id: 'helper', namespace: null, tool: 'run' },
        },
      ] as ChatMessage[];
      const { container } = render(
        <GhostFulfillmentContext.Provider value={collectGhostCallsByUserTurn(messages)}>
          <GhostSummonCard
            directive={directive}
            commandNamespace={commandNamespace}
            messageClientId="m1"
          />
        </GhostFulfillmentContext.Provider>,
      );
      expect(screen.getByText('已调用')).toBeTruthy();
      expect(container.querySelector('img')?.getAttribute('src')).toBe(ROOT_ICON);
      fireEvent.click(screen.getByRole('button', { expanded: false }));
      expect(screen.getByText('v1')).toBeTruthy();
    },
  );

  it('renders an organization semantic call instead of its same-id root neighbor', () => {
    installedGhostsMock.mockReturnValue([
      { manifest: { id: 'helper', name: 'Root', version: '1' }, dir: '/tmp/helper', namespace: null },
      { manifest: { id: 'helper', name: 'Organization', version: '2' }, dir: '/tmp/_ns/acme/helper', namespace: 'acme' },
    ] as InstalledGhost[]);
    const messages = [
      { clientId: 'm1', role: 'user', content: 'help' },
      { clientId: 'call', role: 'tool_use', toolName: 'mcp__cindy__ghost_call', toolInput: { ghost_id: 'helper', namespace: 'acme', tool: 'run' } },
    ] as ChatMessage[];
    const fulfilled = collectGhostCallsByUserTurn(messages);
    render(
      <GhostFulfillmentContext.Provider value={fulfilled}>
        <GhostSummonCard directive={{ kind: 'semantic', ghostIds: [...(fulfilled.get('m1') ?? [])] }} messageClientId='m1' />
      </GhostFulfillmentContext.Provider>,
    );
    expect(screen.getByText('Organization')).toBeTruthy();
    expect(screen.queryByText('Root')).toBeNull();
  });

  it('resolves the logical organization after an in-place namespace stamp', () => {
    installedGhostsMock.mockReturnValue([
      { manifest: { id: 'helper', name: 'Organization', version: '2' }, dir: '/tmp/helper', namespace: 'acme' },
    ] as InstalledGhost[]);
    render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['_ns__acme__helper'])}>
        <GhostSummonCard directive={{ kind: 'semantic', ghostIds: ['_ns__acme__helper'] }} messageClientId='m1' />
      </GhostFulfillmentContext.Provider>,
    );
    expect(screen.getByText('Organization')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('v2')).toBeTruthy();
  });

  it('counts an explicit organization command after its in-place install relocates', () => {
    installedGhostsMock.mockReturnValue([
      { manifest: { id: 'helper', name: 'Root', version: '1' }, dir: '/tmp/helper', namespace: null },
      { manifest: { id: 'helper', name: 'Organization', version: '2' }, dir: '/tmp/_ns/acme/helper', namespace: 'acme' },
    ] as InstalledGhost[]);
    render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['_ns__acme__helper'])}>
        <GhostSummonCard directive={{ kind: 'command', command: 'draw', name: 'Organization', ghostId: 'helper', raw: '' }} commandNamespace='acme' messageClientId='m1' />
      </GhostFulfillmentContext.Provider>,
    );
    expect(screen.getByText('已调用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('v2')).toBeTruthy();
  });

  it('counts a legacy bare call when an in-place organization is the only matching install', () => {
    installedGhostsMock.mockReturnValue([
      { manifest: { id: 'helper', name: 'Organization', version: '2' }, dir: '/tmp/helper', namespace: 'acme' },
    ] as InstalledGhost[]);
    render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['helper'])}>
        <GhostSummonCard directive={{ kind: 'command', command: 'draw', name: 'Organization', ghostId: 'helper', raw: '' }} commandNamespace='acme' messageClientId='m1' />
      </GhostFulfillmentContext.Provider>,
    );
    expect(screen.getByText('已调用')).toBeTruthy();
  });

  it('does not claim a bare call for an organization when root also exists', () => {
    installedGhostsMock.mockReturnValue([
      { manifest: { id: 'helper', name: 'Root', version: '1' }, dir: '/tmp/helper', namespace: null },
      { manifest: { id: 'helper', name: 'Organization', version: '2' }, dir: '/tmp/_ns/acme/helper', namespace: 'acme' },
    ] as InstalledGhost[]);
    render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['helper'])}>
        <GhostSummonCard directive={{ kind: 'command', command: 'draw', name: 'Organization', ghostId: 'helper', raw: '' }} commandNamespace='acme' messageClientId='m1' />
      </GhostFulfillmentContext.Provider>,
    );
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.queryByText('已调用')).toBeNull();
  });

  it('does not mark a root command as called by an organization of the same id', () => {
    installedGhostsMock.mockReturnValue([
      { manifest: { id: 'helper', name: 'Root', version: '1' }, dir: '/tmp/helper', namespace: null },
      { manifest: { id: 'helper', name: 'Organization', version: '2' }, dir: '/tmp/_ns/acme/helper', namespace: 'acme' },
    ] as InstalledGhost[]);
    render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['_ns__acme__helper'])}>
        <GhostSummonCard directive={{ kind: 'command', command: 'draw', name: 'Root', ghostId: 'helper', raw: '' }} messageClientId='m1' />
      </GhostFulfillmentContext.Provider>,
    );
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.queryByText('已调用')).toBeNull();
  });
  it('resolves an explicit root command without attributing an organization call to it', () => {
    installedGhostsMock.mockReturnValue([
      { manifest: { id: 'helper', name: 'Root', version: '1' }, dir: '/tmp/helper', namespace: null },
      { manifest: { id: 'helper', name: 'Organization', version: '2' }, dir: '/tmp/_ns/acme/helper', namespace: 'acme' },
    ] as InstalledGhost[]);
    const directive = { kind: 'command', command: 'draw/@root', name: 'Root', ghostId: 'helper', raw: '' } as const;
    const { rerender } = render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['_ns__acme__helper'])}>
        <GhostSummonCard directive={directive} commandNamespace='@root' messageClientId='m1' />
      </GhostFulfillmentContext.Provider>,
    );
    expect(screen.getByText('已完成')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('v1')).toBeTruthy();
    rerender(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['helper'])}>
        <GhostSummonCard directive={directive} commandNamespace='@root' messageClientId='m1' />
      </GhostFulfillmentContext.Provider>,
    );
    expect(screen.getByText('已调用')).toBeTruthy();
  });
  it('resolves a namespaced $command instance id to the live install version', () => {
    installedGhostsMock.mockReturnValue([
      {
        manifest: {
          schemaVersion: 2,
          id: 'art',
          name: 'Art',
          version: '2.0.0',
          kind: 'chip',
          entry: 'main.js',
          command: 'draw',
          tools: [{ name: 'run', description: 'Run.' }],
        },
        dir: '/tmp/_ns/acme/art',
        namespace: 'acme',
        enabled: true,
        approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
      } as InstalledGhost,
    ]);
    render(
      <GhostSummonCard
        directive={{
          kind: 'command',
          command: 'draw',
          name: 'Art',
          ghostId: '_ns__acme__art',
          raw: '[插件指令] 用户显式点名插件 Art(id: _ns__acme__art)',
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('v2.0.0')).toBeTruthy();
  });

  it('renders the seal chip with plugin name and no overline/prompt slot', () => {
    render(<GhostSummonCard directive={commandDirective} running />);
    expect(screen.getByText('XD Feishu')).toBeTruthy();
    expect(screen.getByText('调用中…')).toBeTruthy();
    expect(screen.queryByText(/GHOST/)).toBeNull();
  });

  it('reports 已调用 only when the turn actually issued a ghost_call', () => {
    const { unmount } = render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" />
      </GhostFulfillmentContext.Provider>,
    );
    expect(screen.getByText('已调用')).toBeTruthy();
    unmount();

    render(<GhostSummonCard directive={commandDirective} messageClientId="m2" />);
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('renders Host capability selection as the same annotation without claiming ghost_call', () => {
    const { container } = render(<GhostSummonCard directive={hostCapabilityDirective} running />);
    expect(screen.getByText('iOS 模拟器')).toBeTruthy();
    expect(screen.getByText('已选择')).toBeTruthy();
    expect(screen.queryByText('调用中…')).toBeNull();
    expect(container.querySelector('.animate-\\[spin_2\\.4s_linear_infinite\\]')).toBeNull();
    expect(container.querySelector('svg.lucide-check')).toBeNull();

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('发送给 Agent 的 Cindy 能力路由')).toBeTruthy();
    expect(screen.getByText('cindy_ios_simulator')).toBeTruthy();
    expect(screen.getByText(/不要通过 ghost_call 调用/)).toBeTruthy();
  });

  it('mounts historic messages directly on the closed static frame', () => {
    const { container } = render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" />
      </GhostFulfillmentContext.Provider>,
    );
    const arcs = container.querySelectorAll('circle.summon-seal-arc');
    expect(arcs.length).toBe(2);
    for (const arc of arcs) {
      expect(arc.getAttribute('stroke-dasharray')).toBe('100 0');
    }
    // 静态终态:✓ 直显(fulfilled)但不挂弹出动画(历史消息零动画)。
    expect(container.querySelector('svg.lucide-check')).toBeTruthy();
    expect(container.querySelector('.summon-seal-tick-pop')).toBeNull();
  });

  it('closes neutrally without tick or halo when the plugin was never actually called', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <GhostSummonCard directive={commandDirective} messageClientId="m2" running />,
    );
    rerender(<GhostSummonCard directive={commandDirective} messageClientId="m2" running={false} />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // 环中性闭合 = turn 结束;不放 ✓/光晕伪造成功,状态文字为「已完成」。
    for (const arc of container.querySelectorAll('circle.summon-seal-arc')) {
      expect(arc.getAttribute('stroke-dasharray')).toBe('100 0');
    }
    expect(container.querySelector('svg.lucide-check')).toBeNull();
    expect(container.querySelector('.summon-seal-halo')).toBeNull();
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('plays the closing choreography when running flips false', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" running />
      </GhostFulfillmentContext.Provider>,
    );
    let arcs = container.querySelectorAll('circle.summon-seal-arc');
    expect(arcs[0]?.getAttribute('stroke-dasharray')).toBe('83 17');
    expect(arcs[1]?.getAttribute('stroke-dasharray')).toBe('39 61');

    rerender(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" running={false} />
      </GhostFulfillmentContext.Provider>,
    );
    // closing:缺口已收拢,旋转仍挂着(满圆前不摘)。
    arcs = container.querySelectorAll('circle.summon-seal-arc');
    for (const arc of arcs) {
      expect(arc.getAttribute('stroke-dasharray')).toBe('100 0');
    }
    expect(container.querySelector('.animate-\\[spin_2\\.4s_linear_infinite\\]')).toBeTruthy();

    // settling:光晕 + ✓ 弹出,旋转已摘除。
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('.summon-seal-halo')).toBeTruthy();
    expect(container.querySelector('.summon-seal-tick-pop')).toBeTruthy();
    expect(container.querySelector('.animate-\\[spin_2\\.4s_linear_infinite\\]')).toBeNull();

    // done:光晕一次性卸载,✓ 常驻。
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(container.querySelector('.summon-seal-halo')).toBeNull();
    expect(container.querySelector('.summon-seal-tick-pop')).toBeTruthy();
  });

  it('skips the choreography under prefers-reduced-motion and lands on the terminal frame', () => {
    stubMatchMedia(true);
    vi.useFakeTimers();
    const { container, rerender } = render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" running />
      </GhostFulfillmentContext.Provider>,
    );
    rerender(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" running={false} />
      </GhostFulfillmentContext.Provider>,
    );
    // 不走 closing/settling 计时:立即闭合 + ✓ 直显 + 无旋转、无光晕。
    const arcs = container.querySelectorAll('circle.summon-seal-arc');
    for (const arc of arcs) {
      expect(arc.getAttribute('stroke-dasharray')).toBe('100 0');
    }
    expect(container.querySelector('.animate-\\[spin_2\\.4s_linear_infinite\\]')).toBeNull();
    expect(container.querySelector('.summon-seal-halo')).toBeNull();
    expect(container.querySelector('svg.lucide-check')).toBeTruthy();
  });

  it('keeps transparency: expanding reveals the $command badge and directive text', () => {
    render(<GhostSummonCard directive={commandDirective} messageClientId="m1" />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    // $指令 徽章 + 指令原文里的注入值,至少各出现一次。
    expect(screen.getAllByText('$xd-feishu').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('追加给模型的指令')).toBeTruthy();
  });

  it('keeps the low-key pill for unfulfilled mentions', () => {
    render(<GhostSummonCard directive={mentionDirective} messageClientId="m1" />);
    expect(screen.getByText(/提及插件/)).toBeTruthy();
    // 胶囊形态没有法阵。
    expect(document.querySelector('circle.summon-seal-arc')).toBeNull();
  });

  it('leaves no empty annotation row or divider in share images', () => {
    const { container } = render(
      <div>
        <GhostSummonCard
          directive={commandDirective}
          messageClientId="m1"
          className="mb-2.5 border-b pb-2.5"
        />
        <GhostSummonCard directive={mentionDirective} messageClientId="m1" />
        <p>正文</p>
      </div>,
    );
    const clone = container.cloneNode(true) as HTMLElement;
    stripMessageSources(clone);
    expandCollapsedMessages(clone);
    expect(clone.textContent).toBe('正文');
    expect(clone.querySelector('.border-b')).toBeNull();
  });
});
