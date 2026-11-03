import { vi } from 'vitest';
import type { CompanionMaterializeHost } from '../materialize.js';
import type { CompanionMirrorRow } from '../mirror.js';
import { createCompanionCloudState } from '../state.js';
import type { CompanionApi } from '../types.js';

/** Same shape as chatServer's response error: code as message, plus status/details. */
export function rejection(status: number, code: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(code), { status, details });
}

export function memoryState(initial?: string) {
  const files = new Map<string, string>(initial ? [['state.json', initial]] : []);
  const state = createCompanionCloudState({
    filePath: 'state.json',
    io: { read: path => files.get(path) ?? null, write: (path, contents) => { files.set(path, contents); } },
  });
  return { state, files };
}

export type ApiHandler = (route: string, method: string, data: unknown, actorId?: string) => unknown;

export function fakeApi(handler: ApiHandler) {
  const calls: Array<{ route: string; method: string; data: unknown; actorId?: string }> = [];
  const api = vi.fn(async (route: string, method = 'GET', data?: unknown, actorId?: string) => {
    calls.push({ route, method, data, actorId });
    return handler(route, method, data, actorId);
  }) as unknown as CompanionApi;
  return { api, calls };
}

export function fakeLocal(overrides: Partial<CompanionMaterializeHost> = {}) {
  const memories = new Map<string, string>();
  const skills = new Map<string, string>();
  const disabledSkills = new Set<string>();
  const rows: CompanionMirrorRow[] = [];
  let profile: { status: string; displayName: string; description: string } | null = null;
  const host = {
    readProfile: vi.fn(async () => profile),
    createProfile: vi.fn(async (input: { name: string; description: string }) => { profile = { status: 'active', displayName: input.name, description: input.description }; }),
    updateProfile: vi.fn(async (input: { name: string }) => { profile = { ...profile!, status: 'active', displayName: input.name }; }),
    writeSystemPrompt: vi.fn(async () => undefined),
    readMemory: vi.fn(async (_bot: string, file: string) => memories.get(file) ?? null),
    restoreMemory: vi.fn(async (_bot: string, file: string, raw: string) => { memories.set(file, raw); }),
    removeMemory: vi.fn(async (_bot: string, file: string) => { memories.delete(file); }),
    readSkill: vi.fn(async (_bot: string, slug: string) => skills.get(slug) ?? null),
    saveSkill: vi.fn(async (_bot: string, slug: string, content: string, enabled = true) => {
      skills.set(slug, content); if (enabled) disabledSkills.delete(slug); else disabledSkills.add(slug);
    }),
    removeSkill: vi.fn(async (_bot: string, slug: string) => { skills.delete(slug); }),
    ensureCanonicalSession: vi.fn(async () => 'session-1'),
    localMessageTimes: vi.fn(async (_sid: string, from: number) =>
      rows.filter(row => row.createdAt >= from).map(row => ({ role: row.role, createdAt: row.createdAt, clientId: row.clientId }))),
    insertHistory: vi.fn(async (_sid: string, row: { clientId: string; role: string; text: string; createdAt: number }) => {
      rows.push({ id: `local-${rows.length}`, clientId: row.clientId, role: row.role, content: row.text, agentMeta: null, createdAt: row.createdAt });
    }),
    rebuildContext: vi.fn(async (): Promise<'rebuilt' | 'busy'> => 'rebuilt'),
    latestRows: vi.fn(async (_sid: string, limit: number, options?: { excludeClientIdPrefix?: string }) => [...rows]
      .filter(row => !options?.excludeClientIdPrefix || !row.clientId.startsWith(options.excludeClientIdPrefix))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)),
    ...overrides,
  };
  return { host: host as unknown as CompanionMaterializeHost & typeof host, memories, skills, disabledSkills, rows,
    setProfile: (value: typeof profile) => { profile = value; } };
}

