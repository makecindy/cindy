import { describe, expect, it } from 'vitest';
import { indeterminateSweepRange, presentAndroidUpdate } from './androidUpdatePresentation';

describe('Android update card presentation', () => {
  it('offers the update with a single primary action and no detour links', () => {
    expect(presentAndroidUpdate('offer', null)).toMatchObject({
      note: null, progress: null, primary: { label: 'updateNow', busy: false }, dismiss: 'later', browser: false,
    });
  });
  it('explains the install permission before any settings handoff and keeps the browser path', () => {
    expect(presentAndroidUpdate('permission-required', null)).toMatchObject({
      note: 'permission', primary: { label: 'grantAndUpdate' }, browser: true,
    });
    expect(presentAndroidUpdate('permission-denied', null)).toMatchObject({
      note: 'denied', primary: { label: 'grantAgain' }, browser: true,
    });
  });
  it('downloads show progress and only a cancel action', () => {
    expect(presentAndroidUpdate('downloading', 0.62)).toMatchObject({
      progress: { value: 0.62, label: 'downloading' }, primary: null, dismiss: 'cancel', browser: false,
    });
    expect(presentAndroidUpdate('downloading', null).progress).toEqual({ value: null, label: 'downloading' });
    expect(presentAndroidUpdate('installing', 1)).toMatchObject({ progress: { value: 1, label: 'installing' }, primary: null });
  });
  it('keeps the unknown-size segment visible inside the track when motion is reduced', () => {
    expect(indeterminateSweepRange(false, 36, 100)).toEqual([0, 0]);
    expect(indeterminateSweepRange(true, 36, 100)).toEqual([-36, 100]);
  });
  it('failures and a cancelled system installer can be retried or finished in the browser', () => {
    expect(presentAndroidUpdate('error', null)).toMatchObject({ note: 'error', primary: { label: 'retry' }, browser: true });
    expect(presentAndroidUpdate('ready', 1)).toMatchObject({ ready: true, primary: { label: 'install' }, browser: true });
  });
});
