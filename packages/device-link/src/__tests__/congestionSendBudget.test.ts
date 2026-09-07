import { describe, expect, it } from 'vitest';
import { CongestionSendBudget } from '../congestionSendBudget.js';

describe('relay congestion frame budget', () => {
  it('refunds unwritten frames without erasing the cost of a partial send', () => {
    const budget = new CongestionSendBudget();
    const peers = ['a', 'b'];
    expect(budget.take('a', 32, peers, 0)).toBe(true);
    budget.refund('a', 32);
    expect(budget.take('a', 32, peers, 0)).toBe(true);
    budget.refund('a', 30);
    expect(budget.take('b', 4, peers, 0)).toBe(true);
    expect(budget.take('a', 2, peers, 0)).toBe(true);
    expect(budget.take('a', 1, peers, 0)).toBe(false);
    expect(budget.take('b', 4, peers, 250)).toBe(true);
  });

  it('bounds combined peer bursts including repeated ACK-triggered passes', () => {
    const budget = new CongestionSendBudget();
    const peers = ['a', 'b'];
    let sent = 0;
    for (let i = 0; i < 100; i++) for (const peer of peers) sent += Number(budget.take(peer, 1, peers, 0));
    expect(sent).toBe(8);
    expect(budget.take('a', 1, peers, 249)).toBe(false);
    expect(budget.take('a', 1, peers, 250)).toBe(true);
  });

  it('reserves progress for another peer even when the first monopolizes callbacks', () => {
    const budget = new CongestionSendBudget();
    const peers = ['slow', 'healthy'];
    for (let i = 0; i < 100; i++) budget.take('slow', 1, peers, 0);
    expect(budget.take('healthy', 1, peers, 0)).toBe(true);
  });

  it('rotates more peers than available slots and oversized atomic heads', () => {
    const budget = new CongestionSendBudget();
    const peers = Array.from({ length: 12 }, (_, i) => String(i));
    const served = new Set<string>();
    for (let window = 0; window < 60; window++) {
      for (const peer of peers) if (budget.take(peer, 32, peers, window * 250)) served.add(peer);
    }
    expect(served.size).toBe(12);
  });

  it('does not starve a large response when small sends always run first', () => {
    const budget = new CongestionSendBudget();
    const peers = ['small', 'large'];
    let largeSent = 0;
    let smallSent = 0;
    for (let window = 0; window < 40; window++) {
      smallSent += Number(budget.take('small', 1, peers, window * 250));
      if (budget.take('large', 32, peers, window * 250)) largeSent += 32;
    }
    expect(largeSent).toBeGreaterThan(0);
    expect(smallSent).toBeGreaterThan(1);
    expect(largeSent + smallSent).toBeLessThanOrEqual(40 * 8 + 32);
  });

  it('resets a spent window when the host stops', () => {
    const budget = new CongestionSendBudget();
    expect(budget.take('a', 8, ['a'], 0)).toBe(true);
    expect(budget.take('a', 1, ['a'], 0)).toBe(false);
    budget.reset();
    expect(budget.take('a', 1, ['a'], 0)).toBe(true);
  });
});
