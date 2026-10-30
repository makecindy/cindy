/**
 * Native scroll events can arrive one paint after a script writes scrollTop in
 * rAF. Observe writes on this owned element (never a DOM prototype) so the
 * virtualizer can commit its destination at the current microtask checkpoint.
 * Waiting until the writer's stack finishes also avoids flushSync inside a
 * React render/commit when layout effects themselves adjust the scroll offset.
 */
export function observeProgrammaticScroll(root: HTMLElement, onChange: () => void): () => void {
  const originalOwn = Object.getOwnPropertyDescriptor(root, 'scrollTop');
  let owner: object | null = root;
  let descriptor: PropertyDescriptor | undefined;
  while (owner && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(owner, 'scrollTop');
    owner = Object.getPrototypeOf(owner);
  }
  if (originalOwn?.configurable === false || !descriptor?.get || !descriptor.set) return () => {};
  const read = descriptor.get;
  const write = descriptor.set;
  let active = true;
  let queued = false;
  const setter = function (this: HTMLElement, value: number) {
    const before = read.call(this);
    write.call(this, value);
    if (!active || this !== root || queued || read.call(this) === before) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (active) onChange();
    });
  };
  Object.defineProperty(root, 'scrollTop', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: read,
    set: setter,
  });
  return () => {
    active = false;
    // Do not undo another owner's later descriptor. Its saved setter can still
    // delegate to ours, which becomes an ordinary native write after cleanup.
    if (Object.getOwnPropertyDescriptor(root, 'scrollTop')?.set !== setter) return;
    if (originalOwn) Object.defineProperty(root, 'scrollTop', originalOwn);
    else delete (root as unknown as { scrollTop?: number }).scrollTop;
  };
}
