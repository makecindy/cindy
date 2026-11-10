// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { Tip } from '../tooltip';
import { SelectParts } from '../select-parts';
import { MorphPopover } from '../morph-popover';

/**
 * Production entry / result: shared Popover and DropdownMenu must replace sibling panels,
 * retain nested panels and hand focus to the new panel. User report: two reader lists,
 * or a reader list and reaction picker, remain open together (2026-11-10).
 * Gap: individual reader/menu tests never open two independent roots on one page.
 * Minimal input: open two roots while preserving focus (also used by composer panels).
 * Tier: unit; real Radix portals in jsdom, no host/network. Runtime geometry is ui:check's job.
 */
function Panel({
  name,
  controlled = false,
  forceHint = false,
  children,
}: {
  name: string;
  controlled?: boolean;
  forceHint?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover {...(controlled ? { open, onOpenChange: setOpen } : {})}>
      <Tip text={`${name} hint`} forceOpen={forceHint}>
        <PopoverTrigger asChild>
          <button onClick={(event) => event.stopPropagation()}>{name}</button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        aria-label={`${name} panel`}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {children ?? <button>{name} action</button>}
      </PopoverContent>
    </Popover>
  );
}

beforeAll(() => {
  // jsdom has no scrolling; Select calls this DOM API before focusing its option.
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

describe('page transient layers', () => {
  it.each([false, true])(
    'replaces a sibling popover in one click (controlled=%s)',
    async (controlled) => {
      render(
        <>
          <Panel name="First" controlled={controlled} />
          <Panel name="Second" controlled={controlled} />
        </>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'First' }));
      await screen.findByRole('dialog', { name: 'First panel' });
      fireEvent.click(screen.getByRole('button', { name: 'Second' }));
      await screen.findByRole('dialog', { name: 'Second panel' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'First panel' })).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'Second' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    },
  );

  it('coordinates different primitives without returning focus to the replaced trigger', async () => {
    render(
      <>
        <Panel name="Readers" />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger>More</DropdownMenuTrigger>
          <DropdownMenuContent aria-label="Actions">
            <DropdownMenuItem>Copy</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Readers' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'Enter' });
    await screen.findByRole('menu', { name: 'More' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy' })),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More' }));
  });

  it('also replaces panels opened by owner state rather than a primitive trigger', async () => {
    const view = (open: boolean) => (
      <>
        <Panel name="Readers" />
        <Popover open={open}>
          <PopoverTrigger>Owner</PopoverTrigger>
          <PopoverContent aria-label="Owner panel">
            <button>Owner action</button>
          </PopoverContent>
        </Popover>
      </>
    );
    const mounted = render(view(false));
    fireEvent.click(screen.getByRole('button', { name: 'Readers' }));
    await screen.findByRole('dialog');
    mounted.rerender(view(true));
    await screen.findByRole('dialog', { name: 'Owner panel' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Readers panel' })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Owner action' }));
  });

  it('keeps the parent across portals, replaces sibling children and closes only the child on Escape', async () => {
    render(
      <Panel name="Parent">
        <Panel name="Child A" />
        <Panel name="Child B" />
      </Panel>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Parent' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Child A' }));
    await screen.findByRole('dialog', { name: 'Child A panel' });
    expect(screen.getByRole('dialog', { name: 'Parent panel' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Child B' }));
    const child = await screen.findByRole('dialog', { name: 'Child B panel' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Child A panel' })).toBeNull());
    fireEvent.keyDown(child, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Child B panel' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Parent panel' })).toBeTruthy();
  });

  it('replaces a whole nested branch when an unrelated root opens', async () => {
    render(
      <>
        <Panel name="Parent">
          <Panel name="Child" />
        </Panel>
        <Panel name="Other" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Parent' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Child' }));
    await screen.findByRole('dialog', { name: 'Child panel' });
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await screen.findByRole('dialog', { name: 'Other panel' });
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
  });

  it('suppresses trigger hints while open and allows hints inside the panel', async () => {
    render(
      <Panel name="Readers" forceHint>
        <Tip text="Inside hint" forceOpen>
          <button>Inside</button>
        </Tip>
      </Panel>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Readers' }));
    await screen.findByRole('dialog');
    await screen.findByRole('tooltip', { name: 'Inside hint' });
    expect(screen.queryByRole('tooltip', { name: 'Readers hint' })).toBeNull();
  });

  it('includes Select panels in the same branch and keeps focus on the new option', async () => {
    render(
      <>
        <Panel name="Readers" />
        <SelectParts.Root defaultValue="one">
          <SelectParts.Trigger aria-label="Choice">
            <SelectParts.Value />
          </SelectParts.Trigger>
          <SelectParts.Portal>
            <SelectParts.Content>
              <SelectParts.Viewport>
                <SelectParts.Item value="one">
                  <SelectParts.ItemText>One</SelectParts.ItemText>
                </SelectParts.Item>
              </SelectParts.Viewport>
            </SelectParts.Content>
          </SelectParts.Portal>
        </SelectParts.Root>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Readers' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Choice' }), { key: 'Enter' });
    await screen.findByRole('listbox');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'One' }));
  });

  it('includes custom MorphPopover shells without changing the page owner state API', async () => {
    function MorphPanel() {
      const [open, setOpen] = useState(false);
      return (
        <MorphPopover
          open={open}
          onOpenChange={setOpen}
          panelAriaLabel="Morph panel"
          trigger={<button onClick={() => setOpen((value) => !value)}>Morph</button>}
        >
          <button>Morph action</button>
        </MorphPopover>
      );
    }
    render(
      <>
        <MorphPanel />
        <Panel name="Readers" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Morph' }));
    await screen.findByRole('group', { name: 'Morph panel' });
    fireEvent.click(screen.getByRole('button', { name: 'Readers' }));
    await screen.findByRole('dialog');
    await waitFor(() =>
      expect(
        screen.queryByRole('group', { name: 'Morph panel' })?.getAttribute('data-state'),
      ).not.toBe('open'),
    );
    // Open in the other direction via the owner's controlled state as well.
    fireEvent.click(screen.getByRole('button', { name: 'Morph' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
