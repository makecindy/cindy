/** Expo wraps Android's UnknownHostException in a plain Error with this message. */
export function isExpoAndroidDnsFailure(message: string): boolean {
  return /^fetch failed: java\.net\.UnknownHostException: Unable to resolve host "[^"\r\n]+": No address associated with hostname$/.test(message);
}
