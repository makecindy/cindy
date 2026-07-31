import { afterEach, describe, expect, it, vi } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";

import type { Logger } from "../../interfaces/logger.js";
import { MakerContactsStore } from "../store.js";
import {
  createContactsSyncDelta,
  mergeContactsSyncStates,
} from "../sync/merge.js";
import { materializeContactsSyncState } from "../sync/materialize.js";
import {
  CONTACTS_SYNC_MAX_ROWS_PER_TABLE,
  isValidContactsSyncState,
} from "../sync/validation.js";
import { createEmptyContactsSyncState } from "../sync/types.js";

function noopLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

describe("contacts device sync", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function createStore(config?: { maxIdentityValueLen: number }): MakerContactsStore {
    const db = new DatabaseCtor(":memory:");
    databases.push(db);
    const store = new MakerContactsStore({ db, logger: noopLogger(), config });
    store.init();
    return store;
  }

  function stateOf(store: MakerContactsStore) {
    const state = store.readDeviceSyncState();
    expect(state).not.toBeNull();
    return state!;
  }

  function exchange(
    target: MakerContactsStore,
    source: MakerContactsStore,
  ): void {
    target.mergeDeviceSyncState(stateOf(source));
  }

  function failFtsRebuild(store: MakerContactsStore): () => void {
    const fts = (
      store as unknown as {
        fts: { rebuild: (docs: readonly unknown[]) => void };
      }
    ).fts;
    const original = fts.rebuild;
    fts.rebuild = () => {
      throw new Error("transient fts failure");
    };
    return () => {
      fts.rebuild = original;
    };
  }

  it("三台设备沿任意在线路径传播后最终一致", () => {
    const a = createStore();
    const b = createStore();
    const c = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    c.activateDeviceSync();

    const person = a.createContact({
      kind: "person",
      displayName: "林一",
      summary: "A 创建",
    });
    exchange(b, a);
    b.updateContact(person.id, { agentNotes: "B 补充" });
    exchange(c, b);
    c.appendEvent(person.id, { date: "2026-07-31", text: "C 记录事件" });

    exchange(a, c);
    exchange(b, a);
    exchange(c, b);

    for (const store of [a, b, c]) {
      const profile = store.getContact(person.id);
      expect(profile.summary).toBe("A 创建");
      expect(profile.agentNotes).toBe("B 补充");
      expect(profile.events.map((event) => event.text)).toContain("C 记录事件");
    }
    expect(stateOf(a)).toEqual(stateOf(b));
    expect(stateOf(b)).toEqual(stateOf(c));
  });

  it("接受小写映射扩展后仍在统一边界内的身份值", () => {
    const store = createStore();
    const contact = store.createContact({
      kind: "person",
      displayName: "Unicode Identity",
    });
    store.addIdentity(contact.id, {
      platform: "custom",
      value: "İ".repeat(320),
    });

    const state = store.activateDeviceSync();
    expect(state.identities[0]?.value.value.normalizedValue).toHaveLength(640);
    expect(isValidContactsSyncState(state)).toBe(true);
  });

  it("自定义身份长度配置不能放宽同步协议上限", () => {
    const store = createStore({ maxIdentityValueLen: 400 });
    const contact = store.createContact({
      kind: "person",
      displayName: "Configured Identity Limit",
    });

    expect(() =>
      store.addIdentity(contact.id, {
        platform: "custom",
        value: "x".repeat(321),
      }),
    ).toThrow("identity value too long (> 320)");
  });

  it("状态合并保持幂等、交换和结合", () => {
    const stores = [createStore(), createStore(), createStore()];
    for (const store of stores) store.activateDeviceSync();
    stores[0]!.createContact({ kind: "person", displayName: "A" });
    stores[1]!.createContact({ kind: "person", displayName: "B" });
    stores[2]!.createContact({ kind: "org", displayName: "C" });
    const [a, b, c] = stores.map(stateOf);

    expect(mergeContactsSyncStates(a!, a!)).toEqual(a);
    expect(mergeContactsSyncStates(a!, b!)).toEqual(
      mergeContactsSyncStates(b!, a!),
    );
    expect(
      mergeContactsSyncStates(mergeContactsSyncStates(a!, b!), c!),
    ).toEqual(mergeContactsSyncStates(a!, mergeContactsSyncStates(b!, c!)));
  });

  it("已知对端版本后只发送缺失记录，增量合并结果与全量一致", () => {
    const a = createStore();
    const b = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    const first = a.createContact({ kind: "person", displayName: "已同步" });
    const untouched = a.createContact({
      kind: "org",
      displayName: "未修改组织",
    });
    exchange(b, a);
    const bBefore = stateOf(b);

    a.updateContact(first.id, { summary: "只改这一条" });
    const aAfter = stateOf(a);
    const delta = createContactsSyncDelta(aAfter, bBefore.clocks);

    expect(delta.contacts.map((contact) => contact.id)).toEqual([first.id]);
    expect(delta.contacts.some((contact) => contact.id === untouched.id)).toBe(
      false,
    );
    expect(mergeContactsSyncStates(bBefore, delta)).toEqual(
      mergeContactsSyncStates(bBefore, aAfter),
    );
  });

  it("并发修改不同字段不会整张档案互相覆盖", () => {
    const a = createStore();
    const b = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    const person = a.createContact({ kind: "person", displayName: "并发测试" });
    exchange(b, a);

    a.updateContact(person.id, { summary: "来自 A 的简介" });
    b.updateContact(person.id, { agentNotes: "来自 B 的提醒" });
    exchange(a, b);
    exchange(b, a);

    expect(a.getContact(person.id).summary).toBe("来自 A 的简介");
    expect(a.getContact(person.id).agentNotes).toBe("来自 B 的提醒");
    expect(b.getContact(person.id)).toMatchObject({
      summary: "来自 A 的简介",
      agentNotes: "来自 B 的提醒",
    });
  });

  it("删除胜过离线设备的并发旧档修改，不会复活联系人", () => {
    const a = createStore();
    const b = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    const person = a.createContact({ kind: "person", displayName: "待删除" });
    exchange(b, a);

    a.deleteContact(person.id);
    b.updateContact(person.id, { summary: "离线期间修改" });
    exchange(a, b);
    exchange(b, a);

    expect(() => a.getContact(person.id)).toThrow(/not-found/);
    expect(() => b.getContact(person.id)).toThrow(/not-found/);
  });

  it("重复投递幂等，同一身份冲突在不同设备选择相同赢家", () => {
    const a = createStore();
    const b = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    a.createContact({
      kind: "person",
      displayName: "甲",
      identities: [{ platform: "email", value: "same@example.com" }],
    });
    b.createContact({
      kind: "person",
      displayName: "乙",
      identities: [{ platform: "email", value: "same@example.com" }],
    });

    const aState = stateOf(a);
    expect(b.mergeDeviceSyncState(aState)).toBe(true);
    expect(b.mergeDeviceSyncState(aState)).toBe(false);
    exchange(a, b);

    const aHit = a.resolve("same@example.com");
    const bHit = b.resolve("same@example.com");
    expect(aHit).toHaveLength(1);
    expect(bHit).toHaveLength(1);
    expect(aHit[0]!.profile.id).toBe(bHit[0]!.profile.id);
    expect(a.listContacts({ status: "pending" })).toHaveLength(2);
    expect(b.listContacts({ status: "pending" })).toHaveLength(2);
  });

  it("FTS 重建失败后重复接收相同状态仍会重试", () => {
    const a = createStore();
    const b = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    const person = a.createContact({ kind: "person", displayName: "旧名称" });
    exchange(b, a);
    a.updateContact(person.id, { displayName: "同步后的新名称" });
    const remote = stateOf(a);

    const restore = failFtsRebuild(b);
    expect(b.mergeDeviceSyncState(remote)).toBe(true);
    restore();
    expect(b.getContact(person.id).displayName).toBe("同步后的新名称");
    expect(b.search("同步后的新名称")).toHaveLength(0);

    expect(b.mergeDeviceSyncState(remote)).toBe(false);
    expect(b.search("同步后的新名称")[0]?.contactId).toBe(person.id);
  });

  it("启动检查能识别行数相同但内容陈旧的 FTS", () => {
    const a = createStore();
    const b = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    const person = a.createContact({
      kind: "person",
      displayName: "启动前旧名称",
    });
    exchange(b, a);
    a.updateContact(person.id, { displayName: "启动后应恢复名称" });

    const restore = failFtsRebuild(b);
    expect(b.mergeDeviceSyncState(stateOf(a))).toBe(true);
    restore();
    const db = databases.at(-1)!;
    expect(db.prepare(`SELECT COUNT(*) AS count FROM contacts`).get()).toEqual({
      count: 1,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM contacts_fts`).get(),
    ).toEqual({ count: 1 });

    const restarted = new MakerContactsStore({ db, logger: noopLogger() });
    restarted.init();
    expect(restarted.search("启动后应恢复名称")[0]?.contactId).toBe(person.id);
  });

  it("worker 合并在 FTS 重建失败时原子回滚主表和同步状态", () => {
    const a = createStore();
    const b = createStore();
    a.prepareDeviceSyncStateForTransfer();
    b.prepareDeviceSyncStateForTransfer();
    const person = a.createContact({
      kind: "person",
      displayName: "必须原子落库",
    });
    const remote = a.prepareDeviceSyncStateForTransfer().state;

    const restore = failFtsRebuild(b);
    expect(() => b.mergeDeviceSyncStateForTransfer(remote)).toThrow(
      /transient fts failure/,
    );
    restore();
    expect(b.listContacts()).toHaveLength(0);

    expect(b.mergeDeviceSyncStateForTransfer(remote)).toBe(true);
    expect(b.search("必须原子落库")[0]?.contactId).toBe(person.id);
  });

  it("分组成员移出后可以重新加入，并把后续再次移出同步给其他设备", () => {
    const a = createStore();
    const b = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    const person = a.createContact({ kind: "person", displayName: "分组成员" });
    const group = a.createGroup("项目组");
    a.addToGroup(group.id, [person.id]);
    exchange(b, a);

    a.removeFromGroup(group.id, [person.id]);
    exchange(b, a);
    expect(b.getContact(person.id).groups).toEqual([]);

    b.addToGroup(group.id, [person.id]);
    exchange(a, b);
    expect(a.getContact(person.id).groups.map((item) => item.id)).toEqual([
      group.id,
    ]);

    a.removeFromGroup(group.id, [person.id]);
    exchange(b, a);
    expect(b.getContact(person.id).groups).toEqual([]);
  });

  it("保留仅大小写不同的合法分组及各自成员", () => {
    const a = createStore();
    const b = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    const person = a.createContact({ kind: "person", displayName: "分组成员" });
    const upper = a.createGroup("A");
    const lower = a.createGroup("a");
    a.addToGroup(upper.id, [person.id]);
    a.addToGroup(lower.id, [person.id]);

    exchange(b, a);

    expect(b.listGroups().map((group) => group.name)).toEqual(["A", "a"]);
    expect(
      b
        .getContact(person.id)
        .groups.map((group) => group.name)
        .sort(),
    ).toEqual(["A", "a"]);
  });

  it("本地赢家改名后无需对端回包也会重新物化此前隐藏的分组", () => {
    const a = createStore();
    const b = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    a.createGroup("并发同名");
    b.createGroup("并发同名");

    exchange(a, b);
    exchange(b, a);
    expect(a.listGroups()).toHaveLength(1);
    expect(b.listGroups()).toHaveLength(1);

    const visibleWinner = a.listGroups()[0]!;
    a.updateGroup(visibleWinner.id, { name: "赢家已改名" });
    const ftsRebuild = vi.spyOn(
      (a as unknown as { fts: { rebuild: (docs: readonly unknown[]) => void } })
        .fts,
      "rebuild",
    );
    stateOf(a);
    expect(ftsRebuild).toHaveBeenCalledTimes(1);
    expect(
      a
        .listGroups()
        .map((group) => group.name)
        .sort(),
    ).toEqual(["并发同名", "赢家已改名"]);
  });

  it("本地赢家删除后无需对端回包也会重新物化此前隐藏的分组", () => {
    const a = createStore();
    const b = createStore();
    a.activateDeviceSync();
    b.activateDeviceSync();
    a.createGroup("并发同名");
    b.createGroup("并发同名");
    exchange(a, b);
    exchange(b, a);

    const visibleWinner = a.listGroups()[0]!;
    a.deleteGroup(visibleWinner.id);
    stateOf(a);

    expect(a.listGroups()).toHaveLength(1);
    expect(a.listGroups()[0]).toMatchObject({ name: "并发同名" });
    expect(a.listGroups()[0]!.id).not.toBe(visibleWinner.id);
  });

  it("同步接受并保留本地合法的长关系备注", () => {
    const a = createStore();
    const b = createStore();
    const person = a.createContact({ kind: "person", displayName: "成员" });
    const org = a.createContact({ kind: "org", displayName: "组织" });
    const note = "长".repeat(16_385);
    a.addRelation(person.id, { toId: org.id, relation: "任职", note });
    a.activateDeviceSync();
    b.activateDeviceSync();

    expect(isValidContactsSyncState(stateOf(a))).toBe(true);
    exchange(b, a);
    expect(b.getContact(person.id).relations[0]?.note).toBe(note);
  });

  it("同步接受本地未设长度上限的身份、事件与分组文本", () => {
    const a = createStore();
    const b = createStore();
    const label = "标".repeat(1_001);
    const identityNote = "注".repeat(10_001);
    const eventSource = "源".repeat(1_001);
    const groupDescription = "组".repeat(16_385);
    const person = a.createContact({
      kind: "person",
      displayName: "长字段成员",
      identities: [
        {
          platform: "email",
          value: "long-fields@example.com",
          label,
          note: identityNote,
        },
      ],
    });
    a.appendEvent(person.id, {
      date: "2026-07-31",
      text: "长来源事件",
      source: eventSource,
    });
    const group = a.createGroup("长描述组", groupDescription);
    a.activateDeviceSync();
    b.activateDeviceSync();

    expect(isValidContactsSyncState(stateOf(a))).toBe(true);
    exchange(b, a);
    const synced = b.getContact(person.id);
    expect(synced.identities[0]).toMatchObject({ label, note: identityNote });
    expect(synced.events[0]?.source).toBe(eventSource);
    expect(
      b.listGroups().find((candidate) => candidate.id === group.id)
        ?.description,
    ).toBe(groupDescription);
  });

  it("联系人合并产生超过默认上限的合法身份后仍可激活并重读同步状态", () => {
    const store = createStore();
    const identities = (prefix: string) =>
      Array.from({ length: 30 }, (_, index) => ({
        platform: "email",
        value: `${prefix}-${index}@example.com`,
      }));
    const target = store.createContact({
      kind: "person",
      displayName: "目标联系人",
      identities: identities("target"),
    });
    const source = store.createContact({
      kind: "person",
      displayName: "来源联系人",
      identities: identities("source"),
    });
    store.merge(target.id, source.id);
    expect(store.getContact(target.id).identities).toHaveLength(60);

    store.activateDeviceSync();
    expect(stateOf(store).identities).toHaveLength(60);
    expect(store.getContact(target.id).identities).toHaveLength(60);
  });

  it("首次激活会纳入已有数据，之后能补记未经过 facade 的崩溃窗口写入", () => {
    const store = createStore();
    const person = store.createContact({
      kind: "person",
      displayName: "激活前已有",
    });
    const initial = store.activateDeviceSync();
    expect(initial.contacts.some((contact) => contact.id === person.id)).toBe(
      true,
    );

    const db = databases[0]!;
    db.prepare(
      `UPDATE contacts SET summary = ?, updated_at = ? WHERE id = ?`,
    ).run("直接写入后的恢复", "2026-07-31T12:00:00.000Z", person.id);
    const repaired = stateOf(store);
    const synced = repaired.contacts.find(
      (contact) => contact.id === person.id,
    );
    expect(synced?.summary.value).toBe("直接写入后的恢复");
  });

  it("深度校验拒绝畸形远端状态且不改本地数据", () => {
    const store = createStore();
    store.activateDeviceSync();
    const person = store.createContact({
      kind: "person",
      displayName: "安全边界",
    });
    const before = stateOf(store);
    const poisoned = structuredClone(before) as unknown as {
      identities: Array<{ id: string; value: { value: unknown } }>;
    };
    poisoned.identities.push({
      id: "bad",
      value: { value: { contactId: person.id, platform: {}, value: "x" } },
    });

    expect(() => store.mergeDeviceSyncState(poisoned)).toThrow(
      /invalid contacts sync state/,
    );
    expect(store.getContact(person.id).displayName).toBe("安全边界");
    expect(stateOf(store)).toEqual(before);
  });

  it("合法状态合并后超出 clock 上限时在持久化前拒绝", () => {
    const store = createStore();
    store.activateDeviceSync();
    store.createContact({ kind: "person", displayName: "本地联系人" });
    const before = stateOf(store);
    const remote = {
      ...createEmptyContactsSyncState(),
      clocks: Array.from({ length: 256 }, (_, index) => ({
        nodeId: `remote-${index}`,
        counter: 1,
      })),
    };
    expect(isValidContactsSyncState(remote)).toBe(true);

    expect(() => store.mergeDeviceSyncState(remote)).toThrow(
      /merged contacts sync state exceeds limits/,
    );
    expect(stateOf(store)).toEqual(before);
  });

  it("首次激活捕获超限本地表时回滚且不留下损坏状态", () => {
    const store = createStore();
    const person = store.createContact({
      kind: "person",
      displayName: "超限联系人",
    });
    const db = databases.at(-1)!;
    db.prepare(
      `WITH RECURSIVE seq(n) AS (
         SELECT 1
         UNION ALL
         SELECT n + 1 FROM seq WHERE n < ?
       )
       INSERT INTO contact_events(id, contact_id, date, text, source, created_at)
       SELECT 'event-' || n, ?, '2026-07-31', '事件', '', '2026-07-31T00:00:00.000Z'
       FROM seq`,
    ).run(CONTACTS_SYNC_MAX_ROWS_PER_TABLE + 1, person.id);

    expect(() => store.activateDeviceSync()).toThrow(
      /contacts sync state exceeds limits/,
    );
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM contacts_sync_state`).get(),
    ).toEqual({ count: 0 });

    db.prepare(`DELETE FROM contact_events`).run();
    expect(store.activateDeviceSync().events).toHaveLength(0);
  });

  it("同 stamp 的异常值按规范化 JSON 裁决，不受对象 key 顺序影响", () => {
    const stamp = { counter: 1, nodeId: "node-a" };
    const left = {
      ...createEmptyContactsSyncState(),
      clocks: [{ nodeId: "node-a", counter: 1 }],
      groups: [
        {
          id: "same-group",
          value: {
            stamp,
            value: { name: "A", description: "", createdAt: "2026-01-01" },
          },
        },
      ],
    };
    const right = {
      ...createEmptyContactsSyncState(),
      clocks: [{ nodeId: "node-a", counter: 1 }],
      groups: [
        {
          id: "same-group",
          value: {
            stamp,
            value: { createdAt: "2026-01-01", description: "", name: "Z" },
          },
        },
      ],
    };

    expect(
      materializeContactsSyncState(mergeContactsSyncStates(left, right))
        .groups[0]?.name,
    ).toBe("Z");
    expect(
      materializeContactsSyncState(mergeContactsSyncStates(right, left))
        .groups[0]?.name,
    ).toBe("Z");
  });

  it("深度校验要求 clocks 覆盖全部内容 stamp", () => {
    const store = createStore();
    store.activateDeviceSync();
    const person = store.createContact({
      kind: "person",
      displayName: "时钟覆盖",
    });
    stateOf(store);
    store.updateContact(person.id, { summary: "第二次写入" });
    const state = stateOf(store);
    expect(isValidContactsSyncState(state)).toBe(true);

    const poisoned = structuredClone(state);
    const nodeId = poisoned.contacts[0]!.summary.stamp.nodeId;
    const clock = poisoned.clocks.find((entry) => entry.nodeId === nodeId)!;
    clock.counter = poisoned.contacts[0]!.summary.stamp.counter - 1;
    expect(clock.counter).toBeGreaterThan(0);
    expect(isValidContactsSyncState(poisoned)).toBe(false);
  });

  it("磁盘 projection 对每张表执行行数上限", () => {
    const store = createStore();
    store.activateDeviceSync();
    const db = databases.at(-1)!;
    const projection = {
      contacts: new Array(CONTACTS_SYNC_MAX_ROWS_PER_TABLE + 1).fill(null),
      identities: [],
      events: [],
      groups: [],
      memberships: [],
      relations: [],
    };
    db.prepare(
      `UPDATE contacts_sync_state SET projection_json = ? WHERE singleton = 1`,
    ).run(JSON.stringify(projection));

    expect(() => store.readDeviceSyncState()).toThrow(
      /stored contacts sync projection is invalid/,
    );
  });

  it("磁盘 projection 拒绝数组中的畸形行", () => {
    const store = createStore();
    store.activateDeviceSync();
    const db = databases.at(-1)!;
    const projection = {
      contacts: [42],
      identities: [],
      events: [],
      groups: [],
      memberships: [],
      relations: [],
    };
    db.prepare(
      `UPDATE contacts_sync_state SET projection_json = ? WHERE singleton = 1`,
    ).run(JSON.stringify(projection));

    expect(() => store.readDeviceSyncState()).toThrow(
      /stored contacts sync projection is invalid/,
    );
  });

  it("磁盘 projection 拒绝缺字段或重复 id 且不写入删除墓碑", () => {
    const store = createStore();
    const person = store.createContact({
      kind: "person",
      displayName: "不能被误删",
    });
    store.activateDeviceSync();
    const db = databases.at(-1)!;
    const before = db
      .prepare(`SELECT state_json FROM contacts_sync_state WHERE singleton = 1`)
      .get() as { state_json: string };

    const incompleteProjection = {
      contacts: [{ id: person.id }],
      identities: [],
      events: [],
      groups: [],
      memberships: [],
      relations: [],
    };
    db.prepare(
      `UPDATE contacts_sync_state SET projection_json = ? WHERE singleton = 1`,
    ).run(JSON.stringify(incompleteProjection));
    expect(() => store.readDeviceSyncState()).toThrow(
      /stored contacts sync projection is invalid/,
    );
    expect(
      (
        db
          .prepare(
            `SELECT state_json FROM contacts_sync_state WHERE singleton = 1`,
          )
          .get() as { state_json: string }
      ).state_json,
    ).toBe(before.state_json);

    const validProjection = {
      contacts: [
        {
          id: person.id,
          kind: "person",
          displayName: "不能被误删",
          aliases: [],
          summary: "",
          narrative: "",
          agentNotes: "",
          status: "confirmed",
          source: "manual",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      identities: [],
      events: [],
      groups: [],
      memberships: [],
      relations: [],
    };
    validProjection.contacts.push({ ...validProjection.contacts[0]! });
    db.prepare(
      `UPDATE contacts_sync_state SET projection_json = ? WHERE singleton = 1`,
    ).run(JSON.stringify(validProjection));
    expect(() => store.readDeviceSyncState()).toThrow(
      /stored contacts sync projection is invalid/,
    );
    expect(
      (
        db
          .prepare(
            `SELECT state_json FROM contacts_sync_state WHERE singleton = 1`,
          )
          .get() as { state_json: string }
      ).state_json,
    ).toBe(before.state_json);
  });
});
