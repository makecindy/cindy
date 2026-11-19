/**
 * 最近照片 → 上传候选(任务页、新建任务页、伙伴群聊共用)。
 *
 * 一次加入的照片共用一个批次号并带上选中序号:上传并发进行,先传完的不一定是先选的,
 * 托盘由 insertUploadedAttachment 按序号归位,不按完成先后排;发送时仍在上传的同批照片
 * 也按同一序号排(incomingShareSlotOrder)。
 */
import { buildMobileImageAttachmentCandidate } from './mobileImageAttachment';
import type { MobileLocalAttachmentUploadCandidate } from './mobileLocalAttachmentUpload';
import { resolveContextSheetMediaAssetForUpload, type ContextSheetMediaAsset } from './useContextSheetMediaAssets';

let batchSequence = 0;

/** assets 按选中顺序传入;点照片单张加入时就是只有一张的一批。 */
export function contextSheetMediaUploadCandidates(
  assets: readonly ContextSheetMediaAsset[],
): MobileLocalAttachmentUploadCandidate[] {
  batchSequence += 1;
  const batchId = `recent-photos-${batchSequence}`;
  return assets.map((asset, index) => ({
    kind: 'image' as const,
    uri: asset.uri,
    name: asset.filename,
    size: 0,
    sourceId: asset.id,
    incomingShareOrder: { batchId, index },
    resolve: async () => {
      const resolved = await resolveContextSheetMediaAssetForUpload(asset);
      const candidate = buildMobileImageAttachmentCandidate({
        fileName: resolved.filename,
        uri: resolved.uri,
      }, 0);
      return {
        uri: candidate.uri,
        name: candidate.name,
        mimeType: candidate.mimeType,
        width: resolved.width,
        height: resolved.height,
        // HEIC 已在 resolve 阶段一次性转码 + 缩边,跳过 preprocess 防二次有损。
        skipPreprocess: resolved.optimized === true,
      };
    },
  }));
}
