// Guard tier: engineering-conventions section 3.2. Existing cross-file
// credential, permission, protocol, race, and design contracts are isolated
// from runtime unit tests. No new input or assertion is introduced here.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe("performMessageDeletion", () => {


  it('keeps the deleted-session preview on the visible message projection', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/localDb/ipc/messages.ts'), 'utf8');
    const deletionBlock = source.slice(
      source.indexOf('export async function commitMessageDeletion'),
      source.indexOf('export function broadcastMessageDeleted'),
    );

    expect(deletionBlock).toContain('const latest = await latestVisiblePreviewRow(sessionId);');
    expect(deletionBlock).toContain(
      'preview = extractMessagePreview(latest?.content, latest?.role);',
    );
    expect(deletionBlock).not.toContain('persistSessionListPreview(');
    expect(deletionBlock).not.toContain('.where(eq(messages.sessionId, sessionId))');
  });


  /**
   * issue #1282:删除路径一度用「可见 user/assistant 行数」去 patch `_count.messages`,而列表的
   * 权威口径是全部 messages 行数(sessions.ts 的 SESSION_MESSAGE_COUNT_SQL),差几十倍。shallow
   * merge 消费端不会自纠,错值留到下次 reseed。权威口径受删除影响只有 0 或 +1(见
   * commitMessageDeletion 的注释),不值得每次删除多跑一次全表 count,故整个字段不再广播。
   * 这几条静态断言守住「删除不按可见投影数行、不广播 _count」。
   */
  it('never patches _count.messages from the delete path', () => {
    const messagesSource = readFileSync(
      resolve(process.cwd(), 'src/main/localDb/ipc/messages.ts'),
      'utf8',
    );
    const deletionStart = messagesSource.indexOf('export async function commitMessageDeletion');
    const deletionBlock = messagesSource.slice(
      deletionStart,
      messagesSource.indexOf('export function broadcastMessageDeleted'),
    );
    // 返回契约里不得再出现 messageCount——它就是 _count 广播的唯一来源。只看函数签名段,
    // 因为下方注释本身要提这个名字解释原因。(切点找不到时先失败在这里,否则 slice(-1) 会把
    // 整个文件当签名段,报出一个和真实原因无关的断言。)
    const bodyStart = messagesSource.indexOf('const now = Date.now()', deletionStart);
    expect(bodyStart).toBeGreaterThan(deletionStart);
    const signatureBlock = messagesSource.slice(deletionStart, bodyStart);
    expect(signatureBlock).not.toContain('messageCount');
    // 也不得再对可见投影数行。只匹配真实查询写法——注释里提 count 口径是允许的。
    expect(deletionBlock).not.toContain('.select({ messageCount');
    expect(deletionBlock).not.toMatch(/count\(messages\./);

    // 只切 broadcastSessionPatched 的对象字面量本身:整个 onCommitted 块里的注释也提 `_count`
    // (说明为什么不发),连注释一起断言会把自己打挂。
    const registerSource = readFileSync(
      resolve(process.cwd(), 'src/main/maker-ipc/register.ts'),
      'utf8',
    );
    const onCommittedStart = registerSource.indexOf('onCommitted:');
    expect(onCommittedStart).toBeGreaterThan(-1);
    const patchStart = registerSource.indexOf(
      'broadcastSessionPatched(sessionId, {',
      onCommittedStart,
    );
    expect(patchStart).toBeGreaterThan(-1);
    const patchBlock = registerSource.slice(patchStart, registerSource.indexOf('});', patchStart));
    expect(patchBlock).toContain('preview,');
    expect(patchBlock).not.toContain('_count');
  });
});
