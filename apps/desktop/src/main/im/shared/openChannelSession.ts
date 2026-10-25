import {createChannelSessionOpening} from '@cindy/app-runtime/channelSessionOpening';
import {getCurrentDbClientSnapshot} from '../../localDb/client/current';
import {openSession} from '../../localDb/sessionOpening';
export type * from '@cindy/app-runtime/channelSessionOpening';
export const {captureChannelAccount,openChannelSession}=createChannelSessionOpening({getCurrentDbClientSnapshot:(...args)=>getCurrentDbClientSnapshot(...args),openSession:(...args)=>openSession(...args)});
