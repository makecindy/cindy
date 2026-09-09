// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  WORKLOUDER_CODEX_KEYCAP_IDS,
  createWorkLouderCodexDefaultSettings,
} from '../../../../shared/workLouderCodex';
import {
  WorkLouderCodexKeyboardLayout,
  WorkLouderCodexKeycapPicker,
} from '../WorkLouderCodexKeyboardLayout';
import { WorkLouderCodexKeycapGlyph } from '../WorkLouderCodexKeycapGlyphs';

const LABELS = { analogStick: '摇杆', encoder: '旋钮', indicator: '状态指示灯' };

function agentSlots(titles: (string | null)[] = []) {
  return Array.from({ length: 6 }, (_, slot) => ({
    slot,
    sessionId: null,
    title: titles[slot] ?? null,
    action: null,
  }));
}

describe('WorkLouderCodexKeyboardLayout', () => {
  it('draws the board as 4x4: stick, six agent keys, four command keys, mic and Codex', () => {
    const settings = createWorkLouderCodexDefaultSettings();
    render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots(['最近任务'])}
        labels={LABELS}
        onEditKeycap={vi.fn()}
      />,
    );

    expect(screen.getByTestId('worklouder-codex-keyboard-layout')).toBeTruthy();
    // Six agent keys, addressed by slot id since nothing is printed on them.
    for (let index = 0; index < 6; index += 1) {
      const slot = `AG0${index}`;
      expect(screen.getByRole('button', { name: new RegExp(`^${slot}`) })).toBeTruthy();
    }
    // The four command keys plus the merged microphone key and Codex.
    expect(screen.getByRole('button', { name: /^FAST/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^APPR/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^REJ/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^SPLIT/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^MIC/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^CODEX/ })).toBeTruthy();
    // The stick and the encoder are parts of the board, not decoration.
    expect(screen.getByRole('button', { name: /摇杆/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /旋钮/ })).toBeTruthy();
  });

  it('shows a pressed key when the physical board reports that part', () => {
    const settings = createWorkLouderCodexDefaultSettings();
    render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots()}
        labels={LABELS}
        pressedParts={new Set(['ACT06'])}
        onEditKeycap={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /^FAST/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /^APPR/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('turns the encoder by each detent and moves the stick by angle and distance', () => {
    const settings = createWorkLouderCodexDefaultSettings();
    const { rerender } = render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots()}
        labels={LABELS}
        encoderTurns={2}
        analogStick={{ angle: 0.75, distance: 1 }}
        onEditKeycap={vi.fn()}
      />,
    );

    const encoder = screen.getByRole('button', { name: /旋钮/ }).querySelector('[data-encoder-turns]');
    const stick = screen.getByTestId('worklouder-codex-stick-cap');
    expect(encoder?.getAttribute('data-encoder-turns')).toBe('2');
    expect((encoder as HTMLElement | null)?.style.transform).toBe('rotate(-36deg)');
    expect(stick.getAttribute('style')).toContain('translate(0px, -10px)');

    rerender(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots()}
        labels={LABELS}
        encoderTurns={-1}
        analogStick={{ angle: 0.5, distance: 0.5 }}
        onEditKeycap={vi.fn()}
      />,
    );

    const moved = screen.getByTestId('worklouder-codex-stick-cap');
    expect(
      screen.getByRole('button', { name: /旋钮/ }).querySelector('[data-encoder-turns]')?.getAttribute(
        'data-encoder-turns',
      ),
    ).toBe('-1');
    expect(moved.getAttribute('style')).toContain('translate(-5px, 0px)');
  });

  it('puts the encoder and the stick in the corners they occupy on the device', () => {
    const settings = createWorkLouderCodexDefaultSettings();
    const { container } = render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots()}
        labels={LABELS}
        onEditKeycap={vi.fn()}
      />,
    );

    const board = container.querySelector('[data-testid="worklouder-codex-keyboard-layout"]');
    const encoder = board?.querySelector('[aria-label*="旋钮"]')?.parentElement;
    const analog = board?.querySelector('[aria-label*="摇杆"]')?.parentElement;
    expect(encoder?.getAttribute('style')).toMatch(/grid-column:\s*1/);
    expect(analog?.getAttribute('style')).toMatch(/grid-column:\s*4/);
    expect(encoder?.getAttribute('style')).toMatch(/grid-row:\s*1/);
    expect(analog?.getAttribute('style')).toMatch(/grid-row:\s*1/);
  });

  it('prints no lettering on the keys — the real keycaps carry artwork only', () => {
    const settings = createWorkLouderCodexDefaultSettings();
    const { container } = render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots(['最近任务'])}
        labels={LABELS}
        onEditKeycap={vi.fn()}
      />,
    );

    // Legends and titles belong in the hover tooltip, never on the board.
    expect(container.textContent).toBe('');
  });

  it('splits the microphone into two single-width keys when the layout asks', () => {
    const settings = createWorkLouderCodexDefaultSettings();
    settings.layout.separateMicrophoneKeys = true;
    settings.layout.merges = [];
    settings.layout.slots.ACT10 = { keycapId: 'MIC', action: null };

    render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots()}
        labels={LABELS}
        onEditKeycap={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('button', { name: /^MIC$/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^EMPT1/ })).toBeTruthy();
  });

  it('opens the editor for whichever part was clicked', () => {
    const onEditKeycap = vi.fn();
    const settings = createWorkLouderCodexDefaultSettings();

    render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots()}
        labels={LABELS}
        onEditKeycap={onEditKeycap}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^FAST/ }));
    expect(onEditKeycap).toHaveBeenLastCalledWith('ACT06');

    fireEvent.click(screen.getByRole('button', { name: /^AG00/ }));
    expect(onEditKeycap).toHaveBeenLastCalledWith('AG00');

    fireEvent.click(screen.getByRole('button', { name: /摇杆/ }));
    expect(onEditKeycap).toHaveBeenLastCalledWith('analog');

    fireEvent.click(screen.getByRole('button', { name: /旋钮/ }));
    expect(onEditKeycap).toHaveBeenLastCalledWith('encoder');
  });
});

