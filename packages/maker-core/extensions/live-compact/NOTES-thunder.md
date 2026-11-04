# 已移除的 thunder 路径备用说明

`index.ts` 里原有一段「阈压缩触发的 send-less 摘要」(thunder) 代码,默认
`SPINE_THUNDER != 1` 永不执行,也从未实测;为让随每个会话写盘的扩展保持精简,
2026-11-04 把它从产物里移出,原文存档在这里。

恢复时需要的四处(缺一不可):

1. `generateSummaryWithUsage` 的 import(在 `@earendil-works/pi-coding-agent` 具名导出里);
2. `decideThunder` / `buildSendLess` / `thunderModel` 等函数;
3. `SpineState.lastPrefix` + `lastPrefixTokens` 两个字段(每刀记录前缀快照);
4. `pi.on("session_before_compact", ...)` handler 与 settle 分支里的 thunder 判定。

注意:pi 的 `generateSummaryWithUsage` 签名会随版本变化,恢复前先按当时版本的
类型签名核对,不要直接粘回。

## 原文

```ts
  // [thunder 已注释] generateSummaryWithUsage 只被 session_before_compact 用。
  // generateSummaryWithUsage,

// [死代码,已注释] 原仓 DSH 的模型压缩路由;本仓切割直接用 buildCard verdict,不经过这里。
// function compactionRoute(plan: any) {
//   const chars = Math.max(1, plan?.chars || 0);
//   const uncovered = plan?.uncovered?.length || 0;
//   const proseRatio = uncovered / chars;
//   if (uncovered >= 20000 && proseRatio >= 0.5) return "wait-80";
//   if (uncovered < 20000 && proseRatio < 0.2) return "local";
//   return "wait-80";
// }


// [死代码,已注释] 原仓 DSH 的模型压缩路由;本仓切割直接用 buildCard verdict,不经过这里。
// function planMessages(messages: any[]) {
//   const covered: any[] = [];
//   const uncovered: any[] = [];
//   const shortUsers: any[] = [];
//   let chars = 0;
//   let codeLines = 0;
//   for (const message of messages) {
//     const text = messageText(message);
//     chars += text.length;
//     const role = message?.role ?? message?.message?.role;
//     if (role === "user" && text.length > 0 && text.length <= 280 && !text.startsWith(MARK)) {
//       shortUsers.push(text.trim());
//       continue;
//     }
//     const split = planText(text);
//     covered.push(...split.covered);
//     codeLines += split.codeLines;
//     if (split.uncovered) uncovered.push(split.uncovered);
//   }
//   const unique = [...new Set(covered)];
//   const kept: any[] = [];
//   let used = 0;
//   let omitted = 0;
//   for (const line of unique) {
//     if (used + line.length > KEEP_BUDGET) {
//       omitted += 1;
//       continue;
//     }
//     kept.push(line);
//     used += line.length;
//   }
//   const prose = uncovered.join("\n");
//   const joined = (messages || []).map(messageText).join("\n");
//   const card = buildCard(joined, shortUsers.join("\n"));
//   return {
//     chars,
//     codeLines,
//     keptChars: card.keptChars,
//     omitted,
//     omittedHard: card.omittedHard,
//     deferred: card.deferred,
//     verdict: card.verdict,
//     hardLines: card.hardLines,
//     needsModel: compactionRoute({ chars, uncovered: prose }) !== "local",
//     route: compactionRoute({ chars, uncovered: prose }),
//     uncovered: prose,
//     text: [
//       card.text,
//       `Shadowed characters: ${chars}. Regex kept lines: ${kept.length}. Omitted over budget: ${omitted}.`,
//       "Short user messages:",
//       ...(shortUsers.length === 0 ? ["- (none)"] : shortUsers.map((line) => `- ${line}`)),
//     ].join("\n"),
//   };
// }

// ---------------------------------------------------------------------------
// thunder.js — verbatim from dsh-live-compact 1.0.1
// ---------------------------------------------------------------------------

// [thunder 已按审计注释] 阈压缩触发的 send-less 摘要路径,默认 SPINE_THUNDER!=1 永不执行且从未实测。恢复时同时恢复下面 session_before_compact handler、state.lastPrefix 与 generateSummaryWithUsage import。
// const PROSE_TOKEN_CAP = 32000;

// function sharedPrefixLength(previous: any, next: any) {
//   if (!previous || !next) return 0;
//   const limit = Math.min(previous.length, next.length);
//   let index = 0;
//   const step = 64;
//   while (index + step <= limit && previous.slice(index, index + step) === next.slice(index, index + step)) index += step;
//   while (index < limit && previous[index] === next[index]) index += 1;
//   return index;
// }

// function decideThunder({ previous, next, modelKind, prefixTokens, attachMaxTokens = 80000 }: any) {
//   if (!previous || !next) return "send-less";
//   const shared = sharedPrefixLength(previous, next);
//   const ratio = shared / Math.max(previous.length, 1);
//   if (ratio < 0.9) return "send-less";
//   if (modelKind === "27b" && (prefixTokens || 0) > attachMaxTokens) return "send-less";
//   return "attach";
// }

// function estimateProseTokens(text: any) {
//   const cjk = (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
//   return Math.ceil(cjk / 1.5 + (String(text).length - cjk) / 4);
// }

// function buildSendLess({ taskLine, uncovered, facts, proseTokens = PROSE_TOKEN_CAP }: any) {
//   const kept = (facts || []).filter(Boolean);
//   let prose = uncovered || "";
//   if (estimateProseTokens(prose) > proseTokens) {
//     let low = 0;
//     let high = prose.length;
//     while (low < high) {
//       const mid = Math.ceil((low + high) / 2);
//       if (estimateProseTokens(prose.slice(0, mid)) <= proseTokens) low = mid;
//       else high = mid - 1;
//     }
//     prose = prose.slice(0, low);
//   }
//   return [
//     taskLine || "Continue the current task.",
//     "Facts already copied locally:",
//     ...(kept.length ? kept.map((fact: any) => `- ${fact}`) : ["- (none)"]),
//     "Uncovered prose to summarize:",
//     prose || "(none)",
//   ].join("\n");
// }

// ---------------------------------------------------------------------------
// index.js — DSH engine ported onto the pi extension API
// ---------------------------------------------------------------------------


  // [死字段,已注释] 赋值后从未被读取。
  // source: any;

  // [thunder 已注释] 前缀快照只服务 decideThunder 的 attach 判据;注释后不再每刀拼接整个前缀。
  // lastPrefix: string;
  // lastPrefixTokens: number;

    // [thunder 已注释] 前缀快照只服务 decideThunder;注释后每刀不再拼接整个前缀(O(n))。
    // 原仓 rememberPrefix 在 commitSelectedSpan 之后:前缀是「切割后」的形态,
    // 下一轮 sharedPrefixLength 才会接近全匹配(attach)。写成切割前的全文会让
    // 切割后首轮 ratio 掉到 0.9 以下,误判 send-less。
//     state.lastPrefix = [
//       ...entries.slice(0, chunk.start).filter((entry) => entry.role !== "system").map((entry) => entry.text),
//       chunk.card.text,
//       ...entries.slice(chunk.end + 1).map((entry) => entry.text),
//     ].join("\n");
//     state.lastPrefixTokens = Math.max(0, before - chunk.tokens + (framedTokens ?? 0));
    // Runner REPLACES the draft list with whatever a handler returns; preserve
    // drafts proposed by earlier handlers (e.g. Cindy's subagent extension).

  // [thunder 已按审计注释] 默认 SPINE_THUNDER!=1 永不执行,且从未实测;保留原文便于恢复。
//   // Thunder path: only when the stock threshold compaction fires.
//   pi.on("session_before_compact", async (event: any, ctx: any) => {
//     if (process.env.SPINE_THUNDER !== "1") return undefined;
//     const state = stateFor(ctx);
//     const { preparation, customInstructions, signal } = event;
//     const messages = [...(preparation?.messagesToSummarize ?? []), ...(preparation?.turnPrefixMessages ?? [])];
//     if (!ctx.model) {
//       logLine(state, "thunder skipped: no active model; leaving the gate to default compaction");
//       return undefined;
//     }
//     let joined: string;
//     try {
//       // 必须与 state.lastPrefix 同构(原仓 summarize 里 joined === input.messages.map(messageText))。
//       // 用 serializeConversation 会得到完全不同的格式,sharedPrefixLength 恒为 0 → 永远 send-less。
//       joined = messages.map((message: any) => messageText(message)).join("\n");
//     } catch (error) {
//       logLine(state, `thunder serialize failed: ${error instanceof Error ? error.message : String(error)}`);
//       return undefined;
//     }
//     const mode = decideThunder({
//       previous: state.lastPrefix || "",
//       next: joined,
//       modelKind: process.env.SPINE_THUNDER_MODEL === "27b" ? "27b" : "flash",
//       prefixTokens: state.lastPrefixTokens || 0,
//     });
//     logLine(state, `thunder mode=${mode} prefixTokens=${state.lastPrefixTokens} spanChars=${joined.length}`);
//     if (mode === "attach") return undefined;

//     const users = messages.filter((message: any) => (message?.role ?? message?.message?.role) === "user");
//     const taskLine = messageText(users.at(-1) || messages.at(-1)).slice(0, 500);
//     const trunk = buildCard(joined, "");
//     const facts = [...new Set([...(trunk.hardLines || []), ...(trunk.missing || [])])];
//     const slim = buildSendLess({ taskLine, uncovered: trunk.uncovered, facts });
//     const slimMessages = [{ role: "user", content: [{ type: "text", text: slim }], timestamp: Date.now() }];

//     try {
//       const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(ctx.model);
//       if (!auth?.ok) {
//         logLine(state, "thunder skipped: auth unavailable; leaving the gate to default compaction");
//         return undefined;
//       }
//       const { text, usage } = await generateSummaryWithUsage(
//         slimMessages,
//         ctx.model,
//         preparation?.settings?.reserveTokens,
//         auth.apiKey,
//         auth.headers,
//         signal,
//         customInstructions,
//         preparation?.previousSummary,
//         ctx.thinkingLevel,
//       );
//       logLine(state, `thunder send-less summary ok usage=${usage?.totalTokens ?? "?"}`);
//       return {
//         compaction: {
//           summary: text,
//           firstKeptEntryId: preparation.firstKeptEntryId,
//           tokensBefore: preparation.tokensBefore,
//           usage,
//           details: { liveCompact: "thunder-send-less" },
//         },
//       };
//     } catch (error) {
//       logLine(state, `thunder send-less failed: ${error instanceof Error ? error.message : String(error)}`);
//       // Fall back to pi's default compaction.
//       return undefined;
//     }
//   });
```
