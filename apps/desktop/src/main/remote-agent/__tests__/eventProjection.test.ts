import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AgentEvent } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectGeneratedFiles } from '../../../renderer/lib/generatedFiles';
import { resolveToolFilePath } from '../../../renderer/lib/localPathResolver';
import { localTaskImagePath } from '../../cindy-media/taskImageMarkdown';
import { collectOutboundAttachments } from '../../hook-control/outbound';
import { mapClaudeHostedEvent } from '../controller/eventMap';
import { createRemoteAgentHandle } from '../controller/proxyHandle';
import type { RemoteAgentRunClient } from '../controller/runClient';
import { RemoteExecutor } from '../executor/executor';
import { ExecutorGate } from '../executor/gate';
import { ExecutorWorkspace } from '../executor/workspace';

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-event-projection-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function setup(virtual: string, callWithId: () => Promise<void> = async () => undefined) {
  const real = path.join(root, '真实 目录');
  fs.mkdirSync(real);
  const workspace = new ExecutorWorkspace({ workingDir: real, aliases: [{ from: virtual, to: real }] });
  workspace.setVirtualRoot(virtual);
  const controller = createRemoteAgentHandle({
    client: { callWithId } as unknown as RemoteAgentRunClient,
    started: { id: 'sdk-1', agentKind: 'claude-code', model: 'm', shadowDir: virtual, virtualWorkspace: true, methods: [], state: {} },
    workspace, mapEvent: mapClaudeHostedEvent, recordApproval: () => {}, newId: () => 'request-id', dispose: async () => {},
  });
  return { real, workspace, controller };
}

async function eventsFrom(controller: ReturnType<typeof setup>['controller'], input: AgentEvent[]) {
  const original = structuredClone(input);
  for (const event of input) controller.onEvent(event);
  controller.onClosed('closed');
  const output: AgentEvent[] = [];
  for await (const event of controller.handle.events()) output.push(event);
  expect(input).toEqual(original);
  return output;
}

// Unit regression: a quota terminal followed by a missing remote run must keep
// the actionable error (and its reset time), rather than replacing it with EXPIRED.
describe('remote terminal error ownership', () => {
  // Unit regression: local in-flight tracking must not turn a rejected send into
  // a restart candidate, or acknowledge an uncertain steer as delivered.
  it('leaves a rejected send idle and does not manufacture a restart continuation', async () => {
    const { controller } = setup('/remote/workspace', async () => { throw new Error('rejected'); });
    await expect(controller.handle.send({ type: 'user', content: 'work' })).rejects.toThrow('rejected');
    expect(controller.isQuiet()).toBe(true);
    controller.onInterrupted();
    expect(await eventsFrom(controller, [])).toEqual([]);
  });

  it('does not acknowledge an in-flight steer when the supplier disappears', async () => {
    let interrupt = false;
    const { controller } = setup('/remote/workspace', async () => {
      if (!interrupt) return;
      controller.onInterrupted();
      throw new Error('steer delivery unknown');
    });
    await controller.handle.send({ type: 'user', content: 'work' });
    interrupt = true;
    await expect(controller.handle.steer!({ type: 'user', content: 'additional instruction' })).rejects.toThrow('delivery unknown');
    const events = await eventsFrom(controller, []);
    expect(events.map(event => event.type)).toEqual(['error', 'done']);
  });

  it.each([true, false])('preserves a terminal error across remote close; paired done=%s', async (done) => {
    const { controller } = setup('/remote/workspace');
    const error: AgentEvent = { type: 'error', source: 'claude-code', data: {
      message: "You've hit your weekly limit · resets 9am (Pacific/Auckland)",
      sdkError: 'rate_limit', usageResetAt: 1792612800000,
    } };
    controller.onEvent(error);
    if (done) controller.onEvent({ type: 'done', source: 'claude-code', data: {} });
    controller.onClosed('missing', '[REMOTE_AGENT_EXPIRED] The task is no longer running on the other computer.');
    const events: AgentEvent[] = [];
    for await (const event of controller.handle.events()) events.push(event);
    expect(events.filter(event => event.type === 'error')).toEqual([error]);
  });

  it('still reports remote loss after a nonterminal warning', async () => {
    const { controller } = setup('/remote/workspace');
    controller.onEvent({ type: 'error', source: 'claude-code', data: { message: 'retrying', isTerminal: false } });
    controller.onClosed('missing', '[REMOTE_AGENT_EXPIRED] missing');
    const events: AgentEvent[] = [];
    for await (const event of controller.handle.events()) events.push(event);
    expect(events.at(-1)?.data).toMatchObject({ reason: 'remote_agent_closed' });
  });

  it('does not carry the previous failure into a newly sent turn', async () => {
    const { controller } = setup('/remote/workspace');
    controller.onEvent({ type: 'error', source: 'claude-code', data: { message: 'weekly limit', sdkError: 'rate_limit' } });
    controller.onEvent({ type: 'done', source: 'claude-code', data: {} });
    await controller.handle.send({ type: 'user', content: 'try again' });
    controller.onClosed('missing', '[REMOTE_AGENT_EXPIRED] missing');
    const events: AgentEvent[] = [];
    for await (const event of controller.handle.events()) events.push(event);
    expect(events.at(-1)?.data).toMatchObject({ reason: 'remote_agent_closed' });
  });
});

