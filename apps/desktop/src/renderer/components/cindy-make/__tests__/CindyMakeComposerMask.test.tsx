// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CindyMakeComposerMask } from '../CindyMakeComposerMask';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

describe('Cindy Make input replacement', () => {
  it('replaces the editor with preparation status and an explanation', () => {
    const view = render(<CindyMakeComposerMask phase="dependencies" />);
    expect(screen.getByRole('status').textContent).toContain('cindyMake.code.phases.dependencies');
    expect(screen.getByText('cindyMake.code.inputLocked.hint')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(view.container.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('preserves the stop action during first execution', () => {
    const stop = vi.fn();
    render(<CindyMakeComposerMask phase="executing" onStop={stop} />);
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.prepare.stop' }));
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'cancelled'] as const)('explains where to retry %s preparation', (phase) => {
    render(<CindyMakeComposerMask phase={phase} />);
    expect(screen.getByText('cindyMake.code.inputLocked.retry')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
