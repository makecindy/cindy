/**
 * Three-state classification for the Windows lock-screen service (issue #11862).
 *
 * The helper's `--status` collapses "service not registered" and "service
 * registered but stopped" into one `missing` word: `service::pid()` only
 * succeeds while the service is `SERVICE_RUNNING`, and the service is created
 * with `SERVICE_DEMAND_START`, so after every reboot the service sits stopped
 * and settings used to render that as "never authorized" (授权开启 button
 * coming back). This module holds the pure decision — the `sc` spawn and the
 * persisted authorization intent stay in `windowsHost.ts` — so the state
 * machine can be unit-tested without a browser or an installed service.
 */
import type { WindowsDesktopSupport } from '../../shared/remoteDesktop';

/**
 * SCM registration probe: `exists` / `absent` come from `sc query state= all`
 * (stdout scanned for a service name), `unknown` when `sc` itself failed
 * (missing binary, timeout, unreadable output) and no conclusion can be drawn.
 */
export type WindowsServiceRegistration = 'exists' | 'absent' | 'unknown';

/**
 * Service names always carry the `CindyRemoteDesktop-` prefix
 * (windows-host naming.rs `service_name`), whatever the installation id is —
 * scanning for the prefix keeps this side independent of the id derivation.
 */
const SERVICE_NAME_PREFIX = /SERVICE_NAME:\s*CindyRemoteDesktop-/i;

/** Reads `sc query state= all` output into a registration verdict. */
export function parseServiceRegistration(scStdout: string): 'exists' | 'absent' {
  return SERVICE_NAME_PREFIX.test(scStdout) ? 'exists' : 'absent';
}

/**
 * Classify one status read into what settings needs:
 * running (`ready`) / not installed (`missing`) / installed but not running
 * (`stopped`). Anything the helper cannot interpret stays `unavailable`.
 *
 * @param statusWord first word of the helper's `--status` output
 * @param options.pipeProbe `'ok'` only when status was `ready` and the pipe
 *   probe connected; `'refused'` when the probe threw; omitted otherwise.
 * @param options.registration SCM registration verdict, consulted only when
 *   statusWord is `missing` (the ambiguous word).
 * @param options.authorized persisted "user authorized lock-screen control"
 *   intent (`device-link lockScreenControlEnabled`); used only when the
 *   registration probe is `unknown`, so a working `sc` always wins over the
 *   stored intent.
 */
export function classifyWindowsSupport(
  statusWord: string,
  options: {
    pipeProbe?: 'ok' | 'refused';
    registration?: WindowsServiceRegistration;
    authorized?: boolean;
  } = {},
): WindowsDesktopSupport {
  const { pipeProbe, registration = 'absent', authorized = false } = options;
  if (statusWord === 'ready') {
    // Running but refusing the pipe means installed-yet-unusable; the install
    // flow (stop → stage → start) repairs it, so it reads as `stopped`.
    return pipeProbe === 'ok' ? 'ready' : 'stopped';
  }
  if (statusWord === 'missing') {
    if (registration === 'exists') return 'stopped';
    if (registration === 'absent') return 'missing';
    // sc unavailable: the persisted intent is the only remaining signal.
    return authorized ? 'stopped' : 'missing';
  }
  return 'unavailable';
}
