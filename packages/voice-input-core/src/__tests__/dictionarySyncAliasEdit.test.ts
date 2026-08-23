/**
 * 用户编辑误识别写法时的同步语义。
 *
 * 别名删除不能只改本机投影：离线设备回来会把旧 alias map 合并回来。这里锁住
 * 计数下界删除语义的核心不变量：删除不复活、并发学习不丢失、改名不重复计数。
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOMBSTONE_TTL_MS,
  createEmptySyncState,
  createHlcClock,
  dictionaryTermKey,
  gcTombstones,
  isValidSyncState,
  listLiveIncarnations,
  materializeDictionary,
  mergeSyncStates,
  recordLearningEvent,
  renameTerm,
  replaceTermAliases,
} from "../dictionary-sync";
import {
  isAliasRemovalMarkerKey,
  parseAliasRemovalMarker,
} from "../dictionary-sync/alias-removal";

function learnedBase() {
  let state = createEmptySyncState();
  let clock = createHlcClock("node-a", 1_000);
  for (let round = 0; round < 4; round += 1) {
    const learned = recordLearningEvent(state, clock, {
      text: "Vibe Coding",
      aliases: round < 3 ? ["web coding"] : ["vibe coating"],
      stage: "entry",
      nowMs: 1_000 + round,
    });
    state = learned.state;
    clock = learned.clock;
  }
  return { state, clock };
}

describe("词典别名编辑", () => {
  it("完整替换别名集合，保留频次并把用户编辑认作手动词条", () => {
    const base = learnedBase();
    const edited = replaceTermAliases(base.state, base.clock, {
      termKey: "Vibe Coding",
      aliases: ["web coding", "Vibe Coder"],
      nowMs: 2_000,
    });

    const entry = materializeDictionary(edited.state).entries[0];
    expect(entry.frequency).toBe(4);
    expect(entry.source).toBe("manual");
    expect(entry.aliases.map((alias) => alias.text).sort()).toEqual([
      "Vibe Coder",
      "web coding",
    ]);
    expect(
      entry.aliases.find((alias) => alias.text === "web coding")?.count,
    ).toBe(3);
    expect(
      entry.aliases.find((alias) => alias.text === "Vibe Coder")?.count,
    ).toBe(1);
    expect(isValidSyncState(edited.state)).toBe(true);
  });

  it("离线设备带回旧状态时，被删别名不会复活", () => {
    const base = learnedBase();
    const edited = replaceTermAliases(base.state, base.clock, {
      termKey: "Vibe Coding",
      aliases: ["web coding"],
      nowMs: 2_000,
    });

    const merged = mergeSyncStates(edited.state, base.state);
    expect(
      materializeDictionary(merged).entries[0].aliases.map(
        (alias) => alias.text,
      ),
    ).toEqual(["web coding"]);
  });

  it("两台设备基于同一状态并发编辑时采用 add-wins，且词条频次不翻倍", () => {
    const base = learnedBase();
    const a = replaceTermAliases(base.state, createHlcClock("node-a", 3_000), {
      termKey: "Vibe Coding",
      aliases: ["web coding", "Vibe Coder"],
      nowMs: 3_000,
    });
    const b = replaceTermAliases(base.state, createHlcClock("node-b", 4_000), {
      termKey: "Vibe Coding",
      aliases: ["web coding", "vibe code in"],
      nowMs: 4_000,
    });

    const entry = materializeDictionary(mergeSyncStates(a.state, b.state))
      .entries[0];
    expect(entry.frequency).toBe(4);
    expect(entry.aliases.map((alias) => alias.text).sort()).toEqual([
      "Vibe Coder",
      "vibe code in",
      "web coding",
    ]);
  });

  it("删除别名不会吞掉离线设备并发产生的新学习证据", () => {
    const base = learnedBase();
    const edited = replaceTermAliases(base.state, base.clock, {
      termKey: "Vibe Coding",
      aliases: [],
      nowMs: 3_000,
    });
    const learned = recordLearningEvent(
      base.state,
      createHlcClock("node-b", 4_000),
      {
        text: "Vibe Coding",
        aliases: ["fresh alias"],
        stage: "entry",
        nowMs: 4_000,
      },
    );

    const entry = materializeDictionary(
      mergeSyncStates(edited.state, learned.state),
    ).entries[0];
    expect(entry.frequency).toBe(5);
    expect(entry.aliases.map((alias) => [alias.text, alias.count])).toEqual([
      ["fresh alias", 1],
    ]);
  });

  it("别名编辑与同目标改名并发时复用同一化身，不重复计算频次", () => {
    const base = learnedBase();
    const aliasesEdited = replaceTermAliases(base.state, base.clock, {
      termKey: "Vibe Coding",
      primaryText: "VibeCoder",
      aliases: ["web coding"],
      nowMs: 3_000,
    });
    const editedAndRenamed = renameTerm(
      aliasesEdited.state,
      aliasesEdited.clock,
      {
        termKey: "Vibe Coding",
        nextText: "VibeCoder",
        nowMs: 3_000,
      },
    );
    const directlyRenamed = renameTerm(
      base.state,
      createHlcClock("node-b", 4_000),
      {
        termKey: "Vibe Coding",
        nextText: "VibeCoder",
        nowMs: 4_000,
      },
    );

    const entry = materializeDictionary(
      mergeSyncStates(editedAndRenamed.state, directlyRenamed.state),
    ).entries[0];
    expect(entry.frequency).toBe(4);
    expect(entry.aliases.map((alias) => alias.text)).toEqual(["web coding"]);
  });

  it("别名删除与另一台设备改名并发时，删除意图跟随搬移后的化身", () => {
    const base = learnedBase();
    const aliasesEdited = replaceTermAliases(
      base.state,
      createHlcClock("node-a", 3_000),
      {
        termKey: "Vibe Coding",
        aliases: ["vibe coating"],
        nowMs: 3_000,
      },
    );
    const renamed = renameTerm(base.state, createHlcClock("node-b", 4_000), {
      termKey: "Vibe Coding",
      nextText: "VibeCoder",
      nowMs: 4_000,
    });

    const forward = mergeSyncStates(aliasesEdited.state, renamed.state);
    const backward = mergeSyncStates(renamed.state, aliasesEdited.state);
    expect(backward).toEqual(forward);
    expect(mergeSyncStates(forward, forward)).toEqual(forward);
    expect(materializeDictionary(forward).entries[0].text).toBe("VibeCoder");
    expect(
      materializeDictionary(forward).entries[0].aliases.map(
        (alias) => alias.text,
      ),
    ).toEqual(["vibe coating"]);

    const collected = gcTombstones(forward, { nowMs: 10_000, ttlMs: 0 });
    expect(
      materializeDictionary(collected).entries[0].aliases.map(
        (alias) => alias.text,
      ),
    ).toEqual(["vibe coating"]);
  });

  it("并发别名编辑可穿过连续改名链，并保持 merge 结合律", () => {
    const base = learnedBase();
    const aliasesEdited = replaceTermAliases(
      base.state,
      createHlcClock("node-a", 3_000),
      {
        termKey: "Vibe Coding",
        aliases: ["vibe coating"],
        nowMs: 3_000,
      },
    );
    const firstRename = renameTerm(
      base.state,
      createHlcClock("node-b", 4_000),
      {
        termKey: "Vibe Coding",
        nextText: "VibeCoder",
        nowMs: 4_000,
      },
    );
    const secondRename = renameTerm(firstRename.state, firstRename.clock, {
      termKey: "VibeCoder",
      nextText: "VC",
      nowMs: 5_000,
    });
    const concurrentlyLearned = recordLearningEvent(
      base.state,
      createHlcClock("node-c", 6_000),
      {
        text: "Vibe Coding",
        aliases: ["fresh alias"],
        stage: "entry",
        nowMs: 6_000,
      },
    );

    const left = mergeSyncStates(
      mergeSyncStates(aliasesEdited.state, secondRename.state),
      concurrentlyLearned.state,
    );
    const right = mergeSyncStates(
      aliasesEdited.state,
      mergeSyncStates(secondRename.state, concurrentlyLearned.state),
    );
    expect(left).toEqual(right);
    const entry = materializeDictionary(left).entries[0];
    expect(entry.text).toBe("VC");
    expect(entry.aliases.map((alias) => alias.text).sort()).toEqual([
      "fresh alias",
      "vibe coating",
    ]);
  });

  it("不同目标的并发改名与旧键学习不破坏 merge 结合律", () => {
    const base = learnedBase();
    const renamedGamma = renameTerm(
      base.state,
      createHlcClock("node-a", 3_000),
      {
        termKey: "Vibe Coding",
        nextText: "Gamma",
        nowMs: 3_000,
      },
    );
    const learned = recordLearningEvent(
      base.state,
      createHlcClock("node-b", 4_000),
      {
        text: "Vibe Coding",
        aliases: ["fresh alias"],
        stage: "entry",
        nowMs: 4_000,
      },
    );
    const renamedBeta = renameTerm(
      base.state,
      createHlcClock("node-c", 5_000),
      {
        termKey: "Vibe Coding",
        nextText: "Beta",
        nowMs: 5_000,
      },
    );

    const left = mergeSyncStates(
      mergeSyncStates(renamedGamma.state, learned.state),
      renamedBeta.state,
    );
    const right = mergeSyncStates(
      renamedGamma.state,
      mergeSyncStates(learned.state, renamedBeta.state),
    );
    expect(left).toEqual(right);
    expect(materializeDictionary(left)).toEqual(materializeDictionary(right));
  });

  it("连续修改别名不会凭空增加词条频次", () => {
    const base = learnedBase();
    const first = replaceTermAliases(base.state, base.clock, {
      termKey: "Vibe Coding",
      aliases: ["web coding"],
      nowMs: 2_000,
    });
    const second = replaceTermAliases(first.state, first.clock, {
      termKey: "Vibe Coding",
      aliases: ["Vibe Coder"],
      nowMs: 3_000,
    });

    const entry = materializeDictionary(second.state).entries[0];
    expect(entry.frequency).toBe(4);
    expect(entry.aliases.map((alias) => alias.text)).toEqual(["Vibe Coder"]);
  });

  it("删除下界跟随化身改名，旧版式的透明搬移不会让别名复活", () => {
    const base = learnedBase();
    const edited = replaceTermAliases(base.state, base.clock, {
      termKey: "Vibe Coding",
      aliases: ["web coding"],
      nowMs: 2_000,
    });
    const renamed = renameTerm(edited.state, edited.clock, {
      termKey: "Vibe Coding",
      nextText: "VibeCoder",
      nowMs: 3_000,
    });

    const record = renamed.state.records[dictionaryTermKey("VibeCoder")];
    const live = listLiveIncarnations(record);
    expect(
      live
        .flatMap((incarnation) => Object.keys(incarnation.aliases))
        .filter(isAliasRemovalMarkerKey),
    ).toHaveLength(1);
    expect(
      materializeDictionary(renamed.state).entries[0].aliases.map(
        (alias) => alias.text,
      ),
    ).toEqual(["web coding"]);
  });

  it("同一别名反复删加只更新固定删除槽，不按编辑次数增长", () => {
    let state = createEmptySyncState();
    let clock = createHlcClock("node-a", 1_000);
    const learned = recordLearningEvent(state, clock, {
      text: "内部代号",
      aliases: ["inside code"],
      stage: "entry",
      nowMs: 1_000,
    });
    state = learned.state;
    clock = learned.clock;

    for (let round = 0; round < 100; round += 1) {
      const removed = replaceTermAliases(state, clock, {
        termKey: "内部代号",
        aliases: [],
        nowMs: 2_000 + round * 2,
      });
      const restored = replaceTermAliases(removed.state, removed.clock, {
        termKey: "内部代号",
        aliases: ["inside code"],
        nowMs: 2_001 + round * 2,
      });
      state = restored.state;
      clock = restored.clock;
    }
    const removed = replaceTermAliases(state, clock, {
      termKey: "内部代号",
      aliases: [],
      nowMs: 3_000,
    });

    const record = removed.state.records[dictionaryTermKey("内部代号")];
    const aliases = listLiveIncarnations(record)[0].aliases;
    expect(Object.keys(aliases).filter(isAliasRemovalMarkerKey)).toHaveLength(
      1,
    );
    expect(Object.keys(aliases)).toHaveLength(2);
    expect(materializeDictionary(removed.state).entries[0].aliases).toEqual([]);
  });

  it("未到期的别名删除下界保持不动，到期后与原别名成组回收", () => {
    const base = learnedBase();
    const removed = replaceTermAliases(base.state, base.clock, {
      termKey: "Vibe Coding",
      aliases: [],
      nowMs: 2_000,
    });

    expect(
      gcTombstones(removed.state, {
        nowMs: 3_000,
        ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
      }),
    ).toBe(removed.state);

    const before = materializeDictionary(removed.state);
    const collected = gcTombstones(removed.state, {
      nowMs: 2_000 + DEFAULT_TOMBSTONE_TTL_MS + 1,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    expect(materializeDictionary(collected)).toEqual(before);
    const record = collected.records[dictionaryTermKey("Vibe Coding")];
    expect(Object.keys(listLiveIncarnations(record)[0].aliases)).toEqual([]);
  });

  it("过期前重新添加的别名不被回收，再次删除会刷新回收期限", () => {
    const base = learnedBase();
    const removed = replaceTermAliases(base.state, base.clock, {
      termKey: "Vibe Coding",
      aliases: [],
      nowMs: 2_000,
    });
    const restored = replaceTermAliases(removed.state, removed.clock, {
      termKey: "Vibe Coding",
      aliases: ["web coding"],
      nowMs: 3_000,
    });
    const collectedAfterFirstTtl = gcTombstones(restored.state, {
      nowMs: 2_000 + DEFAULT_TOMBSTONE_TTL_MS + 1,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    expect(
      materializeDictionary(collectedAfterFirstTtl).entries[0].aliases.map(
        (alias) => alias.text,
      ),
    ).toEqual(["web coding"]);

    const removedAgain = replaceTermAliases(restored.state, restored.clock, {
      termKey: "Vibe Coding",
      aliases: [],
      nowMs: 4_000,
    });
    const keptByRefreshedDeadline = gcTombstones(removedAgain.state, {
      nowMs: 2_000 + DEFAULT_TOMBSTONE_TTL_MS + 1,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    const keptRecord = keptByRefreshedDeadline.records[dictionaryTermKey("Vibe Coding")];
    const keptAliases = listLiveIncarnations(keptRecord)[0].aliases;
    expect(keptAliases["web coding"]).toBeDefined();
    expect(Object.keys(keptAliases).filter(isAliasRemovalMarkerKey)).toHaveLength(1);
    expect(materializeDictionary(keptByRefreshedDeadline).entries[0].aliases).toEqual([]);

    const collected = gcTombstones(removedAgain.state, {
      nowMs: 4_000 + DEFAULT_TOMBSTONE_TTL_MS + 1,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    const record = collected.records[dictionaryTermKey("Vibe Coding")];
    expect(Object.keys(listLiveIncarnations(record)[0].aliases)).toEqual([]);
  });

  it("同一别名的多节点删除下界到期后一起回收", () => {
    const base = learnedBase();
    const learnedOnB = recordLearningEvent(
      base.state,
      createHlcClock("node-b", 3_000),
      {
        text: "Vibe Coding",
        aliases: ["web coding"],
        stage: "entry",
        nowMs: 3_000,
      },
    );
    const removed = replaceTermAliases(learnedOnB.state, learnedOnB.clock, {
      termKey: "Vibe Coding",
      aliases: [],
      nowMs: 4_000,
    });
    const recordBefore = removed.state.records[dictionaryTermKey("Vibe Coding")];
    const aliasesBefore = listLiveIncarnations(recordBefore)[0].aliases;
    const webCodingMarkers = Object.entries(aliasesBefore).filter(
      ([aliasKey, alias]) =>
        parseAliasRemovalMarker(aliasKey, alias)?.aliasKey === "web coding",
    );
    expect(webCodingMarkers).toHaveLength(2);

    const collected = gcTombstones(removed.state, {
      nowMs: 4_000 + DEFAULT_TOMBSTONE_TTL_MS + 1,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    const recordAfter = collected.records[dictionaryTermKey("Vibe Coding")];
    expect(Object.keys(listLiveIncarnations(recordAfter)[0].aliases)).toEqual([]);
  });

  it("TTL 回收后同节点重加别名，旧副本的删除下界不会吞掉新值", () => {
    const base = learnedBase();
    const removed = replaceTermAliases(base.state, base.clock, {
      termKey: "Vibe Coding",
      aliases: [],
      nowMs: 2_000,
    });
    const collected = gcTombstones(removed.state, {
      nowMs: 2_000 + DEFAULT_TOMBSTONE_TTL_MS + 1,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    const restoredAt = 2_000 + DEFAULT_TOMBSTONE_TTL_MS + 2;
    const restored = replaceTermAliases(collected, removed.clock, {
      termKey: "Vibe Coding",
      aliases: ["web coding"],
      nowMs: restoredAt,
    });

    const mergedWithOldRemoval = mergeSyncStates(restored.state, removed.state);
    expect(
      materializeDictionary(mergedWithOldRemoval).entries[0].aliases.map(
        (alias) => [alias.text, alias.count],
      ),
    ).toEqual([["web coding", 1]]);

    const removedAgain = replaceTermAliases(
      mergedWithOldRemoval,
      restored.clock,
      {
        termKey: "Vibe Coding",
        aliases: [],
        nowMs: restoredAt + 1,
      },
    );
    expect(materializeDictionary(removedAgain.state).entries[0].aliases).toEqual([]);
    const beforeRefreshedTtl = gcTombstones(removedAgain.state, {
      nowMs: restoredAt + 2,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    const keptRecord = beforeRefreshedTtl.records[dictionaryTermKey("Vibe Coding")];
    const keptAliases = listLiveIncarnations(keptRecord)[0].aliases;
    expect(keptAliases["web coding"]).toBeDefined();
    expect(Object.keys(keptAliases).filter(isAliasRemovalMarkerKey)).toHaveLength(1);
    expect(materializeDictionary(beforeRefreshedTtl).entries[0].aliases).toEqual([]);

    const collectedAgain = gcTombstones(removedAgain.state, {
      nowMs: restoredAt + 1 + DEFAULT_TOMBSTONE_TTL_MS + 1,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    const record = collectedAgain.records[dictionaryTermKey("Vibe Coding")];
    expect(Object.keys(listLiveIncarnations(record)[0].aliases)).toEqual([]);
  });

  it("连续替换为不同别名时，过期回收后状态只保留当前别名", () => {
    const base = learnedBase();
    let state = base.state;
    let clock = base.clock;
    for (let round = 0; round < 100; round += 1) {
      const edited = replaceTermAliases(state, clock, {
        termKey: "Vibe Coding",
        aliases: [`alias-${round}`],
        nowMs: 2_000 + round,
      });
      state = edited.state;
      clock = edited.clock;
    }

    const recordBefore = state.records[dictionaryTermKey("Vibe Coding")];
    expect(Object.keys(listLiveIncarnations(recordBefore)[0].aliases).length).toBeGreaterThan(100);

    const collected = gcTombstones(state, {
      nowMs: 2_099 + DEFAULT_TOMBSTONE_TTL_MS + 1,
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    const recordAfter = collected.records[dictionaryTermKey("Vibe Coding")];
    expect(Object.keys(listLiveIncarnations(recordAfter)[0].aliases)).toEqual(["alias-99"]);
    expect(materializeDictionary(collected).entries[0].aliases.map((alias) => alias.text)).toEqual([
      "alias-99",
    ]);
  });

  it("删除标记可承载点号、Unicode 别名和特殊节点身份", () => {
    const base = recordLearningEvent(
      createEmptySyncState(),
      createHlcClock("设备-😀", 1_000),
      {
        text: "产品代号",
        aliases: ["ACME.研发😀"],
        stage: "entry",
        nowMs: 1_000,
      },
    );
    const edited = replaceTermAliases(base.state, base.clock, {
      termKey: "产品代号",
      aliases: [],
      nowMs: 2_000,
    });

    expect(isValidSyncState(edited.state)).toBe(true);
    expect(
      materializeDictionary(mergeSyncStates(edited.state, base.state))
        .entries[0].aliases,
    ).toEqual([]);
  });

  it("改名到既有词条时保留目标别名，也允许把旧主词保存为别名", () => {
    const base = learnedBase();
    const target = recordLearningEvent(base.state, base.clock, {
      text: "VibeCoder",
      aliases: ["vibe coder old"],
      stage: "entry",
      nowMs: 2_000,
    });
    const aliasesEdited = replaceTermAliases(target.state, target.clock, {
      termKey: "Vibe Coding",
      primaryText: "VibeCoder",
      aliases: ["Vibe Coding", "vibe coder new"],
      nowMs: 3_000,
    });
    const renamed = renameTerm(aliasesEdited.state, aliasesEdited.clock, {
      termKey: "Vibe Coding",
      nextText: "VibeCoder",
      nowMs: 3_000,
    });

    const entry = materializeDictionary(renamed.state).entries[0];
    expect(entry.text).toBe("VibeCoder");
    expect(entry.frequency).toBe(5);
    expect(entry.aliases.map((alias) => alias.text).sort()).toEqual([
      "Vibe Coding",
      "vibe coder new",
      "vibe coder old",
    ]);
  });
});
