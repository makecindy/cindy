// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import {
  RunningTokenRatePopover,
  useRunningTokenRateHistory,
} from '@/features/cc-agent/RunningTokenRatePopover';
import {
  formatRecentOutputTokenRate,
  formatRunningTokenCount,
  resolveRunningUsageMeta,
} from '@/features/cc-agent/lib/runningTokenUsage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Execute the actual status bar without loading the entire session view's IPC/store graph.
const source = readFileSync(
  resolve(__dirname, '../features/cc-agent/CCAgentSessionView.tsx'),
  'utf8',
);
const ast = ts.createSourceFile(
  'view.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const component = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'RunningStatusBar',
);
if (!component) throw new Error('RunningStatusBar not found');
const compiled = ts.transpileModule(component.getText(ast), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const Icon = () => null;
const deps = {
  React,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTranslation: () => ({ t: (key: string) => key }),
  useReducedMotion: () => true,
  useAnimatedNumber: (value: number) => value,
  localizeAgentStatus: (status: string) => status,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  Check: Icon,
  Activity: Icon,
  Layers: Icon,
  Sparkles: Icon,
  Spinner: Icon,
  Square: Icon,
  ArrowDown: Icon,
  STATUS_BAR_FADE_MS: 400,
  RunningTokenRatePopover,
  useRunningTokenRateHistory,
  formatRecentOutputTokenRate,
  formatRunningTokenCount,
  resolveRunningUsageMeta,
};
const RunningStatusBar = new Function(
  'deps',
  `const {${Object.keys(deps).join(',')}} = deps; ${compiled}; return RunningStatusBar;`,
)(deps) as React.ComponentType<{
  visible: boolean;
  suppressContent?: boolean;
  rightLeadingSlot?: React.ReactNode;
  status: string;
  reconnectStatus?: string | null;
  startedAt: number;
  tokenUsage: number;
  outputTokens: number;
  generationDurationMs: number;
  generationReliable?: boolean;
}>;

afterEach(cleanup);

it.each([false, true])('reconnect hides stale speed and pinned history, then waits for fresh samples (pinned=%s)', (pinned) => {
  const props = {
    visible: true, status: 'Generating...', startedAt: 1, tokenUsage: 1000,
    outputTokens: 0, generationDurationMs: 0, generationReliable: true,
  };
  const { container, rerender } = render(<RunningStatusBar {...props} />);
  const measured = { ...props, outputTokens: 465, generationDurationMs: 10000 };
  rerender(<RunningStatusBar {...measured} />);
  const trigger = () => container.querySelector('[data-running-status-meta] button');
  expect(trigger()?.textContent).toContain('chat.runningStatus.tokenRate');
  if (pinned) {
    fireEvent.click(trigger()!);
    expect(screen.getByRole('dialog').textContent).toContain('46.5');
  }

  rerender(<RunningStatusBar {...measured} reconnectStatus="Reconnecting 1/5" />);
  expect(screen.getByText('Reconnecting 1/5')).toBeTruthy();
  expect(screen.queryByText('Generating...')).toBeNull();
  expect(trigger()).toBeNull();
  expect(container.querySelector('[data-running-status-meta]')?.textContent).not.toContain('token');
  expect(screen.queryByRole('dialog')).toBeNull();

  rerender(<RunningStatusBar {...measured} reconnectStatus="Reconnecting 2/5" />);
  expect(screen.getByText('Reconnecting 2/5')).toBeTruthy();
  expect(trigger()).toBeNull();

  // Recovery must not redisplay the pre-interruption 46.5 tok/s.
  rerender(<RunningStatusBar {...measured} />);
  expect(screen.getByText('Generating...')).toBeTruthy();
  expect(trigger()).not.toBeNull();
  expect(trigger()?.textContent).not.toContain('chat.runningStatus.waitingSample');
  expect(trigger()?.textContent).not.toContain('chat.runningStatus.tokenRate');
  expect(screen.queryByRole('dialog')).toBeNull();
  rerender(<RunningStatusBar {...measured} outputTokens={515} generationDurationMs={11000} />);
  expect(trigger()?.textContent).toContain('chat.runningStatus.tokenRate');
  fireEvent.click(trigger()!);
  expect(screen.getByRole('dialog').textContent).toContain('50');
});

it('reconnect hides token fallback for harnesses without reliable generation timing', () => {
  const { container } = render(<RunningStatusBar
    visible status="Generating..." reconnectStatus="Reconnecting" startedAt={1}
    tokenUsage={1000} outputTokens={465} generationDurationMs={0} generationReliable={false}
  />);
  expect(screen.getByText('Reconnecting')).toBeTruthy();
  expect(container.querySelector('[data-running-status-meta]')?.textContent).not.toContain('token');
});

it('opens measured zero history and restores fallback across reliability and turn changes', () => {
  const props = {
    visible: true,
    status: 'Thinking',
    startedAt: 1,
    tokenUsage: 100,
    outputTokens: 0,
    generationDurationMs: 1000,
    generationReliable: true,
  };
  const { container, rerender } = render(<RunningStatusBar {...props} />);
  const trigger = () => container.querySelector('[data-running-status-meta] button');
  expect(trigger()).toBeNull();
  rerender(<RunningStatusBar {...props} generationDurationMs={2000} />);
  expect(trigger()).not.toBeNull();
  fireEvent.click(trigger()!);
  expect(screen.getByRole('dialog').textContent).not.toContain('—');
  fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));
  rerender(<RunningStatusBar {...props} generationDurationMs={2000} generationReliable={false} />);
  expect(trigger()).toBeNull();
  rerender(<RunningStatusBar {...props} startedAt={2} />);
  expect(trigger()).toBeNull();
  rerender(<RunningStatusBar {...props} startedAt={2} generationDurationMs={2000} />);
  expect(trigger()).not.toBeNull();
});

it.each([true, false])(
  'plan review preserves the collapsed indicator and suppresses a pinned panel (running=%s)',
  (visible) => {
    const props = {
      visible: true,
      status: 'Thinking',
      startedAt: Date.now(),
      tokenUsage: 100,
      outputTokens: 100,
      generationDurationMs: 1000,
    };
    const indicator = <button aria-label="Controlled session">Device</button>;
    const { container, rerender } = render(
      <RunningStatusBar {...props} rightLeadingSlot={indicator} />,
    );
    fireEvent.click(container.querySelector('[data-running-status-meta] button')!);
    expect(screen.getByRole('button', { name: 'titleBar.close' })).toBeTruthy();

    rerender(
      <RunningStatusBar
        {...props}
        visible={visible}
        suppressContent
        rightLeadingSlot={indicator}
      />,
    );
    expect(screen.getByRole('button', { name: 'Controlled session' })).toBeTruthy();
    expect(container.querySelector('[data-running-status-meta]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'titleBar.close' })).toBeNull();

    // Explicit suppression without an independent indicator leaves no row behind.
    rerender(<RunningStatusBar {...props} visible={visible} suppressContent />);
    expect(container.childElementCount).toBe(0);
  },
);
