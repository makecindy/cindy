import { expectTypeOf, it } from 'vitest';
import type { GhostPipeDownloadProgress, GhostPipeEventPush } from '../ghost';

it('narrows download progress through the public host event union', () => {
  expectTypeOf<
    Extract<GhostPipeEventPush, { name: 'download-progress' }>
  >().toEqualTypeOf<GhostPipeDownloadProgress>();
});
