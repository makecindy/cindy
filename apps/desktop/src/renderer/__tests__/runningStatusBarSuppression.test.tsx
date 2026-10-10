// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import ts from 'typescript';
import { responseSpeedActivity } from '@cindy/maker-shared/usage-format';
import { afterEach, expect, it, vi } from 'vitest';
import { formatSessionDuration } from '@/lib/sessionDurationFormat';
import {
  RunningTokenRatePopover,
  useRunningTokenRateHistory,
} from '@/features/cc-agent/RunningTokenRatePopover';
import {
  formatRecentOutputTokenRate,
  formatRunningTokenCount,
  resolveRunningUsageMeta,
} from '@/features/cc-agent/lib/runningTokenUsage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { value?: unknown; rate?: unknown }) => `${key}${values?.value ?? values?.rate ?? ''}`,
}) }));

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
  responseSpeedActivity,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTranslation: () => ({
    t: (key: string, values?: { value?: unknown; rate?: unknown }) => `${key}${values?.value ?? values?.rate ?? ''}`,
  }),
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
  formatSessionDuration,
};
const RunningStatusBar = new Function(
  'deps',
  `const {${Object.keys(deps).join(',')}} = deps; ${compiled}; return RunningStatusBar;`,
)(deps) as React.ComponentType<{
  visible: boolean;
  responseSpeed?: import('@cindy/maker-shared/usage-format').ResponseSpeedSnapshot;
  suppressContent?: boolean;
  rightLeadingSlot?: React.ReactNode;
  status: string;
  reconnectStatus?: string | null;
  startedAt: number | null;
  tokenUsage: number;
  outputTokens: number;
  generationDurationMs: number;
  generationActive?: boolean;
  generationReliable?: boolean;
}>;

afterEach(cleanup);

it('clears an older host recent interval immediately when native generation pauses, keeping history', () => {
  const props = { visible: true, status: 'Generating...', startedAt: Date.now(), tokenUsage: 0,
    outputTokens: 0, generationDurationMs: 0, generationReliable: true, generationActive: true };
  const view = render(<RunningStatusBar {...props} />);
  const measured = { ...props, outputTokens: 370, generationDurationMs: 1000 };
  view.rerender(<RunningStatusBar {...measured} />);
  const trigger = () => view.container.querySelector('[data-running-status-meta] button')!;
  expect(trigger().textContent).toContain('chat.runningStatus.tokenRate');
  fireEvent.click(trigger());
  view.rerender(<RunningStatusBar {...measured} generationActive={false} status="Running bash…" />);
  expect(trigger().textContent).not.toContain('chat.runningStatus.tokenRate');
  expect(screen.getByRole('dialog').textContent).toContain('370');
  expect(screen.getByRole('dialog').textContent).toContain('chat.runningStatus.observedPeak');
  view.rerender(<RunningStatusBar {...measured} generationActive />);
  expect(trigger().textContent).not.toContain('chat.runningStatus.tokenRate');
  view.rerender(<RunningStatusBar {...measured} generationActive outputTokens={470} generationDurationMs={2000} />);
  expect(trigger().textContent).toContain('chat.runningStatus.tokenRate');
});

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

