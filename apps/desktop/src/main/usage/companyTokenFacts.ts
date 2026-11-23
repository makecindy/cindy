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
type CompanyAgent = 'claude-code' | 'codex' | 'pi';
interface ExecutionReporting {
  direct(providerId: string, kind: CompanyAgent): boolean;
  available(): boolean;
  challenge(nonce: string): CompanyExecutionChallenge | null;
  issue(challenge: CompanyExecutionChallenge): Promise<string | null>;
  redeem(
    nonce: string,
    grant: string,
  ): Promise<{ receipt: string; record: CaptureCompanyUsage } | undefined>;
}
let execution: ExecutionReporting | undefined;
export function installExecutionReporting(service: ExecutionReporting | undefined) {
  execution = service;
}
export function companyExecutionReporting() {
  return execution;
}
