/**
 * Capability switches for measuring changes one at a time. The baseline does not
 * interpret capability names; it only adds them to, or removes them from, what each
 * controller profile declares.
 *
 *   TRANSFER_BASELINE_EXTRA_CAPS=a,b        add to link-open + device-link:subscribe capabilities
 *   TRANSFER_BASELINE_DROP_CAPS=c           remove from them
 *   TRANSFER_BASELINE_EXTRA_HELLO_CAPS=…    add to hello capabilities
 *   TRANSFER_BASELINE_DROP_HELLO_CAPS=…     remove from them
 *   TRANSFER_BASELINE_DROP_TRANSFER=delta   strip per-request `transfer.<field>` the client adds
 *                                           to outgoing invokes (e.g. a list `transfer.delta`)
 *
 * Each variable also exists with a `_PHONE` / `_DESKTOP` suffix for one profile only; both
 * apply. Removal only covers what the profile declares: transport capabilities the client
 * appends itself in openLink (reliable-transport-v1 …) are unchanged. Per-request fields can
 * only be stripped, because adding one the client cannot decode would break it.
 */
import { parseTransportPayload, type Envelope } from '@cindy/device-link';
import type { ControllerProfile } from './profiles';

export interface CapabilitySwitches {
  extraCaps: string[];
  dropCaps: string[];
  extraHelloCaps: string[];
  dropHelloCaps: string[];
  dropTransfer: string[];
}

const NAME = /^[A-Za-z0-9._:/-]{1,128}$/;

function list(env: NodeJS.ProcessEnv, key: string, profile: string): string[] {
  const values = [env[key], env[`${key}_${profile.toUpperCase()}`]]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of values) {
    if (!NAME.test(value)) throw new Error(`${key}: invalid capability or field name "${value}"`);
  }
  return [...new Set(values)];
}

export function readCapabilitySwitches(profile: ControllerProfile['id'], env: NodeJS.ProcessEnv = process.env): CapabilitySwitches {
  return {
    extraCaps: list(env, 'TRANSFER_BASELINE_EXTRA_CAPS', profile),
    dropCaps: list(env, 'TRANSFER_BASELINE_DROP_CAPS', profile),
    extraHelloCaps: list(env, 'TRANSFER_BASELINE_EXTRA_HELLO_CAPS', profile),
    dropHelloCaps: list(env, 'TRANSFER_BASELINE_DROP_HELLO_CAPS', profile),
    dropTransfer: list(env, 'TRANSFER_BASELINE_DROP_TRANSFER', profile),
  };
}

function adjust(base: readonly string[], extra: readonly string[], drop: readonly string[]): string[] {
  const kept = base.filter((cap) => !drop.includes(cap));
  return [...kept, ...extra.filter((cap) => !kept.includes(cap) && !drop.includes(cap))];
}

export function applyCapabilitySwitches(profile: ControllerProfile, switches: CapabilitySwitches): ControllerProfile {
  return {
    ...profile,
    controllerCapabilities: adjust(profile.controllerCapabilities, switches.extraCaps, switches.dropCaps),
    helloCapabilities: adjust(profile.helloCapabilities, switches.extraHelloCaps, switches.dropHelloCaps),
  };
}

/**
 * Remove `transfer.<field>` from an outgoing invoke frame. Requests are small and never
 * segmented in practice; a segmented one is sent unchanged.
 */
export function stripTransferFields(text: string, fields: readonly string[]): string {
  if (!fields.length || !text.includes('"invoke"')) return text;
  let env: Envelope;
  try { env = JSON.parse(text) as Envelope; } catch { return text; }
  if (env.kind !== 'invoke') return text;
  const reliable = parseTransportPayload(env.payload);
  if (reliable?.meta.segment) return text;
  const strip = (payload: Record<string, unknown>): boolean => {
    const transfer = payload.transfer as Record<string, unknown> | undefined;
    if (!transfer || !fields.some((field) => field in transfer)) return false;
    const rest = Object.fromEntries(Object.entries(transfer).filter(([key]) => !fields.includes(key)));
    if (Object.keys(rest).length) payload.transfer = rest;
    else delete payload.transfer;
    return true;
  };
  if (reliable) {
    let invoke: Record<string, unknown>;
    try { invoke = JSON.parse(reliable.data) as Record<string, unknown>; } catch { return text; }
    if (!strip(invoke)) return text;
    (env.payload as { data: string }).data = JSON.stringify(invoke);
  } else if (!strip(env.payload as Record<string, unknown>)) return text;
  return JSON.stringify(env);
}

/**
 * Harness-wide switches (not per profile). All default to production behaviour.
 *
 *   TRANSFER_BASELINE_PHONE_STOP_RETAIN=0  the backgrounded phone calls client.stop() without keeping its result
 *                                          cache (production keeps it: stop({ retainResultCache: true }))
 *   TRANSFER_BASELINE_PMD_HOST=0           the host's ws client does not offer permessage-deflate
 *   TRANSFER_BASELINE_PMD_CONTROLLER=0     the controllers' ws clients do not offer it (e.g. an iPhone socket)
 *   TRANSFER_BASELINE_REALISTIC_ROWS=1     task-list rows fill every sessions column with per-row values
 *                                          and carry tags (fixture.ts), instead of the sparse default rows
 *
 * Unset PMD variables pass no option, so the ws default applies exactly as in production.
 */
export interface HarnessSwitches {
  phoneStopRetainResultCache: boolean;
  pmdHost: 'default' | 'off';
  pmdController: 'default' | 'off';
  realisticRows: boolean;
}

export function readHarnessSwitches(env: NodeJS.ProcessEnv = process.env): HarnessSwitches {
  return {
    phoneStopRetainResultCache: env.TRANSFER_BASELINE_PHONE_STOP_RETAIN !== '0',
    pmdHost: env.TRANSFER_BASELINE_PMD_HOST === '0' ? 'off' : 'default',
    pmdController: env.TRANSFER_BASELINE_PMD_CONTROLLER === '0' ? 'off' : 'default',
    realisticRows: env.TRANSFER_BASELINE_REALISTIC_ROWS === '1',
  };
}

/** ws client options for one side: `off` declines permessage-deflate, `default` passes nothing. */
export function pmdOption(mode: HarnessSwitches['pmdHost']): { perMessageDeflate?: false } {
  return mode === 'off' ? { perMessageDeflate: false } : {};
}
