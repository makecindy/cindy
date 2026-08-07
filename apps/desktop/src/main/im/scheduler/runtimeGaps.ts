import { MAX_RUNTIME_GAPS, type SchedulerRuntimeFrame } from '@cindy/device-link';
import { compareSchedulerStrings } from './state';

/**
 * Bounded, deterministic runtime-gap state. This is deliberately a data
 * structure only; Discord offline notices and Gateway lifecycle stay in PR-B.
 */
export class RuntimeGapSet {
  private readonly gaps = new Map<string, SchedulerRuntimeFrame>();

  adopt(runtime: SchedulerRuntimeFrame): boolean {
    if (runtime.state !== 'dirty') return false;
    const existing = this.gaps.get(runtime.identity);
    if (existing && existing.generation <= runtime.generation) return false;
    this.gaps.set(runtime.identity, { ...runtime, state: 'dirty' });
    this.trim();
    return true;
  }

  resolve(generation: string): boolean {
    let changed = false;
    for (const [identity, runtime] of this.gaps) {
      if (runtime.generation !== generation) continue;
      this.gaps.delete(identity);
      changed = true;
    }
    return changed;
  }

  get(identity: string): SchedulerRuntimeFrame | undefined {
    const runtime = this.gaps.get(identity);
    return runtime ? { ...runtime } : undefined;
  }

  values(): SchedulerRuntimeFrame[] {
    return [...this.gaps.values()]
      .sort(
        (left, right) =>
          compareSchedulerStrings(left.generation, right.generation) ||
          compareSchedulerStrings(left.identity, right.identity),
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
    return this.gaps.delete(identity);
  }

  private trim(): void {
    const retained = this.values().slice(0, MAX_RUNTIME_GAPS);
    this.gaps.clear();
    for (const runtime of retained) this.gaps.set(runtime.identity, runtime);
  }
}
