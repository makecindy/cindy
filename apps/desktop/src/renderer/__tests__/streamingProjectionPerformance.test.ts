import { createMessageNavigationProjection } from '@/components/chat/messageNavigationProjection';
import { deriveNavRailEntries } from '@/components/chat/messageNavRailModel';
import { resolveUserDisplayText } from '@/components/chat/userMessageDisplayText';
import { describe, expect, it } from 'vitest';
import {
  buildCachedRenderItems,
  groupWorkRuns,
  collectSessionImageSrcs,
} from '@/components/chat/MessageStream';
import {
  createStreamingMessageProjection,
  createRenderItemMetadataProjection,
  createWorkGroupProjection,
  createStreamingWorkGroupProjection,
} from '@/components/chat/streamingMessageProjection';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { RenderItem } from '@/components/chat/messageWorkGroups';

/** Synthetic history only. Explicit benchmark mode reports timings, never gates CI on wall time. */
function history(turns: number, longText: boolean, session: number): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const id = `${session}-${turn}`;
    const row = (role: ChatMessage['role'], suffix: string, content: string, extra = {}) => {
      rows.push({
        clientId: `${id}-${suffix}`,
        role,
        content,
        createdAt: new Date(1_700_000_000_000 + rows.length * 1000).toISOString(),
        ...extra,
      });
    };
    row('user', 'u', 'Inspect this project');
    row('assistant', 'p', 'Checking the files.');
    row('tool_use', 't', '', {
      toolUseId: `${id}-tool`,
      toolName: 'Read',
      toolInput: { file_path: '/project/src/app.ts' },
    });
    row('tool_result', 'r', 'export const answer = 42;', { toolUseId: `${id}-tool` });
    row(
      'assistant',
      'a',
      longText
        ? '# Findings\n\n' + 'A detailed explanation.\n\n'.repeat(100)
        : 'The inspection is complete.',
      { turnCompleted: true },
    );
  }
  rows.push(
    { clientId: `${session}-live-u`, role: 'user', content: 'Continue' },
    { clientId: `${session}-live-a`, role: 'assistant', content: 'Working', isStreaming: true },
  );
  return rows;
}

const scenarios = [
  { name: 'long-history', turns: 200, views: 1, longText: false, switchEvery: 0 },
  { name: 'long-markdown', turns: 100, views: 1, longText: true, switchEvery: 0 },
  { name: 'eight-tasks', turns: 100, views: 8, longText: false, switchEvery: 0 },
  { name: 'three-views', turns: 200, views: 3, longText: false, switchEvery: 0 },
  { name: 'task-remount', turns: 200, views: 1, longText: false, switchEvery: 10 },
];

describe('streaming projection replay', () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const measured = process.env.CINDY_STREAM_BENCH === '1';
      const frames = measured ? 40 : 3;
      const rounds = measured ? 6 : 2;
      const stats = () => ({
        samples: [] as number[],
        fullBuilds: 0,
        fullGroupBuilds: 0,
        reusedGroups: 0,
        totalGroups: 0,
      });
      const results = { baseline: stats(), firstRound: stats(), secondRound: stats() };
      for (let round = 0; round < rounds; round++) {
        // Rotate all three paths in the same process with identical histories and deltas.
        const order = ['baseline', 'firstRound', 'secondRound'] as const;
        const offset = round % order.length;
        const modes = [...order.slice(offset), ...order.slice(0, offset)];
        for (const mode of modes) {
          const result = results[mode];
          const group = (items: RenderItem[], streaming: boolean) => {
            if (round > 0) result.fullGroupBuilds++;
            return groupWorkRuns(items, streaming);
          };
          const views = Array.from({ length: scenario.views }, (_, view) => ({
            messages: history(scenario.turns, scenario.longText, view),
            project: createStreamingMessageProjection(),
            groups: createWorkGroupProjection(),
            incrementalGroups: createStreamingWorkGroupProjection(group),
            previous: [] as RenderItem[],
            options: { workingDir: '/project', markdownImageTargetCache: new Map() },
          }));
          for (let frame = 0; frame < frames; frame++) {
            for (const view of views) {
              if (scenario.switchEvery && frame > 0 && frame % scenario.switchEvery === 0) {
                view.project = createStreamingMessageProjection();
                view.groups = createWorkGroupProjection();
                view.incrementalGroups = createStreamingWorkGroupProjection(group);
              }
              const tail = view.messages[view.messages.length - 1];
              view.messages = [
                ...view.messages.slice(0, -1),
                { ...tail, content: tail.content + ' next' },
              ];
            }
            const start = performance.now();
            const projections = views.map((view) => {
              const build = () => {
                if (round > 0) result.fullBuilds++;
                return buildCachedRenderItems(view.messages, undefined, undefined, view.options);
              };
              const projected =
                mode !== 'baseline' ? view.project(view.messages, [view.options], build) : build();
              if (mode === 'secondRound') return view.incrementalGroups(projected.items, true);
              const grouped = group(projected.items, true);
              return mode === 'firstRound' ? view.groups(grouped) : grouped;
            });
            if (round > 0) result.samples.push(performance.now() - start);
            // Assertions and identity accounting are deliberately outside the timer.
            projections.forEach((grouped, index) => {
              const view = views[index];
              if (round > 0) {
                const previous = new Set(view.previous);
                for (const item of grouped) {
                  if (item.type !== 'work_group') continue;
                  result.totalGroups++;
                  if (previous.has(item)) result.reusedGroups++;
                }
              }
              expect(
                grouped.some(
                  (item) => item.type === 'message' && item.message === view.messages.at(-1),
                ),
              ).toBe(true);
              view.previous = grouped;
            });
          }
        }
      }
      expect(results.firstRound.fullBuilds).toBeLessThan(results.baseline.fullBuilds);
      expect(results.baseline.reusedGroups).toBe(0);
      expect(results.firstRound.reusedGroups).toBeGreaterThan(0);
      expect(results.secondRound.fullBuilds).toBe(results.firstRound.fullBuilds);
      expect(results.secondRound.fullGroupBuilds).toBeLessThan(results.firstRound.fullGroupBuilds);
      expect(results.secondRound.reusedGroups).toBe(results.firstRound.reusedGroups);
      if (measured)
        for (const [mode, result] of Object.entries(results)) {
          result.samples.sort((a, b) => a - b);
          console.info(
            'STREAM_BENCH',
            JSON.stringify({
              scenario: scenario.name,
              mode,
              p50Ms: result.samples[Math.floor(result.samples.length * 0.5)],
              p95Ms: result.samples[Math.floor(result.samples.length * 0.95)],
              fullBuilds: result.fullBuilds,
              fullGroupBuilds: result.fullGroupBuilds,
              reusedGroups: result.reusedGroups,
              totalGroups: result.totalGroups,
            }),
          );
        }
    });
  }
});

