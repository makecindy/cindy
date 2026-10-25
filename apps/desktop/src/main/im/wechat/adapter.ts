import { createWechatAdapterFactory } from '@cindy/app-runtime/wechat/adapter';
import { resolveWechatWorkingDir } from './channelSettings';
export const {buildWechatAdapter}=createWechatAdapterFactory(resolveWechatWorkingDir);
