import {broadcastMessageRow,createMessage} from '../localDb/ipc/messages';
import {captureDataOwnerBroadcastScope} from '../device-link/broadcast-tap';
import {captureGeneratedImageStorage,generatedImageErrorCode,releaseGeneratedImageUpstream} from './generatedImageStorage';
import {commitChatImageUrls} from './chatAttachments';
import {MAX_GENERATED_IMAGE_BYTES} from './generatedMedia';
import {t} from '../i18n';
import {createGeneratedImageDeliveryRuntime} from '@cindy/app-runtime/generatedImageDelivery';
export type * from '@cindy/app-runtime/generatedImageDelivery';
export const {createGeneratedImageDelivery}=createGeneratedImageDeliveryRuntime({broadcastMessageRow:(...args)=>broadcastMessageRow(...args),createMessage:(...args)=>createMessage(...args),captureDataOwnerBroadcastScope:(...args)=>captureDataOwnerBroadcastScope(...args),captureGeneratedImageStorage:(...args)=>captureGeneratedImageStorage(...args),generatedImageErrorCode:(...args)=>generatedImageErrorCode(...args),releaseGeneratedImageUpstream:(...args)=>releaseGeneratedImageUpstream(...args),commitChatImageUrls:(...args)=>commitChatImageUrls(...args),get MAX_GENERATED_IMAGE_BYTES(){return MAX_GENERATED_IMAGE_BYTES;},t:key=>t(key)});
