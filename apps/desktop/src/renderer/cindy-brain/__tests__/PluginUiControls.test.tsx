// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginUiControls } from '../PluginUiControls';
import type { PluginUiView } from '@cindy/maker-shared';

/* C2/C4 real native controls: explicit user input only, pending disables further
 * dispatch, unsupported views remain readable. Card controls use another path.
 * Minimal failure: rendering a view dispatches a write, or pending stays usable.
 * Tier: unit (DOM). */
const view: PluginUiView = { version: 1, viewId: 'host-view', contributionId: 'format',
  point: 'composer.tools', revision: '1', fallbackMarkdown: 'Format: Plain', blocks: [],
  actions: [{ id: 'save', label: 'Save format' }], controls: [
    { kind: 'button', id: 'save', label: 'Save format', actionId: 'save' },
    { kind: 'status', id: 'status', label: 'Current format', text: 'Plain' },
  ] };
afterEach(cleanup);
describe('PluginUiControls', () => {
  it('dispatches only an explicit button click with its declared action', () => {
    const onAction = vi.fn(); render(<PluginUiControls view={view} onAction={onAction} />);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText('Plain')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save format' }));
    expect(onAction).toHaveBeenCalledWith('save', {});
  });
  it('keeps values visible while pending or unavailable and prevents duplicate dispatch', () => {
    const onAction = vi.fn(); const { rerender } = render(<PluginUiControls view={view} pending onAction={onAction} />);
    const button = screen.getByRole('button', { name: 'Save format' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button); expect(onAction).not.toHaveBeenCalled();
    rerender(<PluginUiControls view={view} disabled onAction={onAction} />);
    expect(button.disabled).toBe(true); expect(screen.getByText('Plain')).toBeTruthy();
  });
  it('renders the readable fallback when the host has disabled unsupported actions', () => {
    render(<PluginUiControls view={{ ...view, controls: [], actions: [] }} onAction={vi.fn()} />);
    expect(screen.getByText('Format: Plain')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
