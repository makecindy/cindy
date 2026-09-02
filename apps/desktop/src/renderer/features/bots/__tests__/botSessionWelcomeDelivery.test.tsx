// @vitest-environment jsdom

/**
 * 入伙第一句话，从 BotSessionView 这一端看。
 *
 * 空头支票复核 2026-08-19:阵容页脚注对**所有**创建路径都承诺「加入后 TA 会先跟你
 * 打个招呼」。`botWelcome.ts` 的纯函数一直是对的,坏在调用点 —— 它把 translate 的
 * 第二个参数(插值)丢了:
 *
 *     translate: (key) => t(key),        // ← params 没了
 *
 * i18next 默认 `skipOnVariables: true`,缺变量时**原样保留**占位符而不是报错,所以
 * 这条 bug 不会抛、不会被 `text === entry.key` 的兜底拦住,而是把
 * 「嗨，我是{{name}}。」直接写进对话当作伙伴说的第一句话。自己捏的伙伴 100% 命中。
 *
 * 这里的 t 假件刻意复刻 i18next 的这个行为,让"漏传 params"必然翻车。
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CATALOG: Record<string, string> = {
  'bots.welcome.generic': '嗨，我是{{name}}。以后有事直接跟我说，我先熟悉一下这儿。',
  'bots.welcome.withRole': '嗨，我是{{name}}——{{description}}。有事直接跟我说。',
};

/**
 * i18next 的插值语义（含 skipOnVariables=true）：给了变量就替换，没给就把
 * `{{var}}` 原样留在句子里。绝不能"聪明地"替换成空串——那样这个用例就废了。
 */
function translate(key: string, params?: Record<string, unknown>): string {
  const template = CATALOG[key];
  if (!template) return key;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = params?.[name];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : whole;
  });
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { botId: 'bot-1', sessionId: 'session-1' } as Record<string, string | undefined>,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
}));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: () => <div data-testid="chat" />,
}));

import { BotSessionView } from '../BotSessionView';
import {
  rememberPendingBotWelcome,
  resetPendingBotWelcomeForTests,
} from '../botWelcome';
import { resetBotReadStateForTests, setBotReadStateOwner } from '../botReadState';

const readyBot = {
  id: 'bot-1',
  name: '小柚',
  status: 'active',
  enabled: true,
  // 打招呼只发生在主任务上——通道路由任务里冒一句自我介绍是插话。
  // 兼容镜像故意写错：canonical 身份必须以 link 投影的 role 为准。
  canonicalSessionId: 'stale-mirror',
  sessions: [{ id: 'session-1', kind: 'chat', role: 'canonical', status: 'active' }],
};

let created: Array<{ sessionId: string; content: string }> = [];

beforeEach(() => {
  created = [];
  window.localStorage.clear();
  resetPendingBotWelcomeForTests();
  resetBotReadStateForTests();
  setBotReadStateOwner('owner-1');
  mocks.params = { botId: 'bot-1', sessionId: 'session-1' };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      localDb: {
        bots: {
          get: vi.fn(async () => readyBot),
          list: vi.fn(async () => [readyBot]),
        },
        messages: {
          // 空任务 —— 打招呼的前提。
          list: vi.fn(async () => []),
          create: vi.fn(async (sessionId: string, body: { content: string }) => {
            created.push({ sessionId, content: body.content });
            return undefined;
          }),
          onCreated: () => () => undefined,
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  resetPendingBotWelcomeForTests();
  resetBotReadStateForTests();
});

describe('入伙第一句话', () => {
  it('把名字真的填进去，而不是把 {{name}} 念出来', async () => {
    rememberPendingBotWelcome('bot-1', {
      key: 'bots.welcome.generic',
      params: { name: '小柚' },
    });

    render(<BotSessionView />);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].content).toBe('嗨，我是小柚。以后有事直接跟我说，我先熟悉一下这儿。');
    // 这一条是本用例的全部意义所在：任何占位符漏到用户眼前都算没打招呼。
    expect(created[0].content).not.toContain('{{');
  });

  it('带角色描述的那句同样要把两个变量都填上', async () => {
    rememberPendingBotWelcome('bot-1', {
      key: 'bots.welcome.withRole',
      params: { name: '小柚', description: '管周报的' },
    });

    render(<BotSessionView />);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].content).toBe('嗨，我是小柚——管周报的。有事直接跟我说。');
    expect(created[0].content).not.toContain('{{');
  });

  it('生成路径给的现成整句照旧原样落地', async () => {
    rememberPendingBotWelcome('bot-1', {
      key: 'bots.welcome.generic',
      text: '我是小柚，周报的事交给我就行。',
    });

    render(<BotSessionView />);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].content).toBe('我是小柚，周报的事交给我就行。');
  });
});
