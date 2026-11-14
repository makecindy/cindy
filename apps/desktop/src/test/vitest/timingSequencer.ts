import fs from 'node:fs';
import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { assignByDuration, medianWeight, orderByDuration } from '../../../../../scripts/shared/duration-shards.mjs';

/**
 * CI shards Desktop unit tests by the committed per-file timings
 * (fileTimings.json, refreshed with `pnpm update:desktop-test-timings`).
 * Without `--shard` the default Vitest order is kept, so local runs are unchanged.
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
    private weighted(files: TestSpecification[], timings: Map<string, number>) {
      const fallback = medianWeight(timings.values());
      return files.map((spec) => {
        const file = path.relative(this.ctx.config.root, spec.moduleId).replace(/\\/g, '/');
        return { spec, key: `${spec.project.name}:${file}`, weight: timings.get(file) ?? fallback };
      });
    }

    override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
      const timings = loadTimings();
      const shard = this.ctx.config.shard;
      if (!timings || !shard) return super.shard(files);
      const items = this.weighted(files, timings);
      const selected = new Set(assignByDuration(items, shard.count)[shard.index - 1]);
      return items.filter((item) => selected.has(item.key)).map((item) => item.spec);
    }

    override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
      const timings = loadTimings();
      if (!timings || !this.ctx.config.shard) return super.sort(files);
      const items = this.weighted(files, timings);
      const byKey = new Map(items.map((item) => [item.key, item.spec]));
      return orderByDuration(items).map((key) => byKey.get(key)!);
    }
  };
}