describe('WorkLouderCodexKeyboardLayout — Creator Micro 2', () => {
  it('binds push-to-talk to a blank cap on ACT10 and keeps the bottom row split', () => {
    const { layout } = createWorkLouderCodexDefaultSettings('creator-micro-2');

    expect(layout.separateMicrophoneKeys).toBe(true);
    expect(layout.slots.ACT10).toEqual({ keycapId: 'EMPT1', action: { type: 'voice' } });
    expect(layout.slots.ACT11).toEqual({ keycapId: 'EMPT2', action: null });
    expect(layout.slots.ACT12.action).toEqual({
      type: 'command',
      commandId: 'composer.submit',
    });
  });

  it('draws its own board: three 1U bottom keys, the same status lights, no microphone cap', () => {
    const settings = createWorkLouderCodexDefaultSettings('creator-micro-2');
    render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots()}
        model="creator-micro-2"
        labels={LABELS}
        onEditKeycap={vi.fn()}
      />,
    );

    // Thirteen blank keys: six agent keys plus seven command keys, all drawn
    // as single-width caps. Creator ships no 2U MIC cap and no CODEX cap.
    expect(screen.getAllByRole('button', { name: /^AG0/ })).toHaveLength(6);
    expect(screen.queryByRole('button', { name: /^MIC/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^CODEX/ })).toBeNull();

    // The bottom-left cluster is the same three status lights as Codex;
    // the three bottom keys are separate 1U keys.
    expect(screen.queryByTestId('worklouder-creator-touch-cluster')).toBeNull();
    expect(screen.getByRole('img', { name: '状态指示灯' })).toBeTruthy();
    const empt1 = screen.getAllByRole('button', { name: /^EMPT1/ });
    expect(empt1).toHaveLength(2); // ACT06 and ACT10 share the blank cap style.
  });

  it('draws a promoted Codex command key as a task slot', () => {
    const settings = createWorkLouderCodexDefaultSettings();
    settings.layout.taskKeys = ['AG00', 'AG01', 'AG02', 'AG03', 'AG04', 'ACT06'];
    render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots(['最近任务'])}
        labels={LABELS}
        onEditKeycap={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /^ACT06/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^FAST/ })).toBeNull();
  });

  it('draws a promoted command key as a task slot and a demoted agent key as a blank cap', () => {
    const settings = createWorkLouderCodexDefaultSettings('creator-micro-2');
    settings.layout.taskKeys = ['ACT06', 'AG01', 'AG02', 'AG03', 'AG04', 'AG05'];
    render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots(['最近任务'])}
        model="creator-micro-2"
        labels={LABELS}
        onEditKeycap={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /^ACT06/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^EMPT1/ }).length).toBeGreaterThan(0);
  });

  it('opens the bottom-row key editors, distinguishing ACT10 from ACT06', () => {
    const onEditKeycap = vi.fn();
    const settings = createWorkLouderCodexDefaultSettings('creator-micro-2');
    render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots()}
        model="creator-micro-2"
        labels={LABELS}
        onEditKeycap={onEditKeycap}
      />,
    );

    const empt1 = screen.getAllByRole('button', { name: /^EMPT1/ });
    fireEvent.click(empt1[0]);
    expect(onEditKeycap).toHaveBeenLastCalledWith('ACT06');
    fireEvent.click(empt1[1]);
    expect(onEditKeycap).toHaveBeenLastCalledWith('ACT10');
  });
});

