// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { usePromptRecommendationVisibility } from '@/session/usePromptRecommendationVisibility';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let value: ReturnType<typeof usePromptRecommendationVisibility>;
let props: { scope: string; draft: string; active: boolean };
function Probe() { value = usePromptRecommendationVisibility(props.scope, props.draft, props.active); return null; }
async function render(patch: Partial<typeof props> = {}) {
  props = { ...props, ...patch };
  await act(async () => root.render(createElement(Probe)));
}
beforeEach(() => { root = createRoot(document.createElement('div')); props = { scope: 'task', draft: '', active: false }; });
afterEach(async () => { await act(async () => root.unmount()); });

it('hides on focus, restores when cleared while focused, and hides on another interaction', async () => {
  await render(); expect(value.visible).toBe(true);
  await render({ active: true }); expect(value.visible).toBe(false);
  await render({ draft: 'Hello' }); expect(value.visible).toBe(false);
  await render({ draft: '' }); expect(value.visible).toBe(true);
  await act(async () => value.hide()); expect(value.visible).toBe(false);
  await render({ active: false }); expect(value.visible).toBe(true);
});

it('restores on collapse with a draft, then hides on expanding or typing including whitespace', async () => {
  await render({ active: true, draft: 'Unsent draft' }); expect(value.visible).toBe(false);
  await render({ active: false }); expect(value.visible).toBe(true);
  await render({ active: true }); expect(value.visible).toBe(false);
  await render({ draft: '' }); expect(value.visible).toBe(true);
  await render({ draft: ' ' }); expect(value.visible).toBe(false);
});

it('does not carry a cleared-editor exception across tasks or a new expansion', async () => {
  await render({ active: true, draft: 'Draft' });
  await render({ draft: '' }); expect(value.visible).toBe(true);
  await render({ scope: 'other' }); expect(value.visible).toBe(false);
  await render({ active: false }); expect(value.visible).toBe(true);
  await render({ active: true }); expect(value.visible).toBe(false);
});