it.each(['running', 'stopped', 'completed'] as const)(
  'plan review preserves the collapsed indicator and suppresses a pinned panel (%s)',
  (state) => {
    const visible = state === 'running';
    const responseSpeed = state === 'completed' ? {
      phase: 'complete' as const, waitOrigin: 'turn' as const, firstResponseMs: 1000, waitingMs: 0,
      durationMs: 1000, outputTokens: 100, estimated: false, averageRate: 100, recentRate: 100,
      samples: [{ durationMs: 1000, outputTokens: 100, rate: 100 }], sampledAt: Date.now(),
    } : undefined;
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
        responseSpeed={responseSpeed}
        suppressContent
        rightLeadingSlot={indicator}
      />,
    );
    expect(screen.getByRole('button', { name: 'Controlled session' })).toBeTruthy();
    expect(container.querySelector('[data-running-status-meta]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'titleBar.close' })).toBeNull();

    // Explicit suppression without an independent indicator leaves no row behind.
    rerender(<RunningStatusBar {...props} visible={visible} responseSpeed={responseSpeed} suppressContent />);
    expect(container.childElementCount).toBe(0);
  },
);

it('keeps the control indicator before completed speed metadata but leaves an idle row empty', () => {
  const props = { visible: false, status: 'Done', startedAt: null,
    tokenUsage: 0, outputTokens: 0, generationDurationMs: 0 };
  const view = render(<RunningStatusBar {...props} />);
  expect(view.container.childElementCount).toBe(0);
  const indicator = <button aria-label="Controlled session">Device</button>;
  view.rerender(<RunningStatusBar {...props} rightLeadingSlot={indicator} />);
  const control = screen.getByRole('button', { name: 'Controlled session' });
  expect(view.container.querySelector('[data-running-status-meta]')).toBeNull();
  view.rerender(<RunningStatusBar {...props} rightLeadingSlot={indicator}
    responseSpeed={{ phase: 'complete', waitOrigin: 'turn', firstResponseMs: 1000, waitingMs: 0,
      durationMs: 1000, outputTokens: 100, estimated: false, averageRate: 100, recentRate: 100,
      samples: [{ durationMs: 1000, outputTokens: 100, rate: 100 }], sampledAt: Date.now() }} />);
  const meta = view.container.querySelector('[data-running-status-meta]')!;
  expect(meta.textContent).toContain('chat.runningStatus.lastGeneration');
  expect(control.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(meta.querySelector('button')!);
  expect(screen.getByRole('dialog').textContent).toContain('chat.runningStatus.finalAverage');
});

it('retains a completed response after fade, navigation/remount, then replaces it at the next turn', () => {
  vi.useFakeTimers();
  try {
    const speed = { phase: 'complete', waitOrigin: 'turn', firstResponseMs: 2000, waitingMs: 0,
      durationMs: 4000, outputTokens: 300, estimated: false, averageRate: 75, recentRate: 75,
      samples: [{ durationMs: 1000, outputTokens: 100, rate: 100 }], sampledAt: Date.now() } as const;
    const props = { visible: false, status: 'Done', startedAt: null, tokenUsage: 500,
      outputTokens: 300, generationDurationMs: 4000, responseSpeed: { ...speed, samples: [...speed.samples] } };
    const view = render(<RunningStatusBar {...props} />);
    act(() => vi.advanceTimersByTime(60_000));
    const trigger = () => view.container.querySelector('[data-running-status-meta] button');
    expect(trigger()?.textContent).toContain('chat.runningStatus.lastGeneration');
    fireEvent.click(trigger()!);
    expect(screen.getByRole('dialog').textContent).toContain('chat.runningStatus.finalAverage');
    expect(screen.getByRole('dialog').textContent).toContain('75');
    view.unmount();
    const restored = render(<RunningStatusBar {...props} />);
    expect(restored.container.textContent).toContain('chat.runningStatus.lastGeneration');
    restored.rerender(<RunningStatusBar {...props} visible startedAt={Date.now()}
      responseSpeed={{ ...props.responseSpeed, phase: 'waiting', firstResponseMs: null, waitingMs: 0,
        outputTokens: 0, durationMs: 0, recentRate: null, averageRate: null, samples: [] }} />);
    expect(restored.container.textContent).not.toContain('chat.runningStatus.lastGeneration');
    expect(restored.container.textContent).toContain('chat.runningStatus.responseWaiting');
  } finally { vi.useRealTimers(); }
});

it('expires a stalled live rate while preserving an inspectable curve, and distinguishes tool pause', () => {
  vi.useFakeTimers();
  try {
    const speed = { phase: 'generating', waitOrigin: 'turn', firstResponseMs: 1000, waitingMs: 0,
      durationMs: 2000, outputTokens: 80, estimated: true, averageRate: 40, recentRate: 370,
      samples: [{ durationMs: 2000, outputTokens: 80, rate: 370 }], sampledAt: Date.now() } as const;
    const props = { visible: true, status: 'Generating...', startedAt: Date.now(), tokenUsage: 500,
      outputTokens: 0, generationDurationMs: 0, responseSpeed: { ...speed, samples: [...speed.samples] } };
    const view = render(<RunningStatusBar {...props} />);
    fireEvent.click(view.container.querySelector('[data-running-status-meta] button')!);
    expect(screen.getByRole('dialog').textContent).toContain('chat.runningStatus.currentRate');
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('dialog').textContent).toContain('chat.runningStatus.responsePending');
    expect(view.container.querySelector('[data-running-status-meta] button')?.textContent)
      .not.toContain('chat.runningStatus.estimatedTokenRate');
    view.rerender(<RunningStatusBar {...props} status="Tool running"
      responseSpeed={{ ...props.responseSpeed, phase: 'paused', recentRate: null }} />);
    expect(screen.getByRole('dialog').textContent).toContain('chat.runningStatus.generationPaused');
    view.rerender(<RunningStatusBar {...props} status="Running bash…"
      responseSpeed={{ ...props.responseSpeed, phase: 'paused', toolActive: true, recentRate: null }} />);
    expect(view.container.textContent).toContain('chat.runningStatus.toolRunning');
    expect(screen.getByRole('dialog').textContent).toContain('chat.runningStatus.toolRunning');
    view.rerender(<RunningStatusBar {...props}
      responseSpeed={{ ...props.responseSpeed, phase: 'waiting', waitingMs: 1000, recentRate: null }} />);
    expect(view.container.textContent).toContain('chat.runningStatus.responsePending');
    expect(screen.getByRole('dialog').textContent).toContain('chat.runningStatus.responsePending');
  } finally { vi.useRealTimers(); }
});

it.each(['failed', 'cancelled', 'retrying'] as const)('shows %s consistently in the retained entry and card', (activity) => {
  const terminal = activity !== 'retrying';
  const key = activity === 'failed' ? 'responseFailed' : activity === 'cancelled' ? 'responseCancelled' : 'responseRetrying';
  const speed: import('@cindy/maker-shared/usage-format').ResponseSpeedSnapshot = {
    phase: terminal ? 'complete' : 'paused', waitOrigin: 'turn', firstResponseMs: 1000, waitingMs: 0,
    durationMs: 2000, outputTokens: 80, estimated: true, recentRate: null, averageRate: 40,
    samples: [{ durationMs: 2000, outputTokens: 80, rate: 40 }], sampledAt: Date.now(),
    ...(terminal ? { outcome: activity as 'failed' | 'cancelled' } : { retrying: true }),
  };
  const view = render(<RunningStatusBar visible={!terminal} status="Done" startedAt={null}
    tokenUsage={500} outputTokens={80} generationDurationMs={2000} responseSpeed={speed} />);
  const trigger = view.container.querySelector('[data-running-status-meta] button')!;
  expect(trigger.textContent).toContain(`chat.runningStatus.${key}`);
  expect(trigger.textContent).not.toContain('chat.runningStatus.tokenRate');
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog').textContent).toContain(`chat.runningStatus.${key}`);
  expect(screen.getByRole('dialog').textContent).not.toContain('chat.runningStatus.finalAverage');
  expect(screen.getByRole('dialog').textContent).toContain('40');
});
