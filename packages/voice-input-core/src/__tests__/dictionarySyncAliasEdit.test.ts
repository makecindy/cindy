/**
 * 用户编辑误识别写法时的同步语义。
 *
 * 别名删除不能只改本机投影：离线设备回来会把旧 alias map 合并回来。这里锁住
 * 计数下界删除语义的核心不变量：删除不复活、并发学习不丢失、改名不重复计数。
 */

import { describe, expect, it } from "vitest";

import {
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
import { isAliasRemovalMarkerKey } from "../dictionary-sync/alias-removal";

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
