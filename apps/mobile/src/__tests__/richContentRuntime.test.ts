import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichContentRuntime } from '@/session/richContentRuntime';

afterEach(() => vi.useRealTimers());
describe('rich content admission', () => {
  it('waits for a quiet scroll interval, cancels invisible work and staggers remaining mounts', () => {
    vi.useFakeTimers();
    const queue = new RichContentRuntime();
    const a = vi.fn(), b = vi.fn(), c = vi.fn();
    const cancel = queue.request(a);
    queue.request(b); queue.request(c);
    queue.onScroll();
    vi.advanceTimersByTime(150);
    queue.onScroll(); cancel();
    vi.advanceTimersByTime(179);
    expect(a).not.toHaveBeenCalled(); expect(b).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(b).toHaveBeenCalledOnce(); expect(c).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100); expect(c).toHaveBeenCalledOnce();
    queue.request(a); queue.clear(); vi.runAllTimers();
    expect(a).not.toHaveBeenCalled();
  });
  it('bounds retained strings including keys, evicts least recently read and clears per list', () => {
    const cache = new RichContentRuntime(24);
    cache.set('a', '123'); cache.set('b', '456'); cache.set('c', '789');
    expect(cache.get('a')).toBe('123');
    cache.set('d', 'xyz');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.set('too-big', 'x'.repeat(30))).toBe(false);
    cache.set('a', 'changed');
    expect(cache.get('a')).toBe('changed');
    cache.clear(); expect(cache.get('a')).toBeUndefined();
    const other = new RichContentRuntime();
    cache.set('a', '123'); expect(other.get('a')).toBeUndefined();
  });
});
