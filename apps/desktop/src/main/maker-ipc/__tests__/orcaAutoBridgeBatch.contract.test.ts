import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cross-file trust-boundary wiring for Orca auto-bridge batching. The batch behaviour itself is
 * unit-tested through the real coordinator/dispatcher; this guard pins the two production wirings
 * that, if silently removed, would break the ownership/trust contract:
 *   1. only the host auto-bridge entry stamps `autoBridge:true` (manual send_to_lead / Lead
 *      assignments must NOT be batchable), and
 *   2. wire-supplied `autoBridge`/`autoBridgeBatchCount` are stripped at the input boundary, so a
 *      renderer/device-link peer cannot forge batch ownership or the Host team-authorization proof.
 * Removing either injection reverts the fix without any unit test failing, hence the source contract.
 */
describe('Orca auto-bridge batch trust-boundary wiring', () => {
  const here = resolve(__dirname, '..');
  const register = readFileSync(resolve(here, 'register.ts'), 'utf8');
  const dispatcher = readFileSync(resolve(here, 'orcaInterAgentDispatcher.ts'), 'utf8');

  it('stamps autoBridge only at the host auto-bridge entry', () => {
    expect(register).toMatch(
      /sendAutoBridgeToLead:[\s\S]*?autoBridge:\s*true[\s\S]*?return \{ accepted: result\.ok \};/,
    );
    // 唯一盖章点：register 里 `autoBridge: true` 只允许出现一次，防止别的入口偷偷加盖。
    expect(register.match(/autoBridge:\s*true/g)).toHaveLength(1);
  });

  it('stamps origin.autoBridge only when the caller passes autoBridge (not for manual reports)', () => {
    expect(dispatcher).toMatch(/\.\.\.\(params\.autoBridge \? \{ autoBridge: true \} : \{\}\)/);
  });

  it('strips wire-supplied autoBridge batch marks from orca origins at the input boundary', () => {
    // 必须钉到 `normalized.origin = origin` 赋值：只删克隆对象不写回等于没剥。
    expect(register).toMatch(
      /normalized\.origin\?\.kind === 'orca'[\s\S]*?delete origin\.autoBridge;[\s\S]*?delete origin\.autoBridgeBatchCount;[\s\S]*?normalized\.origin = origin;/,
    );
  });
});