import { expect, it } from 'vitest';
import { RoutineEventAdmission, ROUTINE_EVENT_LIMITS as limits } from '../routine-event-admission.js';

it('enforces global frequency and pending limits across distinct authenticated sources', () => {
  const admission = new RoutineEventAdmission();
  const releases = Array.from({ length: limits.pendingGlobal }, (_, i) => admission.acquire(`source-${i}`, 1000));
  expect(() => admission.acquire('another', 1000)).toThrow('busy');
  releases.forEach((release) => release());
  for (let i = releases.length; i < limits.global; i++) admission.acquire(`source-${i}`, 1000)();
  expect(() => admission.acquire('another', 1000)).toThrow('rate limit');
  expect(() => admission.acquire('another', 1000 + limits.windowMs)()).not.toThrow();
});
