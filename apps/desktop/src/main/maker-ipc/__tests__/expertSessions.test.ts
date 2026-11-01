import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import {
  ExpertSessionStore,
  PENDING_EXPERT_TTL_MS,
  buildExpertPreamble,
  createRouteMatcher,
  type RouteMatcher,
} from '../expertSessions';
import { registerExpertsHandlers, type ExpertsHandlerHandle } from '../expertsHandlers';
import { IpcHarness } from './helpers/ipcHarness';

let dir: string;
let root: string;
let bindingsFile: string;
let handle: ExpertsHandlerHandle | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-sessions-'));
  root = path.join(dir, 'experts');
  bindingsFile = path.join(dir, 'expert-sessions.json');
  fs.mkdirSync(root);
});
afterEach(() => {
  handle?.dispose();
  handle = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeExpert(slug: string, frontmatter: string, body = 'You review code.'): void {
  fs.mkdirSync(path.join(root, slug), { recursive: true });
  fs.writeFileSync(path.join(root, slug, 'expert.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

const anyRoute: RouteMatcher = () => ({ ok: true });

describe('ExpertSessionStore (ROADMAP 3.2a)', () => {
  it('binds the pending pick to the first fresh session that sends, then clears it', () => {
    writeExpert('code-reviewer', 'name: Code Reviewer\nagent: hermes');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    const events: unknown[] = [];
    store.onChange((e) => events.push(e));
    store.setPending('code-reviewer');

    const preamble = store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'qwen3-8b' }, anyRoute);
    expect(preamble).toContain('[Cindy expert: Code Reviewer]');
    expect(preamble).toContain('You review code.');
    expect(store.getPending()).toBeNull();
    expect(events).toEqual([
      { type: 'pending', slug: 'code-reviewer' },
      { type: 'bound', sessionId: 's1', slug: 'code-reviewer' },
      { type: 'pending', slug: null },
    ]);
    // A second session gets nothing: the pick was spent.
    expect(store.resolveFirstTurnPreamble({ sessionId: 's2', model: 'qwen3-8b' }, anyRoute)).toBeNull();
  });

  it('keeps the binding on disk, so a new store (app restart) still shows and applies it', () => {
    writeExpert('code-reviewer', 'name: Code Reviewer');
    new ExpertSessionStore({ rootDir: root, bindingsFile }).setPending('code-reviewer');
    const first = new ExpertSessionStore({ rootDir: root, bindingsFile });
    expect(first.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute)).toBeNull();

    first.setPending('code-reviewer');
    first.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute);
    const raw = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
    expect(raw.sessions.s1.slug).toBe('code-reviewer');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    const restarted = new ExpertSessionStore({ rootDir: root, bindingsFile });
    expect(restarted.describeBinding('s1')).toMatchObject({ slug: 'code-reviewer', name: 'Code Reviewer' });
    expect(restarted.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute)).toContain('Code Reviewer');
  });

  it('ignores a pick older than the time limit', () => {
    writeExpert('code-reviewer', 'name: Code Reviewer');
    let now = 1_000;
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile, now: () => now });
    store.setPending('code-reviewer');
    now += PENDING_EXPERT_TTL_MS + 1;
    expect(store.getPending()).toBeNull();
    expect(store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'm' }, anyRoute)).toBeNull();
  });

  it('fails closed with what to fix when the bound expert breaks, is not Hermes, or is on another route', () => {
    writeExpert('broken', 'agent: hermes');
    writeExpert('codex-one', 'name: Codex One\nagent: codex');
    writeExpert('routed', 'name: Routed\nmodel: local-backup');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });

    store.setPending('broken');
    expect(() => store.resolveFirstTurnPreamble({ sessionId: 'a', model: 'm' }, anyRoute))
      .toThrow(/Expert "broken" cannot be loaded: frontmatter "name" is required\. Fix .*expert\.md/);
    // The binding stays, so the header shows the broken expert instead of hiding it.
    expect(store.describeBinding('a')).toMatchObject({ slug: 'broken', error: expect.stringContaining('"name"') });

    store.setPending('codex-one');
    expect(() => store.resolveFirstTurnPreamble({ sessionId: 'b', model: 'm' }, anyRoute))
      .toThrow('Only Hermes experts can be started yet');

    store.setPending('routed');
    const wrongRoute: RouteMatcher = (route, model) => ({ ok: false, message: `wants ${route}, has ${model}` });
    expect(() => store.resolveFirstTurnPreamble({ sessionId: 'c', model: 'gemma' }, wrongRoute))
      .toThrow('Expert "Routed": wants local-backup, has gemma');
  });

  it('refuses slugs that are not plain folder names', () => {
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    for (const bad of ['../outside', 'a/b', '.hidden', '', 'a..b']) {
      expect(() => store.setPending(bad)).toThrow('invalid expert');
    }
  });

  it('builds a preamble that names the expert and marks where the owner message starts', () => {
    expect(buildExpertPreamble({ name: 'Code Reviewer', prompt: '  Be careful.\n' })).toBe(
      '[Cindy expert: Code Reviewer]\nFor this whole session, act as the expert described below.\n\nBe careful.\n\n'
      + "[End of expert instructions. The owner's first message follows.]",
    );
  });
});

