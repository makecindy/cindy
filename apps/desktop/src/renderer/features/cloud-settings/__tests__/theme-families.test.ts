import { expect, it, vi } from 'vitest';

// Unit: the cloud settings page names built-in theme families from a shared list (main reads it
// without the renderer's themes). It must stay the app's own list, so a family change
// fails here instead of leaving the cloud page with a missing or stale name.
vi.mock('@/themes/local-themes', () => ({ getLocalThemes: () => [], onLocalThemesChange: () => () => undefined }));
import { getThemeFamilies } from '@/themes/families';
import { BUILTIN_THEME_FAMILIES } from '../../../../shared/themeFamilies';

it('lists the same built-in theme families, in order and by name, as the app', () => {
  expect(getThemeFamilies().map(({ id, name }) => ({ id, name }))).toEqual(
    BUILTIN_THEME_FAMILIES.map(({ id, name }) => ({ id, name })),
  );
});
