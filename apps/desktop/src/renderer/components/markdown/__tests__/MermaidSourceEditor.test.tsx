// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { MermaidSourceEditorHost } from '../MermaidSourceEditor';
import { MERMAID_EDIT_EVENT } from '../markdownMermaidLivePreview';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function openEditor(applyEdit = vi.fn(() => 'applied' as const)) {
  render(<>
    <button onClick={() => window.dispatchEvent(new CustomEvent(MERMAID_EDIT_EVENT, {
      detail: { source: 'graph TD', applyEdit },
    }))}>Edit diagram</button>
    <MermaidSourceEditorHost />
  </>);
  return { applyEdit, opener: screen.getByRole('button', { name: 'Edit diagram' }) };
}

it('focuses the source at offset zero, traps Tab, keeps the draft on scrim click and returns focus', async () => {
  const user = userEvent.setup();
  const { opener, applyEdit } = openEditor();
  await user.click(opener);
  const source = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(document.activeElement).toBe(source);
  expect(source.selectionStart).toBe(0);
  expect(document.body.dataset.mermaidEditorOpen).toBe('1');
  const save = screen.getByRole('button', { name: 'ccAgent.workdirBrowse.mermaidEditor.save' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(source, { target: { value: 'graph LR' } });
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(save);
  await user.tab();
  expect(document.activeElement).toBe(source);
  fireEvent.pointerDown(document.querySelector('.modal-scrim')!);
  fireEvent.click(document.querySelector('.modal-scrim')!);
  expect(source.value).toBe('graph LR');
  expect(document.activeElement).toBe(source);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(document.body.dataset.mermaidEditorOpen).toBeUndefined();
  expect(applyEdit).not.toHaveBeenCalled();
});

it.each([true, false])('Cmd+Enter commits only a dirty draft (dirty=%s)', async (dirty) => {
  const user = userEvent.setup();
  const { opener, applyEdit } = openEditor();
  await user.click(opener);
  if (dirty) fireEvent.change(screen.getByRole('textbox'), { target: { value: 'graph LR' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  if (dirty) expect(applyEdit).toHaveBeenCalledExactlyOnceWith('graph LR');
  else expect(applyEdit).not.toHaveBeenCalled();
});

it('lets Presence finish the closing animation before committing and unmounting', async () => {
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = getStyle(element);
    if (element.classList.contains('modal-panel') || element.classList.contains('modal-scrim')) {
      // JSDOM has no CSS animations. Supply the real data-state contract and
      // dispatch its completion rather than mocking Radix or advancing a timer.
      Object.defineProperty(style, 'animationName', { configurable: true, get: () =>
        element.getAttribute('data-state') === 'closed' ? 'modal-fade-out' : 'modal-panel-in' });
    }
    return style;
  });
  const user = userEvent.setup();
  const { opener, applyEdit } = openEditor();
  await user.click(opener);
  const panel = screen.getByRole('dialog');
  const source = screen.getByRole('textbox');
  fireEvent.change(source, { target: { value: 'graph LR' } });
  fireEvent.animationStart(panel, { animationName: 'modal-panel-in' });
  await user.click(screen.getByRole('button', { name: 'ccAgent.workdirBrowse.mermaidEditor.save' }));
  expect(panel.getAttribute('data-state')).toBe('closed');
  expect(panel.isConnected).toBe(true);
  expect(applyEdit).not.toHaveBeenCalled();
  const end = new Event('animationend', { bubbles: true });
  Object.defineProperty(end, 'animationName', { value: 'modal-fade-out' });
  act(() => { panel.dispatchEvent(end); });
  await waitFor(() => expect(applyEdit).toHaveBeenCalledExactlyOnceWith('graph LR'));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
