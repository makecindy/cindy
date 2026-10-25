import { createWechatMediaStaging } from '@cindy/app-runtime/wechat/mediaStaging';
import * as blobStore from '../../cindy-media/blobStore';
import { ingestMedia } from '../../cindy-media/ingest';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { decodeWechatSilkToWav } from './silkDecoder';
export type { WechatTaskAttachment, StagedWechatTaskMedia } from '@cindy/app-runtime/wechat/mediaStaging';
export const {stageWechatTaskMedia,removeUncommittedWechatFiles,removeReleasedWechatFiles,__testing}=createWechatMediaStaging({blobStore,ingestMedia,ownerScopedImUserDataPath,decodeWechatSilkToWav});
