import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestModule, Vitest } from 'vitest/node';

/**
 * CI-only reporter: records how long every test file took so unit shards can
 * later be balanced by measured cost instead of Vitest's path hash. It is wired
 * only when XDT_VITEST_FILE_TIMINGS names the output file (see vitest.config.ts);
 * a write failure is reported as a warning and never changes the test result.
 */
export const FILE_TIMINGS_ENV = 'XDT_VITEST_FILE_TIMINGS';

interface FileTiming {
  totalMs: number;
  environmentMs: number;
  prepareMs: number;
  collectMs: number;
  setupMs: number;
  testsMs: number;
  state: string;
}

const ms = (value: number | undefined) => Math.round(value ?? 0);

function readExisting(outputFile: string): Record<string, FileTiming> {
  try {
    const parsed = JSON.parse(fs.readFileSync(outputFile, 'utf8')) as { files?: Record<string, FileTiming> };
    return parsed.files ?? {};
  } catch {
    return {};
  }
}

export default class FileTimingReporter implements Reporter {
  private root = process.cwd();

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const target = process.env[FILE_TIMINGS_ENV];
    if (!target) return;
    const outputFile = path.resolve(target);
    try {
      // Merge so a second Vitest invocation in the same job cannot drop files.
      const files = readExisting(outputFile);
      for (const testModule of testModules) {
        const diagnostic = testModule.diagnostic();
        const file = path.relative(this.root, testModule.moduleId).replace(/\\/g, '/');
        const timing = {
          environmentMs: ms(diagnostic.environmentSetupDuration),
          prepareMs: ms(diagnostic.prepareDuration),
          collectMs: ms(diagnostic.collectDuration),
          setupMs: ms(diagnostic.setupDuration),
          testsMs: ms(diagnostic.duration),
        };
        files[file] = {
          totalMs: timing.environmentMs + timing.prepareMs + timing.collectMs + timing.setupMs + timing.testsMs,
          ...timing,
          state: testModule.state(),
        };
      }
      const sorted = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `${JSON.stringify({
        version: 1,
        platform: process.platform,
        shard: process.env.XDT_UNIT_TEST_SHARD ?? null,
        files: sorted,
      }, null, 2)}\n`);
    } catch (error) {
      console.warn(`[file-timings] could not write ${outputFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
