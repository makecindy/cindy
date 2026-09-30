import { describe, it, expect, vi } from 'vitest';
import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry';
import { registerSessionTagTools } from '../xdt-helper/session_tags';
import type { TaskTagResult } from '@cindy/maker-shared';
const parse = (r: any) => JSON.parse(r.content[0].text);
describe('task label tools', () => {
  function setup() {
    const registry = new XdtHelperToolRegistry();
    let caller = 'a';
    const execute = vi.fn(async (_caller: string, request: any): Promise<TaskTagResult> => ({
      tags: [],
      sessions: [],
      ...(request.action === 'previewDelete'
        ? { deletion: { tagId: request.tagId, revision: 3, count: 2 } }
        : {}),
    }));
    registerSessionTagTools(registry, {
      getSessionContext: () => ({
        sessionId: caller,
        agentKind: 'codex',
        workingDir: '/tmp/task-tags-test',
      }),
      execute,
    });
    return {
      registry,
      execute,
      setCaller: (v: string) => {
        caller = v;
      },
      call: async (name: string, args: object) => parse(await registry.call(name, args)),
    };
  }
  it('defaults to current task, retains explicit bounded targets and rejects missing context', async () => {
    const h = setup();
    await h.call('add_task_tags', { tag_ids: ['red'] });
    expect(h.execute).toHaveBeenLastCalledWith('a', {
      action: 'attach',
      sessionIds: ['a'],
      tagIds: ['red'],
    });
    await h.call('remove_task_tags', { session_ids: ['b'], tag_ids: ['red'] });
    expect(h.execute).toHaveBeenLastCalledWith('a', {
      action: 'detach',
      sessionIds: ['b'],
      tagIds: ['red'],
    });
    h.setCaller('');
    const r = await h.call('list_task_tags', {});
    expect(r.errorCode).toBe('NO_SESSION_CONTEXT');
  });
  it('passes complete reorder and concurrency preconditions to the owner', async () => {
    const h = setup();
    await h.call('reorder_task_tags', {
      tag_ids: ['blue', 'red'],
      expected_order: ['red', 'blue'],
    });
    expect(h.execute).toHaveBeenLastCalledWith('a', {
      action: 'reorder',
      tagIds: ['blue', 'red'],
      expectedOrder: ['red', 'blue'],
    });
  });
  it("distinguishes an explicit canonical rename from recoloring", async () => {
    const h = setup();
    await h.call("update_task_tag", {
      tag_id: "preset:work",
      revision: 1,
      name: "Work",
    });
    expect(h.execute).toHaveBeenLastCalledWith(
      "a",
      expect.objectContaining({ name: "Work", nameCustomized: true }),
    );
    await h.call("update_task_tag", {
      tag_id: "preset:work",
      revision: 2,
      color: "blue",
    });
    expect(h.execute).toHaveBeenLastCalledWith(
      "a",
      expect.objectContaining({ name: undefined, nameCustomized: undefined }),
    );
  });
  it('requires a signed caller-bound delete preview and passes concurrency preconditions', async () => {
    const h = setup();
    const preview = await h.call('delete_task_tag', { tag_id: 'red' });
    const token = preview.confirmation_token ?? preview.data?.confirmation_token;
    expect(typeof token).toBe('string');
    h.setCaller('b');
    expect(
      (
        await h.call('delete_task_tag', {
          tag_id: 'red',
          confirmation_token: token,
        })
      ).errorCode,
    ).toBe('INVALID_CONFIRMATION');
    h.setCaller('a');
    await h.call('delete_task_tag', {
      tag_id: 'red',
      confirmation_token: token,
    });
    expect(h.execute).toHaveBeenLastCalledWith('a', {
      action: 'delete',
      tagId: 'red',
      revision: 3,
      expectedCount: 2,
    });
    expect(
      (
        await h.call('delete_task_tag', {
          tag_id: 'blue',
          confirmation_token: token,
        })
      ).errorCode,
    ).toBe('INVALID_CONFIRMATION');
  });
});
