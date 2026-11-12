/**
 * 企业微信终稿的分项投递计划。
 * ---------------------------------------------------------------------------
 * 账本模型: **一个出站副作用一个步骤**。正文按渠道上限切好的每一段
 * 是一步(第一段可以复用本轮的流式消息), 每个附件各一步。宿主据此建立持久出箱,
 * 逐项记录结果、只补失败项。
 *
 * 媒体规则: 图片/音视频只来自 Cindy 媒体总仓(`cindy-media://` 或已解析的媒体
 * 路径); PDF/docx 等非媒体文件走受控文件通道, 并且**每次投递都重跑**允许根 +
 * realpath 校验 —— 出箱重放不能绕过路径安全。
 */
import path from "node:path";

import type {
  ImDeliveryState,
  ImFinalAttachmentStep,
  ImFinalDeliveryPlan,
  ImFinalDeliveryResult,
  ImFinalOutput,
  ImFinalStep,
  ImFinalTextStep,
} from "../channelIM.js";
import type { SendFileResult } from "../types.js";
import { DELIVERY_FAILURE } from "../safeLog.js";
import {
  collectXdtFileLinks,
  collectXdtImageUrls,
  stripXdtFileLinks,
  stripXdtImageLinks,
} from "../xdtRefs.js";
import { chunkWecomMarkdown } from "./codec.js";
import { resolveAllowedWecomOutboundFile } from "./media.js";

/** 企业微信单轮最多投递的附件数(与既有 commitFinal 的上限一致)。 */
export const MAX_TERMINAL_ATTACHMENTS = 4;
/** 正文只有附件时用这一行占位, 与旧行为一致。 */
export const ATTACHMENTS_ONLY_TEXT = "📎 附件如下";

export interface WecomDeliverySurface {
  userId: string;
  /** 连接可用时返回 true; false = 确定没发出去。 */
  isConnected: () => boolean;
  /**
   * 发第 index 段正文。index=0 时 transport 可以复用本轮流式消息(并收敛它);
   * 之后的段是独立的 markdown 消息。
   */
  sendTextChunk: (index: number, text: string) => Promise<unknown>;
  sendFile: (absPath: string, displayName?: string) => Promise<SendFileResult>;
  /** cindy-media 地址 → 本机绝对路径; 认不出返回 null。 */
  resolveMediaUrl?: (url: string) => string | null;
  log: { warn(message: string): void };
}

/**
 * 把终稿投影成可重放的投递计划。只做纯计算与受控根校验, 不发消息。
 */
