import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * 扫码登录要用相机原生模块（expo-camera）。没有它的原生包（加入相机模块之前打的
 * 开发包）不显示扫码入口，也不加载相机组件，避免 import 期 requireNativeModule 抛错。
 */
export function isQrScanSupported(): boolean {
  return requireOptionalNativeModule('ExpoCamera') != null;
}
