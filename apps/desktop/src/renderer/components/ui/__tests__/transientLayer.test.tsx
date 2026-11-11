// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { Tip, Tooltip } from '../tooltip';
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

  // PR #9750 r4524268177/r4524368739: a caller can actively focus the old
  // file/link, even after Radix's default return is prevented. Existing handoff
  // tests have no custom callback. Minimal input: replace that menu with a
  // controlled popover; the new input must stay open/focused. Unit, real roots.
  it('skips custom return-focus on replacement but preserves it on ordinary Escape', async () => {
    const restoreFocus = vi.fn();
    function Handoff() {
      const source = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button ref={source}>File link</button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger>File menu</DropdownMenuTrigger>
            <DropdownMenuContent
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                source.current?.focus({ preventScroll: true });
                restoreFocus();
              }}
            >
              <DropdownMenuItem>Copy file</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button onClick={() => setOpen(true)}>Open editor</button>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger>Editor</PopoverTrigger>
            <PopoverContent aria-label="Editor panel">
              <input aria-label="New editor" />
            </PopoverContent>
          </Popover>
        </>
      );
    }
    render(<Handoff />);
    const trigger = screen.getByRole('button', { name: 'File menu' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await screen.findByRole('menu');
    fireEvent.click(screen.getByRole('button', { name: 'Open editor' }));
    const editor = await screen.findByRole('textbox', { name: 'New editor' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(editor);
    expect(restoreFocus).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(restoreFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'File link' }));
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

  // r4535034311 / DESIGN §14.6: a Popover can own an interactive toolbar.
  // Its anchor's other controls retain labels; only the actual trigger is suppressed.
  // The two asChild orders and public Tooltip API have different ref/prop forwarding.
  it.each(['tip-outside', 'tip-inside', 'generic'] as const)(
    'keeps sibling control hints when only the transient trigger is open (%s)',
    async (order) => {
      const triggerRef = { current: null as HTMLButtonElement | null };
      const button = <button ref={triggerRef}>Transcript</button>;
      const trigger = <PopoverTrigger asChild>{button}</PopoverTrigger>;
      render(
        <Popover>
          <PopoverAnchor asChild>
            <section>
              {order === 'generic' ? (
                <Tooltip.Provider>
                  <Tooltip.Root open>
                    <Tooltip.Trigger asChild>{trigger}</Tooltip.Trigger>
                    <Tooltip.Content>Transcript hint</Tooltip.Content>
                  </Tooltip.Root>
                </Tooltip.Provider>
              ) : order === 'tip-outside' ? (
                <Tip text="Transcript hint" forceOpen>
                  {trigger}
                </Tip>
              ) : (
                <PopoverTrigger asChild>
                  <Tip text="Transcript hint" forceOpen>
                    {button}
                  </Tip>
                </PopoverTrigger>
              )}
              <Tip text="Mute hint" forceOpen>
                <button aria-pressed={false}>Mute</button>
              </Tip>
              <Tip text="Disclosure hint" forceOpen>
                <button aria-expanded>Disclosure</button>
              </Tip>
            </section>
          </PopoverAnchor>
          <PopoverContent onOpenAutoFocus={(event) => event.preventDefault()}>
            Transcript content
          </PopoverContent>
        </Popover>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
      await screen.findByRole('dialog');
      expect(screen.getByRole('tooltip', { name: 'Mute hint' })).toBeTruthy();
      expect(screen.getByRole('tooltip', { name: 'Disclosure hint' })).toBeTruthy();
      expect(screen.queryByRole('tooltip', { name: 'Transcript hint' })).toBeNull();
      expect(triggerRef.current).toBe(screen.getByRole('button', { name: 'Transcript' }));
    },
  );

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
          trigger={
            <Tip text="Morph hint" forceOpen>
              <button onClick={() => setOpen((value) => !value)}>Morph</button>
            </Tip>
          }
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
    expect(screen.queryByRole('tooltip', { name: 'Morph hint' })).toBeNull();
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
