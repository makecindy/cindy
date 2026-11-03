/** Router-only classification. Credentials and state are still consumed by OpenSDK. */
export function isWechatSdkCallback(
  path: string,
  config: { appId: string; universalLink: string },
): boolean {
  const isCallbackPath = (value: string) =>
    /^(?:oauth|refreshToken)\/?$/.test(value);
  try {
    // Expo Router may already have replaced the incoming wx<AppID> scheme with
    // Cindy's scheme, or reduced the URL to a path. Neither is a navigable page.
    const customPath = path.replace(/^[a-zA-Z][\w+.-]*:\/\//, '/');
    const isWebLink = /^https?:\/\//i.test(path);
    if (!isWebLink && isCallbackPath(customPath.split(/[?#]/)[0].replace(/^\/+/, ''))) return true;
    if (!config.appId || !config.universalLink) return false;
    const base = new URL(config.universalLink);
    const actual = isWebLink ? new URL(path) : new URL(customPath, 'https://wechat-routing.invalid');
    if (actual.username || actual.password || (isWebLink && actual.origin !== base.origin)) return false;
    const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
    if (!actual.pathname.startsWith(prefix)) return false;
    const suffix = actual.pathname.slice(prefix.length);
    // OpenSDK also returns to <base>/<appId>/ with an opaque payload while
    // checking Universal Links. Match its route and marker, never decode it.
    if (suffix.replace(/\/$/, '') === config.appId && actual.searchParams.has('_wechat_sdk_biz_data')) return true;
    return isCallbackPath(suffix) || (
      suffix.startsWith(`${config.appId}/`) &&
      isCallbackPath(suffix.slice(config.appId.length + 1))
    );
  } catch {
    return false;
  }
}
