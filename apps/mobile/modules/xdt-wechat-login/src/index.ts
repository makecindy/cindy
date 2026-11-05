import { requireNativeModule, type EventSubscription } from 'expo-modules-core';

export interface WechatAuthOptions {
  appId: string;
  universalLink?: string;
  scope?: string;
  state: string;
}

export interface WechatAuthCodeResult {
  code: string;
}

interface XdtWechatLoginModule {
  isWechatInstalled(): Promise<boolean>;
  requestWechatAuthCode(
    options: WechatAuthOptions,
  ): Promise<WechatAuthCodeResult>;
  cancelWechatAuthRequest(): Promise<void>;
  consumeWechatLaunchInfos(): Promise<string[]>;
  addListener(event: 'onWechatLaunch', listener: () => void): EventSubscription;
}

const nativeModule =
  requireNativeModule<XdtWechatLoginModule>('XdtWechatLogin');

export function isWechatInstalled(): Promise<boolean> {
  return nativeModule.isWechatInstalled();
}

export function requestWechatAuthCode(
  options: WechatAuthOptions,
): Promise<WechatAuthCodeResult> {
  return nativeModule.requestWechatAuthCode(options);
}

/** Releases a native request whose JavaScript-side foreground timeout already fired. */
export function cancelWechatAuthRequest(): Promise<void> {
  return nativeModule.cancelWechatAuthRequest();
}

export function addWechatLaunchListener(listener: () => void): EventSubscription {
  return nativeModule.addListener('onWechatLaunch', listener);
}

export function consumeWechatLaunchInfos(): Promise<string[]> {
  return nativeModule.consumeWechatLaunchInfos();
}