function text(event: AgentEvent): string { return (event.data as { text: string }).text; }

/** 正文里还原的路径沿用 Agent 写的分隔符(Markdown 会把 `\.git` 这类反斜杠当转义)；结构化路径字段仍用本机写法。 */
function written(local: string, virtual = '/'): string { return virtual.startsWith('C:') ? local : local.replace(/\\/g, '/'); }

function remoteFileUrl(value: string): string {
  return 'file://' + (/^[A-Za-z]:/.test(value) ? '/' : '') + value.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([/]*[A-Za-z])%3A/, '$1:');
}

describe('remote file references on the task computer', () => {
  it.each(['/Users/agent/workspace', '/home/agent/workspace', 'C:\\Agent\\workspace'])('opens a file generated at %s from its file card, tool result and reply link', async (virtual) => {
    const { real, workspace, controller } = setup(virtual);
    const native = virtual.startsWith('C:') ? path.win32 : path.posix;
    const target = native.join(virtual, '报告 文件.txt');
    const local = path.join(real, '报告 文件.txt');
    const executor = new RemoteExecutor({ workspace, gate: new ExecutorGate(workspace, 'normal'), rgPath: 'unused' });
    try {
      await executor.callTool('Write', { file_path: target, content: 'remote-provider-result' });
      const result = await executor.callTool('Read', { file_path: target });
      expect(result.content).toEqual([{ type: 'text', text: '1\tremote-provider-result' }]);
      const output = await eventsFrom(controller, [
        { type: 'tool_use', source: 'claude-code', data: { toolUseId: 'write-id', toolName: 'mcp__cindy_exec__Write', input: { file_path: target, content: 'remote-provider-result' } } },
        { type: 'tool_result_full', source: 'claude-code', data: { toolUseId: 'write-id', fullText: JSON.stringify({ path: target, url: remoteFileUrl(target) }), isError: false } },
        { type: 'text', source: 'claude-code', data: { text: '[报告](<' + remoteFileUrl(target) + '>)', isFinal: true } },
      ]);
      const tool = output[0].data as { toolName: string; input: { file_path: string } };
      const files = collectGeneratedFiles([{ role: 'tool_use', toolName: tool.toolName, toolInput: tool.input }], real);
      expect(files.map((file) => file.path)).toEqual([local]);
      expect(fs.readFileSync(resolveToolFilePath(files[0].path, real), 'utf8')).toBe('remote-provider-result');
      expect(JSON.parse((output[1].data as { fullText: string }).fullText)).toEqual({ path: local, url: pathToFileURL(local).href });
      const replyUrl = text(output[2]).slice('[报告](<'.length, -2);
      expect(fs.readFileSync(fileURLToPath(replyUrl), 'utf8')).toBe('remote-provider-result');
    } finally {
      await executor.close();
    }
  });

  it.each(['/Users/agent/Library/Application Support/workspace', 'C:\\Agent\\工作 目录'])('restores links and inline paths split across single-character deltas at %s', async (virtual) => {
    const { real, controller } = setup(virtual);
    const native = virtual.startsWith('C:') ? path.win32 : path.posix;
    const target = native.join(virtual, '中文 空格', 'report.md');
    const local = path.join(real, '中文 空格', 'report.md');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, 'generated report');
    const reply = '文件在 ' + '\x60' + target + '\x60' + '，打开[报告](<' + remoteFileUrl(target) + '#L2>)。';
    const output = await eventsFrom(controller, [...reply].map((character) => ({
      type: 'text', source: 'codex', data: { text: character, isFinal: false, agentMessageId: 'message-1' },
    })));
    expect(output.map(text).join('')).toBe('文件在 ' + '\x60' + written(local, virtual) + '\x60' + '，打开[报告](<' + pathToFileURL(local).href + '#L2>)。');
    expect(output.every((event) => (event.data as { isFinal: boolean }).isFinal === false)).toBe(true);
  });

  it.each(['/home/agent/workspace', 'C:\\Agent\\workspace'])('maps inline command paths without rewriting arguments at %s', async (virtual) => {
    const { real, controller } = setup(virtual);
    const native = virtual.startsWith('C:') ? path.win32 : path.posix;
    const remote = native.join(virtual, 'run.sh');
    const second = native.join(virtual, 'src', 'input.txt');
    const output = await eventsFrom(controller, [' --url /api/v1', ' relative/input.txt', ' && cat ' + second].map((suffix) => ({
      type: 'text', source: 'codex', data: { text: '\x60' + remote + suffix + '\x60', isFinal: true },
    })));
    expect(output.map(text)).toEqual([
      '\x60' + written(path.join(real, 'run.sh'), virtual) + ' --url /api/v1\x60',
      '\x60' + written(path.join(real, 'run.sh'), virtual) + ' relative/input.txt\x60',
      '\x60' + written(path.join(real, 'run.sh'), virtual) + ' && cat ' + written(path.join(real, 'src', 'input.txt'), virtual) + '\x60',
    ]);
  });

  it('keeps plain text live, flushes unfinished paths before tools and close, and separates message identities', async () => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const output = await eventsFrom(controller, [
      { type: 'text', source: 'codex', data: { text: '正在生成。', isFinal: false, agentMessageId: 'one' } },
      { type: 'text', source: 'codex', data: { text: virtual + '/first.txt', isFinal: false, agentMessageId: 'one' } },
      { type: 'tool_use', source: 'codex', data: { toolName: 'exec_command', input: { cmd: 'echo done' } } },
      { type: 'text', source: 'codex', data: { text: virtual + '/second.txt', isFinal: false, agentMessageId: 'two' } },
      { type: 'text', source: 'codex', data: { text: '下一条', isFinal: false, agentMessageId: 'three' } },
      { type: 'text', source: 'codex', data: { text: virtual + '/last.txt', isFinal: false, agentMessageId: 'three' } },
    ]);
    expect(output.map((event) => event.type === 'text' ? text(event) : event.type)).toEqual([
      '正在生成。', written(path.join(real, 'first.txt')), 'tool_use', written(path.join(real, 'second.txt')), '下一条', written(path.join(real, 'last.txt')),
    ]);
    expect((output[3].data as { agentMessageId: string }).agentMessageId).toBe('two');
  });

  it('keeps interleaved Claude child deltas in their own path buffers and metadata', async () => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const delta = (parentUuid: string, value: string): AgentEvent => ({
      type: 'text', source: 'claude-code', turnScope: 'turn', agentMeta: { parentUuid }, data: { text: value, isFinal: false },
    });
    const output = await eventsFrom(controller, [
      delta('child-a', 'A: ' + virtual.slice(0, 12)),
      delta('child-b', 'B: ' + virtual + '/second'),
      delta('child-a', virtual.slice(12) + '/first.txt '),
      delta('child-b', '.txt '),
    ]);
    expect(output.filter((event) => event.agentMeta?.parentUuid === 'child-a').map(text).join(''))
      .toBe('A: ' + written(path.join(real, 'first.txt')) + ' ');
    expect(output.filter((event) => event.agentMeta?.parentUuid === 'child-b').map(text).join(''))
      .toBe('B: ' + written(path.join(real, 'second.txt')) + ' ');
    expect(output.every((event) => (event.data as { isFinal: boolean }).isFinal === false)).toBe(true);
  });

  it('keeps sibling paths pending across another child final snapshot and tool boundary', async () => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const child = (parentUuid: string, value: string, isFullText = false): AgentEvent => ({
      type: 'text', source: 'claude-code', agentMeta: { parentUuid, ...(isFullText ? { sdkSessionId: 'vendor-session' } : {}) }, data: { text: value, isFinal: isFullText, isFullText },
    });
    const output = await eventsFrom(controller, [
      child('child-a', virtual.slice(0, 12)),
      child('child-b', virtual + '/second'),
      child('child-b', virtual + '/second.txt', true),
      { type: 'tool_use', source: 'claude-code', agentMeta: { parentUuid: 'child-b' }, data: { toolName: 'Read', input: {} } },
      child('child-a', virtual.slice(12) + '/first.txt '),
    ]);
    expect(output.filter((event) => event.type === 'text' && event.agentMeta?.parentUuid === 'child-a').map(text).join(''))
      .toBe(written(path.join(real, 'first.txt')) + ' ');
    expect(output.filter((event) => event.type === 'text' && event.agentMeta?.parentUuid === 'child-b').map(text))
      .toEqual([written(path.join(real, 'second.txt'))]);
  });

  it.each(['done', 'close'] as const)('flushes every unfinished child path at the %s boundary', async (boundary) => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const input: AgentEvent[] = ['child-a', 'child-b'].map((parentUuid) => ({
      type: 'text', source: 'claude-code', agentMeta: { parentUuid }, data: { text: virtual + '/' + parentUuid + '.txt', isFinal: false },
    }));
    if (boundary === 'done') input.push({ type: 'done', source: 'claude-code', data: {} });
    const output = await eventsFrom(controller, input);
    expect(output.filter((event) => event.type === 'text').map((event) => ({ parentUuid: event.agentMeta?.parentUuid, text: text(event) })))
      .toEqual(['child-a', 'child-b'].map((parentUuid) => ({ parentUuid, text: written(path.join(real, parentUuid + '.txt')) })));
    if (boundary === 'done') expect(output.at(-1)?.type).toBe('done');
  });

  // X 的 @askmycindy 回帖，unit：投影 + 出站收集都走生产入口，用户看到的是视频附件而不是「附件未能发送」。
  // 修复前 localFileUrl 只认 ?path= 形态，`xdt-file:///影子路径` 原样落库，收集器按目录外跳过。
  // 相邻用例只覆盖 file:// 与 ?path=；模型按渠道说明写的正是无 host 形态。Windows 与带裸空格的 Mac
  // 影子目录各是一条独立分支：前者要去掉盘符前的斜杠，后者不能被 URL 分词在空格处截断。
  describe.each([['完整回复', true], ['逐字流式', false]])('%s', (_delivery, final) => it.each([
    ['Windows 影子路径', 'C:\\Agent\\workspace', 'intro.mp4', (target: string) => target.replace(/\\/g, '/')],
    ['编码后的路径', '/Users/a/Application Support/workspace', 'intro (1).mp4', (target: string) => encodeURI(target).replace('(', '%28').replace(')', '%29')],
    ['带裸空格的路径', '/Users/a/Application Support/workspace', 'intro.mp4', (target: string) => target],
  ])('delivers a remote video from the xdt-file link written for channels (%s)', async (_name, virtual, file, spell) => {
    const { real, controller } = setup(virtual);
    const native = virtual.startsWith('C:') ? path.win32 : path.posix;
    fs.writeFileSync(path.join(real, file), 'video bytes');
    const link = '[介绍](xdt-file://' + (virtual.startsWith('C:') ? '/' : '') + spell(native.join(virtual, file)) + ')';
    const reply = '做好了\n\n' + link;
    const output = await eventsFrom(controller, final ? [
      { type: 'text', source: 'codex', data: { text: reply, isFinal: true } },
    ] : [...reply].map((character) => ({
      type: 'text', source: 'codex', data: { text: character, isFinal: false, agentMessageId: 'message-1' },
    })));
    const warn = vi.fn();
    const collected = await collectOutboundAttachments(output.map(text).join(''), [], {
      provider: 'x', allowedFileRoots: [real], resolveImageUrl: () => { throw new Error('unused'); },
      log: { warn },
    });
    expect(warn).not.toHaveBeenCalled();
    expect(collected.skipped).toBe(0);
    expect(collected.text.trim()).toBe('做好了');
    expect(collected.attachments).toEqual([{
      name: file, mimeType: 'video/mp4', dataBase64: Buffer.from('video bytes').toString('base64'),
    }]);
  }));

  // 同一缺陷的图片写法：模型把示例里的 xdt-file 换成 xdt-image 时，渠道导入靠 localTaskImagePath 读本机文件。
  it('restores a hostless xdt-image reference for the channel image importer', async () => {
    const { real, controller } = setup('C:\\Agent\\workspace');
    fs.writeFileSync(path.join(real, 'a.png'), 'image bytes');
    const output = await eventsFrom(controller, [
      { type: 'text', source: 'codex', data: { text: '![图](xdt-image:///C:/Agent/workspace/a.png)', isFinal: true } },
    ]);
    const imagePath = localTaskImagePath(/\((.+)\)/.exec(text(output[0]))![1]);
    // 本机文件路径按宿主语义比较：从 URI 解码出的 Windows 路径可以保留正斜杠。
    expect(imagePath && path.normalize(imagePath)).toBe(path.join(real, 'a.png'));
    expect(fs.readFileSync(imagePath!, 'utf8')).toBe('image bytes');
  });

  it('restores nested file changes and media file URLs while preserving external URLs, media identities and vendor metadata', async () => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const remote = virtual + '/image space.png';
    const xdt = 'xdt-file://local/?path=' + encodeURIComponent(remote);
    const external = 'https://example.com' + virtual + '/file.txt';
    const vendorMetadata = { uuid: virtual + '/vendor-id', parentUuid: 'parent' };
    const input: AgentEvent[] = [
      { type: 'tool_use', source: 'codex', agentMeta: vendorMetadata, data: {
        toolUseId: virtual + '/tool-id', toolName: 'file_change',
        input: { changes: [{ kind: 'add', path: virtual + '/report.txt' }, { kind: 'update', path: virtual + '/old.txt', movePath: virtual + '/new.txt' }] },
      } },
      { type: 'image', source: 'codex', data: { url: xdt, sourcePath: remote, mediaId: 'cindy-media://blobs/opaque.png', external } },
      { type: 'text', source: 'pi', data: { text: '[图片](' + xdt + ') [网址](' + external + ')', isFinal: true, isFullText: true } },
    ];
    const output = await eventsFrom(controller, input);
    expect(output[0].agentMeta).toBe(vendorMetadata);
    expect(output[0].data).toMatchObject({ toolUseId: virtual + '/tool-id', input: { changes: [
      { path: path.join(real, 'report.txt') }, { path: path.join(real, 'old.txt'), movePath: path.join(real, 'new.txt') },
    ] } });
    const image = output[1].data as { url: string; external: string; mediaId: string };
    expect(new URL(image.url).searchParams.get('path')).toBe(path.join(real, 'image space.png'));
    expect(image.external).toBe(external);
    expect(image.mediaId).toBe('cindy-media://blobs/opaque.png');
    expect(text(output[2])).toBe('[图片](' + image.url + ') [网址](' + external + ')');
  });

  it.each(['/home/agent/workspace', 'C:\\Agent\\workspace'])('restores JSON scalar paths and nested path arrays without normalizing quoted prose at %s', async (virtual) => {
    const { real, controller } = setup(virtual);
    const native = virtual.startsWith('C:') ? path.win32 : path.posix;
    const target = native.join(virtual, '目录 空格', 'a.txt');
    const local = path.join(real, '目录 空格', 'a.txt');
    fs.mkdirSync(path.dirname(local));
    fs.writeFileSync(local, 'existing file');
    const prose = 'The docs say "' + native.join(virtual, 'README.md') + ' links to /api/v1"';
    const original = { paths: [target, [target]], nested: { file_paths: [target] }, text: prose, links: [remoteFileUrl(target)] };
    const output = await eventsFrom(controller, [target, [target], original].map((value) => ({
      type: 'tool_result_full', source: 'claude-code', data: { toolUseId: 'result', fullText: JSON.stringify(value) },
    })));
    expect(output.map((event) => JSON.parse((event.data as { fullText: string }).fullText))).toEqual([local, [local], {
      paths: [local, [local]], nested: { file_paths: [local] }, text: 'The docs say "' + written(path.join(real, 'README.md'), virtual) + ' links to /api/v1"', links: [pathToFileURL(local).href],
    }]);
  });

  it.each(['/home/agent/workspace', 'C:\\Agent\\workspace'])('preserves prose in JSON scalar and array tool results at %s', async (virtual) => {
    const { real, controller } = setup(virtual);
    const native = virtual.startsWith('C:') ? path.win32 : path.posix;
    const prose = native.join(virtual, 'README.md') + ' links to /api/v1 and relative/input.txt';
    const expected = written(path.join(real, 'README.md'), virtual) + ' links to /api/v1 and relative/input.txt';
    const output = await eventsFrom(controller, [prose, [prose, [prose]], JSON.stringify([prose])].map((value) => ({
      type: 'tool_result_full', source: 'claude-code', data: { toolUseId: 'result', fullText: JSON.stringify(value) },
    })));
    expect(output.map((event) => JSON.parse((event.data as { fullText: string }).fullText)))
      .toEqual([expected, [expected, [expected]], JSON.stringify([expected])]);
  });

  it('uses updated aliases and leaves permission requests and non-aliased paths unchanged', async () => {
    const virtual = '/Users/agent/workspace';
    const { real, workspace, controller } = setup(virtual);
    const additional = '/Users/agent/additional';
    workspace.setAliases([{ from: virtual, to: real }, { from: additional, to: path.join(root, 'extra') }]);
    const permission = { toolName: 'Read', input: { file_path: virtual + '/report.txt' } };
    const output = await eventsFrom(controller, [
      { type: 'text', source: 'claude-code', data: { text: additional + '/new.txt', isFinal: true } },
      { type: 'interaction_request', source: 'claude-code', data: permission },
      { type: 'tool_use', source: 'claude-code', data: { toolName: 'Read', input: { file_path: '/unmapped/file.txt' } } },
    ]);
    expect(text(output[0])).toBe(written(path.join(root, 'extra', 'new.txt')));
    expect(output[1].data).toEqual(permission);
    expect(output[2].data).toMatchObject({ input: { file_path: '/unmapped/file.txt' } });
  });

  it('keeps an unfinished reply path across a standalone background notice', async () => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const output = await eventsFrom(controller, [
      { type: 'text', source: 'pi', data: { text: '[报告](<file:///Users/agent/work', isFinal: false } },
      { type: 'text', source: 'pi', standaloneText: true, turnScope: 'background', backgroundTurnStartedAt: 1000,
        data: { text: '后台文件：\x60' + virtual + '/background.txt\x60', isFinal: true } },
      { type: 'tool_result', source: 'pi', turnScope: 'background', data: { summary: '后台读取完成' } },
      { type: 'text', source: 'pi', data: { text: 'space/report.txt>)', isFinal: false } },
      { type: 'done', source: 'pi', data: {} },
    ]);
    expect(output.filter((event) => event.type === 'text' && !event.standaloneText).map(text).join(''))
      .toBe('[报告](<' + pathToFileURL(path.join(real, 'report.txt')).href + '>)');
    expect(output.find((event) => event.standaloneText)).toMatchObject({
      turnScope: 'background', backgroundTurnStartedAt: 1000,
      data: { text: '后台文件：\x60' + written(path.join(real, 'background.txt')) + '\x60', isFinal: true },
    });
  });

  it.each(['tool_use', 'tool_result', 'done', 'error', 'compact_boundary', 'status'] as const)('flushes only the matching background stream before %s', async (boundary) => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const foreground: AgentEvent = { type: 'text', source: 'pi', data: { text: virtual.slice(0, 12), isFinal: false } };
    const background: AgentEvent = {
      type: 'text', source: 'pi', turnScope: 'background', backgroundTurnStartedAt: 1000,
      data: { text: virtual + '/background.txt', isFinal: false },
    };
    const output = await eventsFrom(controller, [
      foreground, background,
      { ...background, backgroundTurnStartedAt: 2000, data: { text: virtual.slice(0, 12), isFinal: false } },
      { ...background, type: boundary, data: boundary === 'status' ? { isRunning: false } : {} },
      { ...foreground, data: { text: virtual.slice(12) + '/foreground.txt ', isFinal: false } },
      { ...background, backgroundTurnStartedAt: 2000, data: { text: virtual.slice(12) + '/other.txt ', isFinal: false } },
    ]);
    expect(output.map((event) => event.type === 'text' ? text(event) : event.type)).toEqual([
      written(path.join(real, 'background.txt')), boundary,
      written(path.join(real, 'foreground.txt')) + ' ', written(path.join(real, 'other.txt')) + ' ',
    ]);
    expect(output[0]).toMatchObject({ turnScope: 'background', backgroundTurnStartedAt: 1000 });
    expect(output[3]).toMatchObject({ turnScope: 'background', backgroundTurnStartedAt: 2000 });
  });

  it.each([
    { message: 'retrying', isTerminal: false },
    { message: 'retrying', willRetry: true },
  ])('keeps background paths pending across a recoverable foreground error (%j)', async (errorData) => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const output = await eventsFrom(controller, [
      { type: 'text', source: 'pi', turnScope: 'background', backgroundTurnStartedAt: 1000,
        data: { text: virtual.slice(0, 12), isFinal: false } },
      { type: 'error', source: 'pi', data: errorData },
      { type: 'text', source: 'pi', turnScope: 'background', backgroundTurnStartedAt: 1000,
        data: { text: virtual.slice(12) + '/background.txt ', isFinal: false } },
    ]);
    expect(output.map((event) => event.type === 'text' ? text(event) : event.type)).toEqual([
      'error', written(path.join(real, 'background.txt')) + ' ',
    ]);
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('flushes all pending paths before foreground stopped status for %s without done or close', async (source) => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const pending: AgentEvent[] = [
      { type: 'text', source, data: { text: virtual + '/foreground.txt', isFinal: false } },
      { type: 'text', source, agentMeta: { parentUuid: 'child' }, data: { text: virtual + '/child.txt', isFinal: false } },
      { type: 'text', source, turnScope: 'background', backgroundTurnStartedAt: 1000, data: { text: virtual + '/background.txt', isFinal: false } },
    ];
    const stopped: AgentEvent = { type: 'status', source, data: { status: 'Done', isRunning: false, outputTokens: 7 } };
    const input = [...pending, stopped];
    const original = structuredClone(input);
    try {
      for (const event of input) controller.onEvent(event);
      const output: AgentEvent[] = [];
      for await (const event of controller.handle.events()) {
        output.push(event);
        if (event.type === 'status') break;
      }
      expect(output).toEqual([
        ...pending.map((event) => ({ ...event, data: { ...event.data as object, text: written(path.join(real, path.posix.basename(text(event)))) } })),
        stopped,
      ]);
      expect(input).toEqual(original);
    } finally {
      controller.onClosed('closed');
    }
  });

  it('flushes only the matching child path before stopped status', async () => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const foreground: AgentEvent = { type: 'text', source: 'claude-code', data: { text: virtual.slice(0, 12), isFinal: false } };
    const child = (parentUuid: string, value: string): AgentEvent => ({
      ...foreground, agentMeta: { parentUuid }, data: { text: value, isFinal: false },
    });
    const stopped: AgentEvent = {
      type: 'status', source: 'claude-code', agentMeta: { parentUuid: 'child-a' }, data: { status: 'Done', isRunning: false },
    };
    const output = await eventsFrom(controller, [
      foreground, child('child-a', virtual + '/first.txt'), child('child-b', virtual.slice(0, 12)), stopped,
      { ...foreground, data: { text: virtual.slice(12) + '/foreground.txt ', isFinal: false } },
      child('child-b', virtual.slice(12) + '/second.txt '),
    ]);
    expect(output.map((event) => event.type === 'text' ? text(event) : event.type)).toEqual([
      written(path.join(real, 'first.txt')), 'status', written(path.join(real, 'foreground.txt')) + ' ', written(path.join(real, 'second.txt')) + ' ',
    ]);
    expect(output[0].agentMeta).toEqual({ parentUuid: 'child-a' });
    expect(output[1]).toEqual(stopped);
    expect(output[3].agentMeta).toEqual({ parentUuid: 'child-b' });
  });

  it.each([true, undefined])('keeps an unfinished path pending across status with isRunning=%s', async (isRunning) => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const status: AgentEvent = { type: 'status', source: 'codex', data: { status: 'Done', ...(isRunning === undefined ? {} : { isRunning }) } };
    const output = await eventsFrom(controller, [
      { type: 'text', source: 'codex', data: { text: virtual.slice(0, 12), isFinal: false } },
      status,
      { type: 'text', source: 'codex', data: { text: virtual.slice(12) + '/report.txt ', isFinal: false } },
    ]);
    expect(output.map((event) => event.type === 'text' ? text(event) : event.type)).toEqual(['status', written(path.join(real, 'report.txt')) + ' ']);
    expect(output[0]).toEqual(status);
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('preserves the calibrated final reply and stream flags for %s', async (source) => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const raw = '[报告](<' + remoteFileUrl(virtual + '/report.txt') + '>)';
    const final = { text: raw, isFinal: true, ...(source === 'claude-code' ? {} : { isFullText: true }), agentMessageId: 'message' };
    const output = await eventsFrom(controller, [
      { type: 'text', source, data: { text: raw.slice(0, -2), isFinal: false, agentMessageId: 'message' } },
      { type: 'text', source, data: { text: raw.slice(-2), isFinal: false, agentMessageId: 'message' } },
      { type: 'text', source, data: final },
      { type: 'done', source, data: {} },
    ]);
    const expected = '[报告](<' + pathToFileURL(path.join(real, 'report.txt')).href + '>)';
    expect(output.filter((event) => event.type === 'text' && !(event.data as { isFinal?: boolean }).isFinal).map(text).join('')).toBe(expected);
    expect(output.find((event) => event.type === 'text' && (event.data as { isFinal?: boolean }).isFinal)?.data).toEqual({ ...final, text: expected });
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('finishes a link from the final snapshot when the last %s deltas are missing', async (source) => {
    const virtual = '/Users/agent/workspace';
    const { real, controller } = setup(virtual);
    const remote = virtual + '/中文 空格/report.md';
    const local = path.join(real, '中文 空格', 'report.md');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, 'generated report');
    const raw = '报告在 \x60' + remote + '\x60 [打开](<' + remoteFileUrl(remote) + '>)';
    const output = await eventsFrom(controller, [
      { type: 'text', source, data: { text: '报告在 \x60/Users/ag', isFinal: false, agentMessageId: 'message' } },
      { type: 'text', source, data: { text: raw, isFinal: true, ...(source === 'claude-code' ? {} : { isFullText: true }), agentMessageId: 'message' } },
      { type: 'done', source, data: {} },
    ]);
    const streamed = output.filter((event) => event.type === 'text' && !(event.data as { isFinal?: boolean }).isFinal).map(text).join('');
    const final = output.find((event) => event.type === 'text' && (event.data as { isFinal?: boolean }).isFinal)!;
    expect(text(final)).toBe('报告在 \x60' + written(local) + '\x60 [打开](<' + pathToFileURL(local).href + '>)');
    // Claude 的非 isFullText 终态仅在正文仍是其前缀时才会补齐持久消息。
    expect(text(final).startsWith(streamed)).toBe(true);
    expect(streamed).not.toContain('/Users/ag');
  });
});

// #6412: source-local image paths and Base64 are not workspace path projections.
it('preserves native image bytes and marks source-local paths across the controller boundary', async () => {
  const { controller } = setup('/linux/agent');
  const input: AgentEvent = { type: 'image', source: 'codex', data: {
    kind: 'generation', blockId: 'native', path: '/linux/agent/image.png', data: 'abc/linux/agent/xyz',
  } };
  const [output] = await eventsFrom(controller, [input]);
  expect(output.data).toEqual({ ...(input.data as object), pathOrigin: 'remote-agent' });
});
