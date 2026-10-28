/** Regression: adding a folder must register it without creating a task, cancel is a no-op,
 * and an account change while the native dialog is open must prevent the write.
 * Unit tier: invoke the real picker coordinator with a deferred native dialog, shared project
 * registration is covered separately by createProject's filesystem/owner tests. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  current: true,
  register: vi.fn(),
  capture: vi.fn(),
  context: { assertCurrent: () => {} },
}));
vi.mock('../mcp-integrations/createProject.js', () => ({
  captureLocalProjectContext: () => h.capture(),
  registerLocalProjectDirectory: (...args: unknown[]) => h.register(...args),
}));
import { pickProjectDirectory } from '../projectDirectoryPicker';
beforeEach(() => {
  vi.clearAllMocks();
  h.current = true;
  h.context = {
    assertCurrent: () => {
      if (!h.current) throw new Error('account changed');
    },
  };
  h.capture.mockReturnValue(h.context);
  h.register.mockResolvedValue({ ok: true, workingDir: '/work/project' });
});
describe('native sidebar project picker', () => {
  it('registers a chosen folder exactly once and returns its normalized identity', async () => {
    const dialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/work/project/'] });
    expect(await pickProjectDirectory(dialog, true)).toEqual({
      canceled: false,
      path: '/work/project',
    });
    expect(h.register).toHaveBeenCalledExactlyOnceWith(h.context, '/work/project/');
    expect(dialog).toHaveBeenCalledTimes(1);
  });
  it.each([
    { canceled: true, filePaths: [] },
    { canceled: false, filePaths: [] },
  ])('does not register after cancel/empty result %j', async (result) => {
    expect(await pickProjectDirectory(async () => result, true)).toEqual({ canceled: true });
    expect(h.register).not.toHaveBeenCalled();
  });
  it('leaves ordinary directory pickers read-only', async () => {
    expect(
      await pickProjectDirectory(async () => ({ canceled: false, filePaths: ['/work/project/'] })),
    ).toEqual({ canceled: false, path: '/work/project/' });
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
  });
  it('refuses an account switched during the native dialog', async () => {
    await expect(
      pickProjectDirectory(async () => {
        h.current = false;
        return { canceled: false, filePaths: ['/work/project'] };
      }, true),
    ).rejects.toThrow('account changed');
    expect(h.register).not.toHaveBeenCalled();
  });
  it('reports registration failures instead of claiming the project was added', async () => {
    h.register.mockResolvedValue({ ok: false, message: 'directory unavailable' });
    await expect(
      pickProjectDirectory(async () => ({ canceled: false, filePaths: ['/work/project'] }), true),
    ).rejects.toThrow('directory unavailable');
  });
});