describe('WorkLouderCodexKeycapPicker', () => {
  const copy = {
    title: '编辑键帽',
    description: '选择键帽',
    searchPlaceholder: '搜索键帽',
    close: '关闭',
    cancel: '取消',
    save: '保存',
    blank: '空白',
  };

  it('filters keycaps and keeps save/cancel explicit', () => {
    const onQueryChange = vi.fn();
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    const onSave = vi.fn();
    const onCancel = vi.fn();

    const { rerender } = render(
      <WorkLouderCodexKeycapPicker
        open
        slot="ACT06"
        selectedKeycapId="FAST"
        query=""
        onQueryChange={onQueryChange}
        onOpenChange={onOpenChange}
        onSelect={onSelect}
        onSave={onSave}
        onCancel={onCancel}
        copy={copy}
      />,
    );

    const search = screen.getByPlaceholderText('搜索键帽');
    fireEvent.change(search, { target: { value: 'git' } });
    expect(onQueryChange).toHaveBeenCalledWith('git');

    rerender(
      <WorkLouderCodexKeycapPicker
        open
        slot="ACT06"
        selectedKeycapId="FAST"
        query="git"
        onQueryChange={onQueryChange}
        onOpenChange={onOpenChange}
        onSelect={onSelect}
        onSave={onSave}
        onCancel={onCancel}
        copy={copy}
      />,
    );

    expect(screen.queryByRole('button', { name: 'FAST' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'GIT' }));
    expect(onSelect).toHaveBeenCalledWith('GIT');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the caller-supplied controls under the grid', () => {
    render(
      <WorkLouderCodexKeycapPicker
        open
        slot="ACT06"
        selectedKeycapId="FAST"
        query=""
        onQueryChange={vi.fn()}
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        copy={copy}
      >
        <span>已分配动作</span>
      </WorkLouderCodexKeycapPicker>,
    );

    expect(screen.getByText('已分配动作')).toBeTruthy();
  });

  it('renders the role header above the keycap search', () => {
    render(
      <WorkLouderCodexKeycapPicker
        open
        slot="ACT06"
        selectedKeycapId="FAST"
        query=""
        onQueryChange={vi.fn()}
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        header={<span>按键用途</span>}
        copy={copy}
      />,
    );

    const header = screen.getByText('按键用途');
    const search = screen.getByPlaceholderText('搜索键帽');
    expect(header.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides keycap artwork the board cannot physically wear', () => {
    render(
      <WorkLouderCodexKeycapPicker
        open
        slot="ACT10"
        selectedKeycapId="EMPT1"
        query=""
        onQueryChange={vi.fn()}
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        excludeKeycaps={['MIC', 'MIC1']}
        copy={copy}
      />,
    );

    // Creator ships blank caps only — no microphone artwork in any width.
    expect(screen.queryByRole('button', { name: 'MIC' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'MIC1' })).toBeNull();
    expect(screen.getByRole('button', { name: '空白' })).toBeTruthy();
  });

  it('puts the single blank 1U cap first instead of the numbered catalogue SKUs', () => {
    render(
      <WorkLouderCodexKeycapPicker
        open
        slot="ACT06"
        selectedKeycapId="EMPT2"
        query=""
        onQueryChange={vi.fn()}
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        copy={copy}
      />,
    );

    const tiles = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') !== null);
    expect(tiles[0]?.getAttribute('aria-label')).toBe('空白');
    expect(tiles[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'EMPT1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'EMPT2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'EMPT3' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'EMPT4' })).toBeNull();
  });
});

