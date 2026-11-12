import * as Application from 'expo-application';
import * as Updates from 'expo-updates';

/** Native binary identity stays valid after OTA; the bundle commit is separate. */
export function mobileRuntimeIdentity() {
  return {
    commit: /^[a-f0-9]{7,40}$/i.test(process.env.EXPO_PUBLIC_XDT_GIT_COMMIT ?? '')
      ? process.env.EXPO_PUBLIC_XDT_GIT_COMMIT : 'unknown',
    version: Application.nativeApplicationVersion ?? 'unknown',
    build: Application.nativeBuildVersion ?? 'unknown',
    updateId: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(Updates.updateId ?? '')
      ? Updates.updateId : 'unknown',
    runtimeVersion: /^[a-z0-9._-]{1,128}$/i.test(Updates.runtimeVersion ?? '')
      ? Updates.runtimeVersion : 'unknown',
    embedded: Updates.isEmbeddedLaunch,
  };
}
