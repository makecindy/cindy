import {outboundFetch} from '../maker-host/outbound-fetch.js';
import {createVideoTaskContent} from '@cindy/app-runtime/media/videoTaskContent';
export {isVideoTaskContentRef} from '@cindy/app-runtime/media/videoTaskContent';
export const {fetchVideoTaskContent}=createVideoTaskContent(outboundFetch);
