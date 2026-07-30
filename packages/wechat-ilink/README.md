# @cindy/wechat-ilink

Host-agnostic Tencent iLink protocol client used by Cindy's personal WeChat IM
connector.

The package owns wire encoding, QR authorization, long polling, text sending,
typing status, message decoding, text filtering/chunking, and media crypto
primitives. It deliberately does not own:

- credential or cursor persistence;
- filesystem paths or temporary files;
- Electron, Renderer, SQLite, or Maker integration;
- logging or telemetry;
- retry queues and task execution.

The host must inject `fetch`, an `AbortSignal` for every operation, and any
verification-code UX. Authorization challenges expose only the QR content
needed for display; the polling token and prior bot tokens remain in package
memory and are erased when authorization finishes.

```ts
const transport = new TencentIlinkTransport({
  baseUrl: "https://ilinkai.weixin.qq.com",
  token,
  botAgent: `Cindy/${version}`,
  clientVersion: version,
  fetch,
});
```

Only credential-free HTTPS origins under `weixin.qq.com` are accepted. Errors
cross the package boundary as `WechatIlinkError` with stable codes and never
include response bodies, authorization headers, QR polling tokens, or bot
tokens.

Upstream protocol provenance and license details are recorded in
[`UPSTREAM.md`](UPSTREAM.md).