// Same histories/deltas as the core projection replay above. This timer covers
// navigation + gallery + previous-question derivation only, not core projection.
describe('streaming derived-consumer replay', () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const measured = process.env.CINDY_STREAM_BENCH === '1';
      const stats = () => ({
        samples: [] as number[],
        navRows: 0,
        galleryBuilds: 0,
        questionBuilds: 0,
      });
      const results = { secondRound: stats(), thirdRound: stats() };
      for (let round = 0; round < (measured ? 6 : 2); round++) {
        for (const mode of round % 2
          ? (['thirdRound', 'secondRound'] as const)
          : (['secondRound', 'thirdRound'] as const)) {
          const result = results[mode];
          const derive = (messages: readonly ChatMessage[]) => {
            if (round > 0) result.navRows += messages.length;
            return deriveNavRailEntries(messages);
          };
          const newConsumers = () => ({
            nav: createMessageNavigationProjection(derive),
            galleryMetadata: createRenderItemMetadataProjection(),
            windowMetadata: createRenderItemMetadataProjection(),
            previousGallery: undefined as RenderItem[] | undefined,
            previousWindow: undefined as RenderItem[] | undefined,
            gallery: [] as ReturnType<typeof collectSessionImageSrcs>,
          });
          const views = Array.from({ length: scenario.views }, (_, view) => ({
            messages: history(scenario.turns, scenario.longText, view),
            project: createStreamingMessageProjection(),
            groups: createStreamingWorkGroupProjection(),
            consumers: newConsumers(),
            options: { workingDir: '/project', markdownImageTargetCache: new Map() },
            items: [] as RenderItem[],
          }));
          for (let frame = 0; frame < (measured ? 40 : 3); frame++) {
            for (const view of views) {
              if (scenario.switchEvery && frame > 0 && frame % scenario.switchEvery === 0) {
                view.project = createStreamingMessageProjection();
                view.groups = createStreamingWorkGroupProjection();
                view.consumers = newConsumers();
              }
              const tail = view.messages.at(-1)!;
              view.messages = [
                ...view.messages.slice(0, -1),
                { ...tail, content: tail.content + ' next' },
              ];
              view.items = view.groups(
                view.project(view.messages, [view.options], () =>
                  buildCachedRenderItems(view.messages, undefined, undefined, view.options),
                ).items,
                true,
              );
            }
            const start = performance.now();
            const entries = views.map((view) => {
              const consumer = view.consumers;
              const optimized = mode === 'thirdRound';
              const nav = optimized ? consumer.nav(view.messages, true) : derive(view.messages);
              const galleryItems = optimized ? consumer.galleryMetadata(view.items) : view.items;
              if (galleryItems !== consumer.previousGallery) {
                if (round > 0) result.galleryBuilds++;
                consumer.gallery = collectSessionImageSrcs(
                  galleryItems,
                  undefined,
                  undefined,
                  true,
                );
                consumer.previousGallery = galleryItems;
              }
              const window = view.items.slice(-50);
              const visible = optimized ? consumer.windowMetadata(window) : window;
              if (visible !== consumer.previousWindow) {
                if (round > 0) result.questionBuilds++;
                const ids: string[] = [];
                const previews = new Map<string, string>();
                for (const item of visible) {
                  if (
                    item.type !== 'message' ||
                    item.message.role !== 'user' ||
                    item.message.isSyntheticTrigger
                  )
                    continue;
                  ids.push(item.message.clientId);
                  previews.set(item.message.clientId, resolveUserDisplayText(item.message));
                }
                consumer.previousWindow = visible;
              }
              return nav;
            });
            if (round > 0) result.samples.push(performance.now() - start);
            entries.forEach((entry, index) =>
              expect(entry).toEqual(deriveNavRailEntries(views[index].messages)),
            );
          }
        }
      }
      expect(results.thirdRound.navRows).toBeLessThan(results.secondRound.navRows);
      expect(results.thirdRound.galleryBuilds).toBeLessThan(results.secondRound.galleryBuilds);
      expect(results.thirdRound.questionBuilds).toBeLessThan(results.secondRound.questionBuilds);
      if (measured)
        for (const [mode, result] of Object.entries(results)) {
          result.samples.sort((a, b) => a - b);
          console.info(
            'DERIVED_BENCH',
            JSON.stringify({
              scenario: scenario.name,
              mode,
              p50Ms: result.samples[Math.floor(result.samples.length * 0.5)],
              p95Ms: result.samples[Math.floor(result.samples.length * 0.95)],
              navRows: result.navRows,
              galleryBuilds: result.galleryBuilds,
              questionBuilds: result.questionBuilds,
            }),
          );
        }
    });
  }
});
