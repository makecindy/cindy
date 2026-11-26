# Managed identity overlay

Hides sign-out, adding or switching accounts and the local-mode sign-in entry in the main
window of a cloud instance, because the control service owns the instance identity. This is
presentation only, driven by the main-window argument from `runtime-window-controls`. The
main process rejects these actions itself (`assertInstanceAuthMutationAllowed`).
Authorization of third-party providers and plugins is unaffected.

## Login recovery

The client's `instance-runtime/auth-recovery.ts` restores the login of an existing
`resource-v1` instance through `POST /v1/recover` on `/tmp/cindy-auth-recovery/control.sock`,
a Unix socket only the instance user can open.

- The request must name this instance's membership and device and expires within
  10 minutes. Requests are deduplicated by request ID and credential digest. `applied` is
  returned only after the new session is stored.
- The status file reports `authRecovery` as `login-required`, `pending` or `ready`.
  `authRecoveryCapabilities` lists `explicit-access-token` when the optional `accessToken`
  of an explicit owner login is accepted.
- When device-link has removed the device, `login-required` is reported until the owner
  logs in again; recovery then re-registers the device and completes only once that
  succeeded.

```sh
CLOUD_UPDATE_TEST_SOURCE="$PWD" node --test deploy/linux-desktop/runtime-identity/*.test.mjs
```
