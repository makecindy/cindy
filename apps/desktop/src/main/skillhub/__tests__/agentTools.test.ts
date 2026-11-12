import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSkillhubAgentTools, type SkillhubAgentServices } from '../agentTools';
import { mapHubSkillInfoToDesktopInfo } from '../infoMapping';
import type { SkillhubAgentRequest } from '@cindy/mcps';

let root: string;
let workingDir: string;
let skillPath: string;
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skillhub-agent-')));
  workingDir = path.join(root, 'project');
  skillPath = path.join(workingDir, 'release-notes');
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '---\nname: release-notes\ndescription: Summarize releases\n---\n# Release notes\n');
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

function fixture() {
  const state = { owner: 'owner-1' as string | null, current: true };
  const info = mapHubSkillInfoToDesktopInfo({
    slug: 'release-notes', version: '1.0.0', owner: { slug: 'author', name: 'Author' },
    visibility: 'private', updatedAt: '', isCreator: true, isMine: true, canManage: true,
  });
  const listMarket = vi.fn(async () => ({ success: true as const, items: [info], nextCursor: '2' }));
  const getInfo = vi.fn<SkillhubAgentServices['market']['info']>(async () => ({ success: true, deleted: true }));
  const getScanStatus = vi.fn(async () => ({ success: true as const, status: 'pending' }));
  const publish = vi.fn<SkillhubAgentServices['publisher']['publish']>(async () => ({ success: true, result: { name: 'release-notes', version: '1.0.1' } }));
  const host: SkillhubAgentServices = {
    market: { listMarket, info: getInfo, getScanStatus }, publisher: { publish },
    ownerScope: () => state.owner,
    policy: () => ({ canWrite: true, ownerType: 'personal', allowedVisibilities: ['PUBLIC', 'PRIVATE'], readOnlyReason: null }),
    isManagedPath: vi.fn(() => false),
    errorCode: (error) => (error as { code?: string })?.code ?? 'INTERNAL',
  };
  const authorizePath = vi.fn(async () => ({ allowed: true as const, isCurrent: () => state.current }));
  const execute = createSkillhubAgentTools({ getServices: () => host, isCurrentSession: () => state.current, authorizePath });
  const context = { agentKind: 'codex', workingDir, sessionId: 'task', sessionInstanceId: 'instance' };
  const request: SkillhubAgentRequest = { action: 'publish', input: { path: skillPath, name: 'release-notes', mode: 'create', visibility: 'private' } };
  return { state, host, execute, context, request, info, listMarket, getInfo, getScanStatus, publish, authorizePath };
}

