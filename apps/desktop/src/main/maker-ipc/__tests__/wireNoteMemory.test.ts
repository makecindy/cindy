import { describe, expect, it } from 'vitest';

import { createWireNoteMemory } from '../wireNoteMemory';

const UI = '[UI language] zh-CN';
const PHONE = '[客户端说明] 手机';
const PC = '[客户端说明] 另一台电脑';

describe('wireNoteMemory', () => {
  it('sends every note the first time and nothing unchanged afterwards', () => {
    const memory = createWireNoteMemory();
    const first = memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE });
    expect(first.notes).toEqual({ 'ui-language': UI, 'client-environment': PHONE });
    first.commit();

    const second = memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE });
    expect(second.notes).toEqual({});
  });

  it('resends only the note whose content changed', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).commit();

    const switched = memory.plan('s1', { 'ui-language': UI, 'client-environment': PC });
    expect(switched.notes).toEqual({ 'client-environment': PC });
    switched.commit();
    expect(memory.plan('s1', { 'ui-language': UI, 'client-environment': PC }).notes).toEqual({});
  });

  it('remembers an absent note so its return is sent again', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).commit();
    const local = memory.plan('s1', { 'ui-language': UI, 'client-environment': null });
    expect(local.notes).toEqual({});
    local.commit();
    expect(memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).notes).toEqual({
      'client-environment': PHONE,
    });
  });

  it('does not treat an uncommitted (rejected) send as delivered', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI });
    expect(memory.plan('s1', { 'ui-language': UI }).notes).toEqual({ 'ui-language': UI });
  });

  it('resends everything when forced (handoff first turn) or after reset (compact / clear)', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).commit();

    expect(memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }, { force: true }).notes)
      .toEqual({ 'ui-language': UI, 'client-environment': PHONE });

    memory.reset('s1');
    expect(memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).notes)
      .toEqual({ 'ui-language': UI, 'client-environment': PHONE });
  });

  it('a reset during an in-flight send invalidates the earlier plan so the next turn resends everything', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).commit();
    // 第二轮内容没变 → 计划里什么都不发;发送在途时原生压缩触发 reset。
    const inFlight = memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE });
    expect(inFlight.notes).toEqual({});
    memory.reset('s1');
    inFlight.commit();
    // 旧计划不能把"已发过"写回:新上下文没看过说明,下一轮必须整体重发。
    expect(memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).notes)
      .toEqual({ 'ui-language': UI, 'client-environment': PHONE });
    // reset 之后新建的计划照常可以 commit。
    const fresh = memory.plan('s1', { 'ui-language': UI });
    fresh.commit();
    expect(memory.plan('s1', { 'ui-language': UI }).notes).toEqual({});
    // 另一个会话的 reset 不影响本会话的计划。
    const other = memory.plan('s1', { 'ui-language': UI, 'client-environment': PC });
    memory.reset('s2');
    other.commit();
    expect(memory.plan('s1', { 'ui-language': UI, 'client-environment': PC }).notes).toEqual({});
  });

  it('keeps sessions independent', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI }).commit();
    expect(memory.plan('s2', { 'ui-language': UI }).notes).toEqual({ 'ui-language': UI });
  });
});

// Unit / #7253: idle direct sends add only delivery context. They must not erase
// language/device deduplication already committed by the ordinary send path.
it('preserves other notes when an idle send commits only delivery context', () => {
  const memory = createWireNoteMemory();
  const notes = { 'ui-language': UI, 'task-delivery': 'Report final delivery' } as const;
  memory.plan('s1', notes).commit();
  memory.plan('s1', { 'task-delivery': notes['task-delivery'] }, { partial: true }).commit();
  expect(memory.plan('s1', notes).notes).toEqual({});
  memory.plan('s1', { 'task-delivery': notes['task-delivery'] }, { partial: true, force: true }).commit();
  expect(memory.plan('s1', notes).notes).toEqual({ 'ui-language': UI });
});
