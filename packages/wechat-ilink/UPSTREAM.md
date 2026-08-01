# Tencent iLink protocol provenance

Protocol behavior and selected pure utility logic were independently adapted from:

- Repository: <https://github.com/Tencent/openclaw-weixin>
- Tag: `v2.4.6`
- Commit: `cef0bfc390393f716903e16d50408118047f87e0`
- Retrieved: 2026-07-27
- License: MIT; see `LICENSE.tencent-openclaw-weixin`

Derived or behaviorally adapted areas:

- `src/types.ts`: `src/api/types.ts`
- `src/apiClient.ts`: `src/api/api.ts`
- `src/auth.ts`: `src/auth/login-qr.ts`
- `src/mediaCrypto.ts`: `src/cdn/aes-ecb.ts`
- `src/markdown.ts`: `src/messaging/markdown-filter.ts`

Cindy does not copy the OpenClaw plugin runtime, filesystem persistence, account store,
logging, or host integration. Storage, cancellation, credentials, and network execution
remain explicit host concerns.
