/**
 * handoffReceipt id 约定单测 —— send_to_session 完成回执的幂等 clientId 契约。
 *
 * 测试价值
- 生产入口与可观察结果：handoffReceiptInputClientId / parseHandoffReceiptInputClientId /
  handoffReceiptDoneClientId 是 main（register.ts 拦截层 + sessionEventPreparation 完成钩子）
  与回投模块共用的对外协议;解析错误会把任意任务的输入误判成回执请求,把回执投给错误任务。
- Bug／规则依据：docs/dev-rules/protocol-compatibility.md「send_to_session 完成回执」
  (本 PR 新增章节);前缀互斥(`handoff-receipt:` vs `handoff-receipt-done:`)是循环抑制的
  唯一保证。
- 现有覆盖缺口：全新协议常量,无相邻测试。
- 最小失败输入：dispatcherSessionId 含 `:`(IM 确定性 id)必须拒绝,否则回投时解析错位;
  done 前缀输入若被 parse 识别,回执会自我触发死循环。
- tier：unit(纯函数,无 IO)。
 */

import { describe, expect, it } from "vitest";

import {
  HANDOFF_RECEIPT_DONE_PREFIX,
  HANDOFF_RECEIPT_INPUT_PREFIX,
  handoffReceiptDoneClientId,
  handoffReceiptInputClientId,
  parseHandoffReceiptInputClientId,
} from "./handoffReceipt.js";

const NONCE = "0f0e0d0c-0b0a-4999-8999-990099887766";

describe("handoff receipt client ids", () => {
  it("round-trip: 生成→解析还原 dispatcher 与 nonce", () => {
    const clientId = handoffReceiptInputClientId("disp-1", NONCE);
    expect(clientId).toBe(`${HANDOFF_RECEIPT_INPUT_PREFIX}disp-1:${NONCE}`);
    expect(parseHandoffReceiptInputClientId(clientId)).toEqual({
      dispatcherSessionId: "disp-1",
      nonce: NONCE,
    });
  });

  it("dispatcher 含冒号或 nonce 非 uuid 时拒绝生成(IM 确定性 id 无法安全编码)", () => {
    expect(handoffReceiptInputClientId("im:abc123", NONCE)).toBeNull();
    expect(handoffReceiptInputClientId("", NONCE)).toBeNull();
    expect(handoffReceiptInputClientId("disp-1", "short")).toBeNull();
  });

  it("done 前缀与 input 前缀互不为前缀, 回执不会被完成钩子再识别(循环抑制)", () => {
    const doneId = handoffReceiptDoneClientId(NONCE);
    expect(doneId).toBe(`${HANDOFF_RECEIPT_DONE_PREFIX}${NONCE}`);
    expect(doneId.startsWith(HANDOFF_RECEIPT_INPUT_PREFIX)).toBe(false);
    expect(parseHandoffReceiptInputClientId(doneId)).toBeNull();
  });

  it("任意其他 clientId 解析为 null", () => {
    expect(
      parseHandoffReceiptInputClientId("bot-delegation-completion:x"),
    ).toBeNull();
    expect(parseHandoffReceiptInputClientId("random")).toBeNull();
  });
});
