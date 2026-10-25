import { requestErrorMessage } from './requestErrorMessage';
import { createPublicAssetUpload } from '@cindy/app-runtime/ossPublicUpload';
export * from '@cindy/app-runtime/ossPublicUpload';
export const uploadPublicAsset = createPublicAssetUpload(requestErrorMessage);