describe('createRouteMatcher (ROADMAP 3.2a)', () => {
  const routes: Record<string, { model: string; baseUrl: string; providerId?: string }> = {
    'local-backup': { model: 'qwen3-8b', baseUrl: 'http://127.0.0.1:1234/v1', providerId: 'lmstudio-local' },
    'qwen3-8b': { model: 'qwen3-8b', baseUrl: 'http://127.0.0.1:1234/v1', providerId: 'lmstudio-local' },
    'qwen3:8b': { model: 'qwen3:8b', baseUrl: 'http://127.0.0.1:11434/v1', providerId: 'ollama-local' },
  };
  const match = createRouteMatcher((m) => routes[m] ?? null);

  it('accepts the session model that resolves to the route', () => {
    expect(match('local-backup', 'qwen3-8b')).toEqual({ ok: true });
  });

  it('names the model to pick on a mismatch, without switching anything', () => {
    const result = match('local-backup', 'qwen3:8b');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('runs on route "local-backup" (lmstudio-local/qwen3-8b)');
    expect(!result.ok && result.message).toContain('Pick qwen3-8b in the model menu');
    // The Hermes home route never satisfies a routed expert.
    expect(match('local-backup', 'hermes-default').ok).toBe(false);
  });

  it('reports a route missing from routing.yaml', () => {
    const result = match('nope', 'qwen3-8b');
    expect(!result.ok && result.message).toContain('"nope" is not in ~/.cindy-harness/routing.yaml');
  });
});

describe('experts session IPC (ROADMAP 3.2a)', () => {
  it('sets and reads the pending pick, describes bindings, and pushes store events', async () => {
    writeExpert('code-reviewer', 'name: Code Reviewer\nmodel: local-backup');
    const store = new ExpertSessionStore({ rootDir: root, bindingsFile });
    const broadcast = vi.fn();
    const assertTrusted = vi.fn();
    const harness = new IpcHarness();
    handle = registerExpertsHandlers(harness, { rootDir: root, assertTrusted, broadcast, sessions: store });

    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_GET_PENDING)).toBeNull();
    await harness.invoke(MAKER_INVOKE.EXPERTS_SET_PENDING, 'code-reviewer');
    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_GET_PENDING)).toBe('code-reviewer');
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXPERTS_SESSION_EVENT, { type: 'pending', slug: 'code-reviewer' });
    await expect(harness.invoke(MAKER_INVOKE.EXPERTS_SET_PENDING, '../x')).rejects.toThrow('invalid expert slug');

    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_SESSION_BINDING, 's1')).toBeNull();
    store.resolveFirstTurnPreamble({ sessionId: 's1', model: 'qwen3-8b' }, () => ({ ok: true }));
    expect(await harness.invoke(MAKER_INVOKE.EXPERTS_SESSION_BINDING, 's1')).toEqual({
      sessionId: 's1',
      slug: 'code-reviewer',
      dir: path.join(root, 'code-reviewer'),
      name: 'Code Reviewer',
      model: 'local-backup',
    });
    expect(assertTrusted).toHaveBeenCalledTimes(6);

    handle.dispose();
    handle = undefined;
    broadcast.mockClear();
    store.setPending(null);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
