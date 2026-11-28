import type { TurnTokenDeltas } from './turnCostCalculator.js';
import type { CompanyTokenCounts } from './companyTokenQueue.js';

export type CompanyModelTokens = CompanyTokenCounts & { model: string };
export type CaptureCompanyUsage = (samples: readonly CompanyModelTokens[]) => void;

export function companyModelTokens(model: string, usage: TurnTokenDeltas): CompanyModelTokens {
  return {
    model,
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheCreateTokens,
  };
}

let capture: (() => CaptureCompanyUsage | undefined) | undefined;

/** The execution pipeline can run without Electron or an authenticated desktop. */
export function installCompanyUsageCapture(factory: () => CaptureCompanyUsage | undefined) {
  capture = factory;
}
export function startCompanyUsage() {
  return capture?.();
}

const turns = new WeakMap<object, CaptureCompanyUsage>();
export function beginCompanyTurn(
  context: object,
  providerId: string | undefined | null,
  kind: CompanyAgent,
) {
  const record = startCompanyUsage();
  if (record && (!providerId || execution?.direct(providerId, kind))) turns.set(context, record);
}
export function takeCompanyTurn(context: object) {
  const record = turns.get(context);
  turns.delete(context);
  return record;
}

export interface CompanyExecutionChallenge {
  nonce: string;
  recipient: string;
}
export function readCompanyExecutionChallenge(value: unknown): CompanyExecutionChallenge | null {
  if (!value || typeof value !== 'object') return null;
  const { nonce, recipient } = value as Partial<CompanyExecutionChallenge>;
  if (typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(nonce) ||
      typeof recipient !== 'string' || !/^[0-9a-f]{64}$/.test(recipient)) return null;
  return { nonce, recipient };
}

type CompanyAgent = 'claude-code' | 'codex' | 'pi';
export interface CompanyExecutionReceipt {
  receipt: string;
  /** Rechecked at turn admission, renewal and settlement; a redeemed callback can go stale. */
  current(): boolean;
  record: CaptureCompanyUsage;
}
export type CompanyTurnBoundary = (model?: string) => boolean;
export interface CompanyExecutionReporting {
  direct(providerId: string, kind: CompanyAgent): boolean;
  available(): boolean;
  /** A live receipt may arrive during an already admitted turn. This guard pins its reporting boundary. */
  captureBoundary?(): CompanyTurnBoundary | undefined;
  challenge(nonce: string): CompanyExecutionChallenge | null;
  issue(challenge: CompanyExecutionChallenge): Promise<string | null>;
  redeem(
    nonce: string,
    grant: string,
  ): Promise<CompanyExecutionReceipt | undefined>;
}
let execution: CompanyExecutionReporting | undefined;
export function installExecutionReporting(service: CompanyExecutionReporting | undefined) {
  execution = service;
}
export function companyExecutionReporting() {
  return execution;
}
