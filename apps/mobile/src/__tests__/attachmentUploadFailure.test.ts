/**
 * 附件上传失败 → 界面文案(内部码换人话)的行为门。
 *
 * 保护的真实行为:锁屏 / 切走 App / 离开任务会让直连电脑的附件上传以
 * FILE_PEER_* 内部码失败,用户看到的是「中断 / 超时 / 电脑不可达」的可操作句子,
 * 而不是下划线常量;界面永远拿不到内部码原文。
 * 失效后果:用户面对 FILE_PEER_CANCELLED 无从判断该等、该重试还是该删附件,
 * 误以为是他自己的操作取消(用户主动取消不会走到这条失败回调)。
 */
import { describe, expect, it } from "vitest";

import { attachmentUploadFailureKey } from "@/session/attachmentUploadFailure";

describe("attachment upload failure copy", () => {
  it.each([
    ["FILE_PEER_CANCELLED", "composer.upload.interrupted"],
    ["FILE_PEER_TIMEOUT", "composer.upload.timeout"],
    ["FILE_PEER_UNAVAILABLE", "composer.upload.peerUnavailable"],
    // 同族内部码同样不外泄原文,统一按「中断」给可操作的一句话。
    ["FILE_PEER_CLOSED", "composer.upload.interrupted"],
    ["FILE_PEER_CHANGED", "composer.upload.interrupted"],
  ])("maps %s to user-facing copy", (code, key) => {
    expect(attachmentUploadFailureKey(new Error(code))).toBe(key);
    // 传输层也会以带前缀 / 带说明的 message 抛出,code 不在开头同样要认。
    expect(attachmentUploadFailureKey(new Error(`upload failed: ${code}`))).toBe(key);
    expect(attachmentUploadFailureKey(code)).toBe(key);
  });

  it("recognizes an Error carrying the code field", () => {
    const error = Object.assign(new Error("attachment upload stopped"), {
      code: "FILE_PEER_TIMEOUT",
    });
    expect(attachmentUploadFailureKey(error)).toBe("composer.upload.timeout");
  });

  it("leaves unrelated failures to the generic humanized copy", () => {
    expect(attachmentUploadFailureKey(new Error("NOT_CONNECTED not online within 1500ms"))).toBeNull();
    expect(attachmentUploadFailureKey(new Error(""))).toBeNull();
    expect(attachmentUploadFailureKey(undefined)).toBeNull();
  });
});
