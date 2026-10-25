import {guardedOutboundFetch} from '../maker-host/outbound-fetch.js';
import {createMediaDownload} from '@cindy/app-runtime/media/mediaDownload';
export {MediaDownloadError} from '@cindy/app-runtime/media/mediaDownload';
export type {MediaDownloadReason,MediaDownloadContext} from '@cindy/app-runtime/media/mediaDownload';
export const {downloadMediaResult}=createMediaDownload(guardedOutboundFetch);
