// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createWorkLouderCodexDefaultSettings } from '../../../../shared/workLouderCodex';
import {
  WorkLouderCodexKeyboardLayout,
  WorkLouderCodexKeycapPicker,
} from '../WorkLouderCodexKeyboardLayout';

describe('WorkLouderCodexKeyboardLayout', () => {
  it('renders the physical keycap layout and exposes command keys as edit targets', () => {
    const onEditKeycap = vi.fn();
    const settings = createWorkLouderCodexDefaultSettings();
    const agentSlots = Array.from({ length: 6 }, (_, slot) => ({
      slot,
      sessionId: null,
      title: slot === 0 ? '最近任务' : null,
      action: null,
    }));

    render(
      <WorkLouderCodexKeyboardLayout
        layout={settings.layout}
        agentSlots={agentSlots}
        onEditKeycap={onEditKeycap}
        footer="编辑布局"
      />,
    );

    expect(screen.getByTestId('worklouder-codex-keyboard-layout')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ACT06 FAST' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /AG00 最近任务/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'ACT06 FAST' }));
    expect(onEditKeycap).toHaveBeenCalledWith('ACT06');
  });

  it('uses separate microphone positions when the layout requests them', () => {
    const settings = createWorkLouderCodexDefaultSettings();
    settings.layout.separateMicrophoneKeys = true;
    const agentSlots = Array.from({ length: 6 }, (_, slot) => ({
      slot,
      sessionId: null,
      title: null,
      action: null,
    }));

    render(<WorkLouderCodexKeyboardLayout layout={settings.layout} agentSlots={agentSlots} />);

    expect(screen.getByRole('button', { name: 'ACT10 MIC1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ACT11 EMPT1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ACT10_ACT11 MIC' })).toBeNull();
  });

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
        copy={{
          title: '编辑键帽',
          description: '选择键帽',
          searchPlaceholder: '搜索键帽',
          close: '关闭',
          cancel: '取消',
          save: '保存',
          assignedShortcut: '已分配动作',
          noAssignment: '未分配动作',
        }}
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
        copy={{
          title: '编辑键帽',
          description: '选择键帽',
          searchPlaceholder: '搜索键帽',
          close: '关闭',
          cancel: '取消',
          save: '保存',
          assignedShortcut: '已分配动作',
          noAssignment: '未分配动作',
        }}
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
});
