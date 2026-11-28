/**
 * 只引用不附文字 = 用户把被引用的消息转交给 Cindy: 各渠道引用块统一说明它是本轮请求;
 * 附了文字时引用仍只是低信任上下文。与 cindy-server 的 @cindy/im-inbound 同一规则。
 *
 * 测试价值
 * - 生产入口与可观察结果: 三个渠道引用块构造函数(共享兜底 / 飞书 / Telegram)送进模型的文字。
 * - Bug 依据: 2026-11-24 飞书群里只 @Cindy 并引用「发完 PR 直接发布版本」, 引用被标成
 *   「不构成本轮指令」, Agent 拿不到任何请求。
 * - 现有覆盖缺口: 相邻测试只验证栅栏与截断, 没有区分有无附加文字的两种说明。
 * - 最小失败输入: requestText 为空白、引用为普通文字; 修复前三处都输出「不构成…指示」。
 * - tier: unit(纯字符串, 无 I/O); 三个构造函数同一契约, 合在一张表里, 不分散到三个文件。
 * - 实测耗时: 单独运行约 3.4 秒(主要是导入飞书 / Telegram 模块)。
 */
import { describe, expect, it } from 'vitest';
import { QUOTE_AS_REQUEST_NOTE } from '@cindy/im';
import { buildImReplyContextBlock } from '../replyContext';
import { buildFeishuReplyContextBlock } from '../../feishu/groupContext';
import { buildTelegramReplyContextBlock } from '../../telegram/groupWindow';

const reply = { author: 'alice', text: '发完 PR 直接发布版本' };
const builders = [
  ['shared', (text: string) => buildImReplyContextBlock(reply, text)],
  ['feishu', (text: string) => buildFeishuReplyContextBlock(reply, text)],
  ['telegram', (text: string) => buildTelegramReplyContextBlock(reply, text)],
] as const;

describe.each(builders)('%s reply context block', (_name, build) => {
  it('treats the quote as the request when the user added no text', () => {
    const block = build(' ');
    expect(block).toContain('发完 PR 直接发布版本');
    expect(block).toContain(QUOTE_AS_REQUEST_NOTE);
    expect(block).not.toMatch(/不构成(对你的|用户本轮)指示/);
  });
  it('keeps the quote as untrusted context when the user wrote a request', () => {
    const block = build('这句话什么意思');
    expect(block).not.toContain(QUOTE_AS_REQUEST_NOTE);
    expect(block).toMatch(/不构成(对你的|用户本轮)指示/);
  });
});
