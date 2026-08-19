import { MAX_RUNTIME_GAPS, type SchedulerRuntimeFrame } from '@cindy/device-link';
import { compareSchedulerStrings } from './state';

/**
 * Bounded, deterministic runtime-gap state. This is deliberately a data
 * structure only; Discord offline notices and Gateway lifecycle stay in PR-B.
 */
export class RuntimeGapSet {
  private readonly gaps = new Map<string, SchedulerRuntimeFrame>();

  private static key(
    runtime: Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration' | 'generation'>,
  ): string {
    return `${runtime.identity}\u0000${runtime.bindingGeneration}\u0000${runtime.generation}`;
  }

  adopt(runtime: SchedulerRuntimeFrame): boolean {
    if (runtime.state !== 'dirty') return false;
    const key = RuntimeGapSet.key(runtime);
    if (this.gaps.has(key)) return false;
    this.gaps.set(key, { ...runtime, state: 'dirty' });
    this.trim();
    return this.gaps.has(key);
  }

  resolve(
    runtime: Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration' | 'generation'>,
  ): boolean {
    return this.gaps.delete(RuntimeGapSet.key(runtime));
  }

  get(identity: string): SchedulerRuntimeFrame | undefined {
    const runtime = this.values().find((candidate) => candidate.identity === identity);
    return runtime ? { ...runtime } : undefined;
  }

  values(): SchedulerRuntimeFrame[] {
    return [...this.gaps.values()]
      .sort(
        (left, right) =>
          compareSchedulerStrings(left.identity, right.identity) ||
          compareSchedulerStrings(left.bindingGeneration, right.bindingGeneration) ||
          compareSchedulerStrings(left.generation, right.generation),
      )
      .map((runtime) => ({ ...runtime }));
  }

  get size(): number {
    return this.gaps.size;
  }

  clear(): void {
    this.gaps.clear();
  }

  clearIdentity(identity: string): boolean {
    let changed = false;
    for (const [key, runtime] of this.gaps) {
      if (runtime.identity !== identity) continue;
      this.gaps.delete(key);
      changed = true;
    }
    return changed;
  }

  private trim(): void {
    const retained = this.values().slice(0, MAX_RUNTIME_GAPS);
    this.gaps.clear();
    for (const runtime of retained) this.gaps.set(RuntimeGapSet.key(runtime), runtime);
  }
}
