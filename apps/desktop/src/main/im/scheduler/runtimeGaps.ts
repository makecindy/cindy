import { MAX_RUNTIME_GAPS, type SchedulerRuntimeFrame } from '@cindy/device-link';
import { compareSchedulerStrings } from './state';

const MAX_RESOLVED_RUNTIME_GENERATIONS = MAX_RUNTIME_GAPS * 4;

/**
 * Bounded, deterministic runtime-gap state. This is deliberately a data
 * structure only; Discord offline notices and Gateway lifecycle stay in PR-B.
 */
export class RuntimeGapSet {
  private readonly gaps = new Map<string, SchedulerRuntimeFrame>();
  private readonly resolved = new Map<
    string,
    Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration' | 'generation'>
  >();

  private static key(
    runtime: Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration' | 'generation'>,
  ): string {
    return `${runtime.identity}\u0000${runtime.bindingGeneration}\u0000${runtime.generation}`;
  }

  adopt(runtime: SchedulerRuntimeFrame): boolean {
    if (runtime.state !== 'dirty') return false;
    const key = RuntimeGapSet.key(runtime);
    if (this.resolved.has(key) || this.gaps.has(key)) return false;
    this.gaps.set(key, { ...runtime, state: 'dirty' });
    this.trim();
    return this.gaps.has(key);
  }

  resolve(
    runtime: Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration' | 'generation'>,
  ): boolean {
    const key = RuntimeGapSet.key(runtime);
    const changed = !this.resolved.has(key) || this.gaps.has(key);
    this.gaps.delete(key);
    this.resolved.set(key, {
      identity: runtime.identity,
      bindingGeneration: runtime.bindingGeneration,
      generation: runtime.generation,
    });
    this.trimResolved();
    return changed;
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
    this.resolved.clear();
  }

  clearIdentity(identity: string): boolean {
    let changed = false;
    for (const [key, runtime] of this.gaps) {
      if (runtime.identity !== identity) continue;
      this.gaps.delete(key);
      changed = true;
    }
    for (const [key, runtime] of this.resolved) {
      if (runtime.identity !== identity) continue;
      this.resolved.delete(key);
      changed = true;
    }
    return changed;
  }

  private trim(): void {
    const retained = this.values().slice(0, MAX_RUNTIME_GAPS);
    this.gaps.clear();
    for (const runtime of retained) this.gaps.set(RuntimeGapSet.key(runtime), runtime);
  }

  private trimResolved(): void {
    if (this.resolved.size <= MAX_RESOLVED_RUNTIME_GENERATIONS) return;
    const retained = [...this.resolved.entries()]
      .sort(([left], [right]) => compareSchedulerStrings(left, right))
      .slice(0, MAX_RESOLVED_RUNTIME_GENERATIONS);
    this.resolved.clear();
    for (const [key, runtime] of retained) this.resolved.set(key, runtime);
  }
}
