import path from 'node:path';
import { createWechatSilkDecoder } from '@cindy/app-runtime/wechat/silkDecoder';
export { __testing } from '@cindy/app-runtime/wechat/silkDecoder';
export const {decodeWechatSilkToWav}=createWechatSilkDecoder(()=>path.join(__dirname,'silkWorker.js'));