export async function prepareWecomFinal(
  output: ImFinalOutput,
  surface: Pick<WecomDeliverySurface, "resolveMediaUrl" | "log">,
): Promise<ImFinalDeliveryPlan> {
  const attachments: ImFinalAttachmentStep[] = [];
  const seen = new Set<string>();
  let rejectedFiles = 0;
  let unresolvedImages = 0;
  let omitted = 0;

  const add = (attachment: ImFinalAttachmentStep): void => {
    if (seen.has(attachment.absPath)) return;
    seen.add(attachment.absPath);
    if (attachments.length >= MAX_TERMINAL_ATTACHMENTS) {
      omitted += 1;
      return;
    }
    attachments.push(attachment);
  };

  for (const link of collectXdtFileLinks(output.text)) {
    const resolved = await resolveAllowedWecomOutboundFile(
      link.absPath,
      output.allowedFileRoots ?? [],
    );
    if (!resolved) {
      rejectedFiles += 1;
      surface.log.warn("skipped terminal file attachment outside allowed roots");
      continue;
    }
    add({
      id: `file:${link.absPath}`,
      kind: "file",
      absPath: resolved,
      displayName: path.basename(link.alt || resolved),
    });
  }

  // 宿主解析过的本机文件(回答里的相对/绝对路径链接): 与 xdt-file 链接同样走文件
  // 通道, 并在这里**再校验一次**允许根 —— 不能因为来自宿主就跳过。
  for (const absPath of output.fileAbsPaths ?? []) {
    const resolved = await resolveAllowedWecomOutboundFile(
      absPath,
      output.allowedFileRoots ?? [],
    );
    if (!resolved) {
      rejectedFiles += 1;
      surface.log.warn("skipped host-resolved file attachment outside allowed roots");
      continue;
    }
    add({
      id: `file:${resolved}`,
      kind: "file",
      absPath: resolved,
      displayName: path.basename(resolved),
    });
  }

  for (const url of collectXdtImageUrls(output.text)) {
    const absPath = surface.resolveMediaUrl?.(url) ?? null;
    if (!absPath) {
      unresolvedImages += 1;
      surface.log.warn("failed to resolve terminal managed image");
      continue;
    }
    add({
      id: `image:${url}`,
      kind: "media",
      absPath,
      displayName: path.basename(absPath),
      url,
    });
  }

  for (const absPath of output.mediaAbsPaths ?? []) {
    if (!absPath) continue;
    add({
      id: `media:${absPath}`,
      kind: "media",
      absPath,
      displayName: path.basename(absPath),
    });
  }

  const notices = [
    omitted > 0
      ? `⚠️ 另有 ${omitted} 个附件未发送（企业微信单次最多发送 ${MAX_TERMINAL_ATTACHMENTS} 个）。`
      : "",
    rejectedFiles > 0
      ? `⚠️ 有 ${rejectedFiles} 个文件附件未发送（不在当前工作目录内或无法验证）。`
      : "",
    unresolvedImages > 0
      ? `⚠️ 有 ${unresolvedImages} 张图片未发送（图片已不存在或无法读取）。`
      : "",
  ].filter(Boolean);

  const visible =
    [stripXdtFileLinks(stripXdtImageLinks(output.text)).trim(), ...notices]
      .filter((part) => part.length > 0)
      .join("\n\n") || (attachments.length > 0 ? ATTACHMENTS_ONLY_TEXT : "");

  const chunks = chunkWecomMarkdown(visible);
  const steps: ImFinalStep[] = [];
  if (chunks.length === 0) {
    // 空正文也要有一步: 它负责把本轮流式消息收敛掉(空结果不发占位)。
    const step: ImFinalTextStep = { id: "text:0", kind: "text", text: "" };
    steps.push(step);
  } else {
    chunks.forEach((chunk, index) => {
      const step: ImFinalTextStep = { id: `text:${index}`, kind: "text", text: chunk };
      steps.push(step);
    });
  }
  steps.push(...attachments);
  return { steps };
}

/**
 * 按计划逐步投递。每一步独立结果; `undefined` 表示本轮没有尝试该项。
 */
export async function deliverWecomFinal(
  surface: WecomDeliverySurface,
  plan: ImFinalDeliveryPlan,
  opts: { onlySteps?: string[] } = {},
): Promise<ImFinalDeliveryResult> {
  const only = opts.onlySteps ? new Set(opts.onlySteps) : null;
  const states: Array<ImDeliveryState | undefined> = plan.steps.map(() => undefined);
  for (const [index, step] of plan.steps.entries()) {
    if (only && !only.has(step.id)) continue;
    if (!surface.isConnected()) {
      for (let rest = index; rest < plan.steps.length; rest += 1) {
        if (!only || only.has(plan.steps[rest]!.id)) states[rest] = "failed";
      }
      break;
    }
    states[index] =
      step.kind === "text"
        ? await deliverText(surface, step)
        : step.kind === "remote"
          ? // 企业微信终稿计划不产生外部图片步骤; 真出现时不可投递, 按失败记。
            "failed"
          : await deliverAttachment(surface, step);
  }
  return { states };
}

function textStepIndex(step: ImFinalTextStep): number {
  const parsed = Number.parseInt(step.id.slice("text:".length), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function deliverText(
  surface: WecomDeliverySurface,
  step: ImFinalTextStep,
): Promise<ImDeliveryState> {
  if (!surface.isConnected()) return "failed";
  try {
    await surface.sendTextChunk(textStepIndex(step), step.text);
    return "sent";
  } catch {
    surface.log.warn(`wecom final ${DELIVERY_FAILURE.textUncertain}`);
    return "uncertain";
  }
}

async function deliverAttachment(
  surface: WecomDeliverySurface,
  step: ImFinalAttachmentStep,
): Promise<ImDeliveryState> {
  const sent = await surface.sendFile(step.absPath, step.displayName);
  if (sent.ok) return "sent";
  // 企业微信 sendFile 只在素材上传成功后发送失败时返回 SEND_FAIL —— 消息可能已到,
  // 重发会造成重复附件, 因此按不确定处理。
  if (sent.reason === "SEND_FAIL") return "uncertain";
  return "failed";
}
