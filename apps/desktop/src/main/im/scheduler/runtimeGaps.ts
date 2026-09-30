import { MAX_RUNTIME_GAPS, type SchedulerRuntimeFrame } from '@cindy/device-link';
import { compareSchedulerStrings } from './state';

const MAX_RESOLVED_RUNTIME_GENERATIONS = MAX_RUNTIME_GAPS * 4;
const MAX_SATURATED_RUNTIME_BINDINGS = MAX_RUNTIME_GAPS * 4;

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
  private readonly saturatedBindings = new Map<
    string,
    Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration'>
  >();

  private static key(
    runtime: Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration' | 'generation'>,
  ): string {
    return `${runtime.identity}\u0000${runtime.bindingGeneration}\u0000${runtime.generation}`;
  }

  private static bindingKey(
    runtime: Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration'>,
  ): string {
    return `${runtime.identity}\u0000${runtime.bindingGeneration}`;
  }

  adopt(runtime: SchedulerRuntimeFrame): boolean {
    if (runtime.state !== 'dirty') return false;
    const key = RuntimeGapSet.key(runtime);
    if (
      this.saturatedBindings.has(RuntimeGapSet.bindingKey(runtime)) ||
      this.resolved.has(key) ||
      this.gaps.has(key)
    )
      return false;
    this.gaps.set(key, { ...runtime, state: 'dirty' });
    this.trim();
    return this.gaps.has(key);
  }

  resolve(
    runtime: Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration' | 'generation'>,
  ): boolean {
    const key = RuntimeGapSet.key(runtime);
    const bindingKey = RuntimeGapSet.bindingKey(runtime);
    const changed =
      this.gaps.has(key) ||
      (!this.resolved.has(key) && !this.saturatedBindings.has(bindingKey));
    this.gaps.delete(key);
    if (this.saturatedBindings.has(bindingKey)) return changed;
    this.resolved.set(key, {
      identity: runtime.identity,
      bindingGeneration: runtime.bindingGeneration,
      generation: runtime.generation,
    });
    this.trimResolved(runtime);
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
    this.saturatedBindings.clear();
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
    for (const [key, binding] of this.saturatedBindings) {
      if (binding.identity !== identity) continue;
      this.saturatedBindings.delete(key);
      changed = true;
    }
    return changed;
  }

  private trim(): void {
    const retained = this.values().slice(0, MAX_RUNTIME_GAPS);
    this.gaps.clear();
    for (const runtime of retained) this.gaps.set(RuntimeGapSet.key(runtime), runtime);
  }

  private trimResolved(
    newest: Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration'>,
  ): void {
    if (this.resolved.size <= MAX_RESOLVED_RUNTIME_GENERATIONS) return;

    // Runtime generations are opaque random values, so evicting one exact
    // tombstone would make a delayed dirty frame indistinguishable from new
    // work. Collapse the overflowing current binding into one fail-closed
    // barrier instead. A binding reset clears that barrier and starts a fresh
    // lifecycle, while both collections remain bounded.
    this.saturateBinding(newest);
    while (this.resolved.size > MAX_RESOLVED_RUNTIME_GENERATIONS) {
      const oldest = this.resolved.values().next().value;
      if (!oldest) break;
      this.saturateBinding(oldest);
    }
  }

  private saturateBinding(
    binding: Pick<SchedulerRuntimeFrame, 'identity' | 'bindingGeneration'>,
  ): void {
    const bindingKey = RuntimeGapSet.bindingKey(binding);
    this.saturatedBindings.set(bindingKey, {
      identity: binding.identity,
      bindingGeneration: binding.bindingGeneration,
    });
    for (const [key, runtime] of this.resolved) {
      if (RuntimeGapSet.bindingKey(runtime) === bindingKey) this.resolved.delete(key);
    }

    if (this.saturatedBindings.size <= MAX_SATURATED_RUNTIME_BINDINGS) return;
    const oldestBinding = this.saturatedBindings.keys().next().value;
    if (oldestBinding) this.saturatedBindings.delete(oldestBinding);
  }
}
