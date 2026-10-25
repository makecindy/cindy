import {createLogger} from '../logger.js';
import {createInlineImageCompressor} from '@cindy/app-runtime/inlineImageCompressor';
const runtime=createInlineImageCompressor({log:createLogger('inlineImageCompressor')});
export const {isDecodableInlineImage,compressInlineImage}=runtime;
