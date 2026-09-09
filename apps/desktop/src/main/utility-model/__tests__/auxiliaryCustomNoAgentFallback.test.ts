import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');

describe('custom auxiliary chain does not hit the session agent', () => {
  it('Help only allows the session oneShot fallback for the automatic chain', () => {
    const source = readFileSync(path.join(root, 'maker-ipc/help.ts'), 'utf8');
    expect(source.match(/const auxiliaryChain = getEffectiveAuxiliaryModelChain\(\);/g)?.length).toBe(2);
    expect(source.match(/auxiliaryChain\.source === 'auto'/g)?.length).toBe(2);
    expect(source).not.toContain('isAuxiliaryModelCustomized');
    expect(source.match(/maker\.oneShot/g)?.length).toBeGreaterThan(0);
    expect(source).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(source.match(/beforeDispatch: async \(\) => isHelpOwnerScopeCurrent\(ownerScopeKey, auxiliaryChainSnapshot\)/g)?.length).toBe(2);
    expect(source.match(/beforeDispatch: beforeSessionAgentDispatch/g)?.length).toBe(2);
    expect(source).toContain('isHelpSessionAgentDispatchAllowed');
  });

  it('pinned-card summaries skip agent oneShot when the auxiliary list is customized', () => {
    const source = readFileSync(path.join(root, 'sessionTaskSummary.ts'), 'utf8');
    expect(source).toContain('const auxiliaryChain = getEffectiveAuxiliaryModelChain();');
    expect(source).toContain("auxiliaryChain.source !== 'auto' ||");
    expect(source).not.toContain('isAuxiliaryModelCustomized');
    expect(source).toContain('await getMaker().oneShot');
    expect(source).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(source).toContain('const beforeSessionAgentDispatch = async () =>');
    expect(source).toContain('beforeDispatch: beforeSessionAgentDispatch');
    expect(source).toContain('isAgentOneShotRouteDisabled(agentKind)');
    const disabledCheck = source.indexOf('isAgentOneShotRouteDisabled(agentKind)');
    const ownerRecheck = source.indexOf('return isAuxiliaryOwnerScopeCurrent(ownerScopeKey, auxiliaryChainSnapshot);', disabledCheck);
    expect(ownerRecheck).toBeGreaterThan(disabledCheck);
  });

  it('voice refinement pins the effective auxiliary chain for the whole run', () => {
    const source = readFileSync(path.join(root, 'voice-input/index.ts'), 'utf8');
    expect(source).toContain('const auxiliaryChainSnapshot = getEffectiveAuxiliaryModelChainSnapshot();');
    expect(source.match(/assertVoiceInputOwnerScopeCurrent\(ownerScopeKey, auxiliaryChainSnapshot\)/g)?.length).toBe(3);
    expect(source).toContain('beforeDispatch: () => assertVoiceInputOwnerScopeCurrent(ownerScopeKey),');
  });

  it('dictionary learning uses the same owner and chain dispatch guard', () => {
    const source = readFileSync(path.join(root, 'voice-input/index.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(source).toContain(`const advisorClient = new DictionaryLearningTextModelClient(
      (prompt, requestOptions) => requestUtilityText(getMaker(), prompt, requestOptions),
      () => assertVoiceInputOwnerScopeCurrent(ownerScopeKey, auxiliaryChainSnapshot),
    );`);
    expect(source).toContain(`const result = await advisor.advise(adviceInput);
    assertVoiceInputOwnerScopeCurrent(ownerScopeKey, auxiliaryChainSnapshot);
    const recordResult = voiceInputDataStore.recordDictionaryLearningActions(result.actions);`);
  });
});