describe('default stick and encoder bindings', () => {
  it('maps the stick to the two axes of the screen and the encoder to the task list', () => {
    // These defaults were wrong once (plan mode, history back/forward), which
    // no test caught. Pin them: the stick scrolls the conversation up/down and
    // opens the panel on whichever side it is pushed toward.
    const { layout } = createWorkLouderCodexDefaultSettings();

    expect(layout.analogStick.up).toEqual({
      type: 'command',
      commandId: 'conversation.scrollUp',
    });
    expect(layout.analogStick.down).toEqual({
      type: 'command',
      commandId: 'conversation.scrollDown',
    });
    expect(layout.analogStick.left).toEqual({ type: 'command', commandId: 'toggleSidebar' });
    expect(layout.analogStick.right).toEqual({
      type: 'command',
      commandId: 'toggleRightSidebar',
    });
    expect(layout.encoderMode).toBe('session-switch');
  });
});

describe('WorkLouderCodexKeycapGlyph', () => {
  it('draws Codex artwork for every keycap the hardware can wear', () => {
    for (const keycapId of WORKLOUDER_CODEX_KEYCAP_IDS) {
      const { container, unmount } = render(<WorkLouderCodexKeycapGlyph keycapId={keycapId} />);
      // Blank keycaps are a bordered square and the two joke keys are silk-screened
      // text; everything else must resolve to real Codex vector artwork.
      const blank = keycapId.startsWith('EMPT');
      const legend = keycapId === 'YOLO' || keycapId === 'YEET';
      if (blank) {
        expect(container.querySelector('svg')).toBeNull();
        expect(container.textContent).toBe('');
      } else if (legend) {
        expect(container.textContent).toBe(keycapId === 'YOLO' ? ':yolo:' : ':yeet:');
      } else {
        const svg = container.querySelector('svg');
        expect(svg, `${keycapId} has no glyph`).not.toBeNull();
        expect(
          svg?.querySelector('path, circle, rect'),
          `${keycapId} glyph is empty`,
        ).not.toBeNull();
      }
      unmount();
    }
  });

  it('gives the microphone keycaps the same glyph in both sizes', () => {
    const wide = render(<WorkLouderCodexKeycapGlyph keycapId="MIC" />);
    const single = render(<WorkLouderCodexKeycapGlyph keycapId="MIC1" />);
    expect(wide.container.querySelector('svg')?.innerHTML).toBe(
      single.container.querySelector('svg')?.innerHTML,
    );
  });
});
