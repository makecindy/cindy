import { beforeEach, describe, expect, it } from 'vitest';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { clearMessageReadingPositions, messageReadingPosition } from '../session/messageReadingPosition';

const position = { anchor: { key: 'message-4', viewportOffset: -32 }, atEnd: false };
describe('recent message reading positions', () => {
  beforeEach(() => { setMobileAuthOwner('reader'); clearMessageReadingPositions(); });
  it('restores synchronously without sharing between devices or tasks', () => {
    messageReadingPosition('a', 'task').write(position);
    expect(messageReadingPosition('a', 'task').read()).toEqual(position);
    expect(messageReadingPosition('b', 'task').read()).toBeUndefined();
    expect(messageReadingPosition('a', 'other').read()).toBeUndefined();
  });
  it('drops bookmarks on account changes and rejects writes from the old page', () => {
    const old = messageReadingPosition('a', 'task'); old.write(position);
    setMobileAuthOwner('other'); old.write(position);
    expect(old.read()).toBeUndefined();
    expect(messageReadingPosition('a', 'task').read()).toBeUndefined();
  });
  it('does not resurrect a bookmark after task invalidation', () => {
    const old = messageReadingPosition('a', 'task'); old.write(position);
    clearMessageReadingPositions('a', 'task'); old.write(position);
    expect(messageReadingPosition('a', 'task').read()).toBeUndefined();
  });
  it('bounds retention to eight recent tasks and preserves explicit follow-latest', () => {
    const old = messageReadingPosition('a', 'old'); old.write(position);
    for (let i = 0; i < 8; i++) messageReadingPosition('a', String(i)).write(position);
    expect(old.read()).toBeUndefined();
    messageReadingPosition('a', '7').write({ anchor: null, atEnd: true });
    expect(messageReadingPosition('a', '7').read()).toEqual({ anchor: null, atEnd: true });
  });
});
