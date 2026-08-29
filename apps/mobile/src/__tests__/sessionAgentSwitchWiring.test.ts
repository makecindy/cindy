import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('session Agent switch UI wiring', () => {
  it('keeps pending intent separate from the persisted session fields and rehydrates it', () => {
    const source = readSource('app/sessions/[sessionId].tsx');
    expect(source).toContain('maker.getSessionAgentSwitchIntent(sessionId)');
    expect(source).toContain('maker.switchSessionAgent(');
    expect(source).toContain('agentSwitchIntent: normalizeSessionAgentSwitchIntent(result)');
    expect(source).toContain('agentSwitch={sessionAgentSwitchSupported ? {');
    expect(source).toContain('confirmMobileSessionAgentSwitch(next, !!agentSwitchIntent)');
    expect(source).toContain('targetAgentKind: modelSheetAgentKind');
    expect(source).toContain('...(agentSwitchIntent ? { agentSwitchIntent: null } : {})');
  });

  it('uses the browsed Agent capabilities and selection in the shared model sheet', () => {
    const source = readSource('app/sessions/[sessionId].tsx');
    expect(source).toContain('agentKind={modelSheetAgentKind}');
    expect(source).toContain('capabilities={modelSheetCapabilities}');
    expect(source).toContain('flatOptions={modelSheetRuntimeOptions.modelOptions}');
    expect(source).toContain('selectedProviderId={modelSheetSelection.providerId}');
    expect(source).toContain('agentKind={agentSwitchIntent.targetAgentKind}');
  });

  it('sends one remote model request without confirmation UI or payload', () => {
    const source = readSource('app/sessions/[sessionId].tsx');
    const rowSelector = source.slice(
      source.indexOf('const selectComposerModelRow'),
      source.indexOf('const selectComposerFlatModel'),
    );
    const flatSelector = source.slice(
      source.indexOf('const selectComposerFlatModel'),
      source.indexOf('const browseComposerModelAgent'),
    );
    const helper = source.slice(
      source.indexOf('const setComposerModel = useCallback'),
      source.indexOf('// 选行 = 原子切', source.indexOf('const setComposerModel = useCallback')),
    );
    const controlAction = source.slice(
      source.indexOf('const runControlAction = useCallback'),
      source.indexOf('const writeSessionAgentSwitchIntent'),
    );

    expect(helper).toContain('await maker.setModel(sessionId, args.model, args.providerId)');
    expect(rowSelector).toContain('setComposerModel({');
    expect(flatSelector).toContain('setComposerModel({ model: option.id })');
    expect(source).not.toContain('confirmMobileModelWindowSwitch');
    expect(source).not.toContain('confirmComposerModelWindowSwitch');
    expect(source).not.toContain('setComposerModelWithFinalWindowConfirmation');
    expect(source).not.toContain('contextWindowConfirmationRequired');
    expect(source).not.toContain('contextTokensForConfirmation');
    expect(source).not.toContain('confirmedContextWindow');
    expect(helper).toContain('if (!isPreconditionFailedRemoteError(err)) throw err;');
    expect(helper).toContain("t('models.contextWindowSwitch.remoteTitle')");
    expect(helper).toContain("t('models.contextWindowSwitch.cancel')");
    expect(helper).toContain('return false;');
    expect(helper).not.toContain('setError(');
    expect(controlAction).toContain('applied === false && rollbackPatch && deviceId');
    expect(controlAction).toContain('setError(formatRemoteError(err));');
  });
});