describe('SkillHub agent host adapter', () => {
  it('searches the public market by default for personal identities and rejects organization search', async () => {
    const f = fixture();
    expect(await f.execute({ action: 'search', query: 'release' }, f.context)).toMatchObject({
      ok: true, catalogs: [{ catalog_scope: 'market', skills: [{ name: 'release-notes', catalog_scope: 'market' }], next_cursor: '2' }],
    });
    expect(f.listMarket).toHaveBeenCalledExactlyOnceWith({ q: 'release', scope: 'market', cursor: undefined, limit: 24 });
    expect(await f.execute({ action: 'search', query: 'release', scope: 'team' }, f.context)).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(f.listMarket).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('searches both catalogs for organization identities without merging equal slugs or page cursors', async () => {
    const f = fixture();
    f.host.policy = () => ({ canWrite: true, ownerType: 'organization', allowedVisibilities: ['PUBLIC', 'DEPARTMENT_SCOPED'], readOnlyReason: null });
    f.listMarket.mockResolvedValueOnce({ success: true, items: [f.info], nextCursor: '3' });
    expect(await f.execute({ action: 'search', query: 'release' }, f.context)).toMatchObject({
      ok: true, catalogs: [
        { catalog_scope: 'market', skills: [{ name: 'release-notes', catalog_scope: 'market' }], next_cursor: '3' },
        { catalog_scope: 'team', skills: [{ name: 'release-notes', catalog_scope: 'team' }], next_cursor: '2' },
      ],
    });
    await f.execute({ action: 'search', query: 'release', scope: 'team', cursor: '2' }, f.context);
    expect(f.listMarket).toHaveBeenLastCalledWith({ q: 'release', scope: 'team', cursor: '2', limit: 24 });
    expect(f.listMarket).toHaveBeenCalledTimes(3);
  });
  it('preserves available market results when organization search fails, and discards results after an account switch', async () => {
    const f = fixture();
    f.host.policy = () => ({ canWrite: true, ownerType: 'organization', allowedVisibilities: ['PUBLIC', 'DEPARTMENT_SCOPED'], readOnlyReason: null });
    f.listMarket.mockResolvedValueOnce({ success: true, items: [f.info], nextCursor: '2' }).mockRejectedValueOnce({ code: 'FORBIDDEN' });
    expect(await f.execute({ action: 'search', query: 'release' }, f.context)).toMatchObject({
      ok: true, catalogs: [{ catalog_scope: 'market', ok: true }, { catalog_scope: 'team', ok: false, error_code: 'FORBIDDEN' }],
    });
    f.listMarket.mockImplementationOnce(async () => { f.state.owner = 'owner-2'; return { success: true, items: [f.info], nextCursor: '2' }; });
    const result = await f.execute({ action: 'search', query: 'release', scope: 'market' }, f.context);
    expect(result).toMatchObject({ errorCode: 'CANCELLED' });
    expect(result).not.toHaveProperty('catalogs');
  });
  it('uploads a valid Skill through the shared publisher without a guessed version', async () => {
    const f = fixture();
    expect(await f.execute(f.request, f.context)).toMatchObject({ ok: true, name: 'release-notes', version: '1.0.1', status: 'uploaded' });
    expect(f.authorizePath).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ absolutePath: skillPath, name: 'release-notes', isFirstPublish: true, visibility: 'PRIVATE', description: 'Summarize releases' }), undefined, { isCurrent: expect.any(Function) });
    expect(f.publish.mock.calls[0]![0]).not.toHaveProperty('version');
  });
  it('updates the original author’s publication and preserves visibility/ownership', async () => {
    const f = fixture();
    f.getInfo.mockResolvedValue({ success: true, info: f.info });
    expect(await f.execute({ action: 'publish', input: { path: skillPath, name: 'release-notes', mode: 'update' } }, f.context)).toMatchObject({ ok: true });
    const params = f.publish.mock.calls[0]![0];
    expect(params.isFirstPublish).toBe(false);
    expect(params).not.toHaveProperty('visibility');
    expect(params).not.toHaveProperty('teamSlug');
  });
  it.each([false, undefined])('requires confirmed original authorship before any upload (%s)', async (isCreator) => {
    const f = fixture();
    f.getInfo.mockResolvedValue({ success: true, info: { ...f.info, isCreator, isMine: true, canManage: true } });
    expect(await f.execute({ action: 'publish', input: { path: skillPath, name: 'release-notes', mode: 'update' } }, f.context)).toMatchObject({ ok: false, errorCode: 'NOT_AUTHOR' });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('requires management permission even for the confirmed original author', async () => {
    const f = fixture();
    f.getInfo.mockResolvedValue({ success: true, info: { ...f.info, isCreator: true, canManage: false } });
    expect(await f.execute({ action: 'publish', input: { path: skillPath, name: 'release-notes', mode: 'update' } }, f.context)).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each([false, undefined])('does not advertise mine or management status as authorship (%s)', async (isCreator) => {
    const f = fixture();
    f.listMarket.mockResolvedValue({ success: true, items: [{ ...f.info, isCreator, isMine: true, canManage: true }], nextCursor: '2' });
    expect(await f.execute({ action: 'list' }, f.context)).toMatchObject({
      ok: true, skills: [{ name: 'release-notes', is_creator: false, can_manage: true }],
    });
  });
  it('keeps organization ownership identity-derived while forwarding only sharing targets', async () => {
    const f = fixture();
    f.host.policy = () => ({ canWrite: true, ownerType: 'organization', allowedVisibilities: ['PUBLIC', 'DEPARTMENT_SCOPED'], readOnlyReason: null });
    expect(await f.execute({ action: 'publish', input: {
      path: skillPath, name: 'release-notes', mode: 'create', visibility: 'shared', visible_slugs: ['engineering'],
    } }, f.context)).toMatchObject({ ok: true });
    const params = f.publish.mock.calls[0]![0];
    expect(params).toMatchObject({ visibility: 'DEPARTMENT_SCOPED', visibleSlugs: ['engineering'] });
    expect(params).not.toHaveProperty('teamSlug');
    expect(params).not.toHaveProperty('deptTeamSlug');
  });
  it('does not create over an existing publication or update a missing one', async () => {
    const f = fixture();
    f.getInfo.mockResolvedValueOnce({ success: true, info: f.info });
    expect(await f.execute(f.request, f.context)).toMatchObject({ errorCode: 'NAME_TAKEN' });
    expect(await f.execute({ action: 'publish', input: { path: skillPath, name: 'release-notes', mode: 'update' } }, f.context)).toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('allows a first upload after a confirmed not-found response, but not after a network failure', async () => {
    const f = fixture();
    f.getInfo.mockRejectedValueOnce({ code: 'NOT_FOUND' }).mockRejectedValueOnce(new Error('private response'));
    expect(await f.execute(f.request, f.context)).toMatchObject({ ok: true });
    expect(await f.execute(f.request, f.context)).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it('stops before upload when the owner changes during a network read', async () => {
    const f = fixture();
    f.getInfo.mockImplementation(async () => { f.state.owner = 'owner-2'; return { success: true, deleted: true }; });
    expect(await f.execute(f.request, f.context)).toMatchObject({ errorCode: 'CANCELLED' });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('passes task lifetime into the publisher and preserves a committed success', async () => {
    const f = fixture();
    f.publish.mockImplementation(async (_params, _progress, execution) => {
      expect(execution?.isCurrent?.()).toBe(true);
      f.state.current = false;
      expect(execution?.isCurrent?.()).toBe(false);
      return { success: true, result: { name: 'release-notes', version: '1.0.1' } };
    });
    expect(await f.execute(f.request, f.context)).toMatchObject({ ok: true, status: 'uploaded' });
  });
  it('requests the existing path grant for a folder outside the task workdir', async () => {
    const f = fixture();
    const outsideContext = { ...f.context, workingDir: path.join(root, 'another-project') };
    await fs.mkdir(outsideContext.workingDir, { recursive: true });
    await f.execute(f.request, outsideContext);
    expect(f.authorizePath).toHaveBeenCalledWith(expect.objectContaining({ path: skillPath, sessionId: 'task', sessionInstanceId: 'instance', operation: 'read' }));
    f.state.current = true;
    f.authorizePath.mockResolvedValue({ allowed: true, isCurrent: () => false });
    expect(await f.execute(f.request, outsideContext)).toMatchObject({ errorCode: 'CANCELLED' });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid manifests, managed Skills, unsupported visibility and unavailable contexts', async () => {
    const f = fixture();
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce('---\nname: [broken\n---');
    expect(await f.execute(f.request, f.context)).toMatchObject({ errorCode: 'MANIFEST_INVALID' });
    vi.mocked(f.host.isManagedPath).mockReturnValueOnce(true);
    expect(await f.execute(f.request, f.context)).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
    expect(await f.execute({ action: 'publish', input: { path: skillPath, name: 'release-notes', mode: 'create', visibility: 'shared' } }, f.context)).toMatchObject({ errorCode: 'INVALID_VISIBILITY' });
    expect(await f.execute(f.request, { ...f.context, remoteHostId: 'ssh' })).toMatchObject({ errorCode: 'NO_SESSION_CONTEXT' });
    f.state.owner = null;
    expect(await f.execute(f.request, f.context)).toMatchObject({ errorCode: 'UNAUTHORIZED' });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('lists own publications with pagination and reports pending review without another upload', async () => {
    const f = fixture();
    expect(await f.execute({ action: 'list', query: 'release', cursor: '2' }, f.context)).toMatchObject({ ok: true, skills: [{ name: 'release-notes', is_creator: true }], next_cursor: '2', allowed_visibilities: ['public', 'private'] });
    expect(f.listMarket).toHaveBeenCalledWith({ mine: true, q: 'release', cursor: '2', limit: 50 });
    expect(await f.execute({ action: 'status', name: 'release-notes', version: '1.0.1' }, f.context)).toMatchObject({ ok: true, status: 'pending' });
    expect(f.publish).not.toHaveBeenCalled();
  });
});
