/**
 * orcaAgentDisplay 归一 —— pi worker 必须显示成 Pi(π 图标 / "Pi" 标签),
 * 而不是被吞成 Claude(2026-07-30 orca 接 pi:worker 展示辅助漏 pi 的回归护栏)。
 */
import { describe, expect, it } from 'vitest';

import {
  normalizeOrcaDisplayAgentKind,
  orcaAgentLabel,
  orcaVendorForAgentKind,
} from '../orcaAgentDisplay';

describe('orcaAgentDisplay pi support', () => {
  it('normalizes pi to pi (not claude-code)', () => {
    expect(normalizeOrcaDisplayAgentKind('pi')).toBe('pi');
    expect(normalizeOrcaDisplayAgentKind('codex')).toBe('codex');
    expect(normalizeOrcaDisplayAgentKind('cc')).toBe('claude-code');
    expect(normalizeOrcaDisplayAgentKind('claude-code')).toBe('claude-code');
    expect(normalizeOrcaDisplayAgentKind('unknown')).toBe('claude-code');
  });

  it('labels pi as Pi and maps to the pi vendor mark', () => {
    expect(orcaAgentLabel('pi')).toBe('Pi');
    expect(orcaVendorForAgentKind('pi')).toBe('pi');
    expect(orcaAgentLabel('codex')).toBe('Codex');
    expect(orcaVendorForAgentKind('codex')).toBe('codex');
    expect(orcaAgentLabel('claude-code')).toBe('Claude');
    expect(orcaVendorForAgentKind('claude-code')).toBe('cc');
  });
});
