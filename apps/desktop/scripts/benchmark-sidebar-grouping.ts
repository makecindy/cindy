/** Run: pnpm --filter desktop exec vite-node --config vitest.config.ts scripts/benchmark-sidebar-grouping.ts
 * Pure computation benchmark, not click-to-paint latency. No user data/IPC writes.
 * Expanded sidebar has five variants; with no activity filter two are identical.
 */
import { performance } from 'node:perf_hooks';
import { deepStrictEqual } from 'node:assert';
import type { Session } from '@/lib/ccAgent.types';
import { groupSessions, type GroupSessionsOptions } from '@/features/cc-agent/lib/projectGrouping';
import { createProjectGroupsSelector } from '@/features/cc-agent/lib/projectGroupsSelector';
import { sessionCardVisualCases } from '@/features/cc-agent/sidebar/__fixtures__/sessionCardVisualCases';

const count = 1000;
const iterations = 200;
const rounds = 5;
const seed: Session[] = Array.from({ length: count }, (_, i) => ({
  ...sessionCardVisualCases[0].session,
  id: `benchmark-${i}`,
  title: `Benchmark ${i}`,
  workingDir: `/benchmark/projects/project-${i % 25}`,
  pinnedAt: i % 29 === 0 ? '2026-09-01T00:00:00.000Z' : null,
  userSendAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
}));
const options: GroupSessionsOptions[] = [
  { includePinnedInProjects: false },
  { includePinnedInProjects: false },
  { includePinnedInProjects: true },
  { includePinnedInProjects: true },
  { includePinnedInProjects: true },
];
function run(optimized: boolean, structural: boolean) {
  let sessions = seed;
  const selectors = options.map(() => createProjectGroupsSelector());
  const project = () => {
    if (!optimized) return options.map((option) => groupSessions(sessions, option));
    const all = selectors[0](sessions, options[0]);
    const pinned = selectors[2](sessions, options[2]);
    return [all, all, pinned, pinned, selectors[4](sessions, options[4])];
  };
  project();
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const index = i % count;
    sessions = sessions.slice();
    const updatedAt = new Date(Date.UTC(2026, 8, 15, 0, i)).toISOString();
    sessions[index] = {
      ...sessions[index],
      updatedAt,
      ...(structural ? { userSendAt: updatedAt } : {}),
    };
    const start = performance.now();
    project();
    times.push(performance.now() - start);
  }
  const results = project();
  for (let i = 0; i < options.length; i++)
    deepStrictEqual(results[i], groupSessions(sessions, options[i]));
  return times;
}
const summary = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    samples: sorted.length,
    medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(3),
    p95Ms: +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3),
    totalMs: +sorted.reduce((a, b) => a + b, 0).toFixed(1),
  };
};
// Warm JIT for both algorithms; alternate order across rounds.
run(false, false);
run(true, false);
const result: Record<string, unknown> = {
  count,
  projects: 25,
  iterations,
  rounds,
  node: process.version,
};
for (const structural of [false, true]) {
  const before: number[] = [],
    after: number[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const optimized of round % 2 ? [true, false] : [false, true]) {
      (optimized ? after : before).push(...run(optimized, structural));
    }
  }
  result[structural ? 'sortKeyUpdate' : 'timestampOnlyUpdate'] = {
    before: summary(before),
    after: summary(after),
  };
}
console.log(JSON.stringify(result, null, 2));
