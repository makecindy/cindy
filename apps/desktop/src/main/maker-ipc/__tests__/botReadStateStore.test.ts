/**
 * The host read ledger merges reports from this computer's windows, the phone and other Macs.
 * Pure kernels only (the persisted layer is electron-store): reports arrive out of order and a
 * device that never saw a companion seeds it, so neither may rewind a position another advanced.
 */

import { expect, it } from 'vitest';

import { applyBotReadPositions, normalizeBotReadState, pruneBotReadPositions } from '../botReadStateStore';

it('only moves positions forward and lets a seed fill only a missing position', () => {
  const current = { 'bot-1': 200, 'group:g': 100 };
  expect(applyBotReadPositions(current, { 'bot-1': 150, 'group:g': 300, 'bot-2': 50 }, 'mark')).toEqual({
    next: { 'bot-1': 200, 'group:g': 300, 'bot-2': 50 }, changed: ['group:g', 'bot-2'],
  });
  // A phone that just met bot-1 seeds "now"; the computer's older read position stays.
  expect(applyBotReadPositions(current, { 'bot-1': 900, 'thread:s': 400 }, 'seed')).toEqual({
    next: { 'bot-1': 200, 'group:g': 100, 'thread:s': 400 }, changed: ['thread:s'],
  });
  expect(applyBotReadPositions(current, { 'bot-1': 100 }, 'mark').next).toBe(current);
});

it('drops malformed reports without touching the rest', () => {
  expect(normalizeBotReadState({ 'bot-1': 10.7, 'bad id': 5, 'bot-2': -1, 'bot-3': Number.NaN, 'group:': 3, 'thread:t': '9' }))
    .toEqual({ 'bot-1': 10 });
});

it('prunes deleted companions and local groups only when that kind is listed, never topics', () => {
  const current = { 'bot-1': 1, 'bot-gone': 2, 'group:g': 3, 'group:gone': 4, 'thread:t': 5 };
  expect(pruneBotReadPositions(current, { botIds: ['bot-1'] })).toEqual({
    next: { 'bot-1': 1, 'group:g': 3, 'group:gone': 4, 'thread:t': 5 }, changed: ['bot-gone'],
  });
  expect(pruneBotReadPositions(current, { groupIds: ['g'] }).changed).toEqual(['group:gone']);
});
