import fs from 'node:fs';
import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { assignByDuration, medianWeight } from '../../../../../scripts/shared/duration-shards.mjs';

/**
 * CI shards Desktop unit tests by the committed per-file timings
 * (fileTimings.json, refreshed with `pnpm update:desktop-test-timings`).
 * Only the split changes; the order inside a shard stays Vitest's default
 * (larger files first). Starting the slowest files first put several heavy
 * module graphs on cold transform caches at once, and an in-test dynamic import
 * then exceeded the 5s Linux test timeout. Without `--shard` nothing changes.
 * If the timings file cannot be read every shard falls back to Vitest's hash
 * split together, because they all read the same checkout.
 */
export function createTimingSequencer(timingsFile: string) {
  let cached: Map<string, number> | null | undefined;
  const loadTimings = () => {
    if (cached !== undefined) return cached;
    try {
      const parsed = JSON.parse(fs.readFileSync(timingsFile, 'utf8')) as { files?: Record<string, number> };
      cached = new Map(Object.entries(parsed.files ?? {}));
    } catch (error) {
      console.warn(`[timing-sequencer] ${timingsFile} unavailable, using Vitest hash shards: ${error instanceof Error ? error.message : String(error)}`);
      cached = null;
    }
    return cached;
  };

  return class TimingSequencer extends BaseSequencer {
    override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
      const timings = loadTimings();
      const shard = this.ctx.config.shard;
      if (!timings || !shard) return super.shard(files);
      const fallback = medianWeight(timings.values());
      const items = files.map((spec) => {
        const file = path.relative(this.ctx.config.root, spec.moduleId).replace(/\\/g, '/');
        return { spec, key: `${spec.project.name}:${file}`, weight: timings.get(file) ?? fallback };
      });
      return assignByDuration(items, shard.count)[shard.index - 1].map((item) => item.spec);
    }
  };
}
