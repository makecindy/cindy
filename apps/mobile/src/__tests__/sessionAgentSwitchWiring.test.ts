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

  it('preflights legacy hosts and isolates only rebuild-unsupported preconditions', () => {
    const source = readSource('app/sessions/[sessionId].tsx');
    const rowSelector = source.slice(
      source.indexOf('const selectComposerModelRow'),
      source.indexOf('const selectComposerFlatModel'),
    );
    const flatSelector = source.slice(
      source.indexOf('const selectComposerFlatModel'),
      source.indexOf('const browseComposerModelAgent'),
    );
    const helperStart = source.indexOf('const setComposerModel = useCallback');
    const alertHelper = source.slice(
      source.indexOf('const showRemoteModelWindowUnsupported = useCallback'),
      helperStart,
    );
    const helper = source.slice(
      helperStart,
      source.indexOf('// 选行 = 原子切', helperStart),
    );
    const controlAction = source.slice(
      source.indexOf('const runControlAction = useCallback'),
      source.indexOf('const writeSessionAgentSwitchIntent'),
    );

    const legacyGuard = helper.indexOf('shouldBlockLegacyRemoteModelWindowSwitch({');
    const setModel = helper.indexOf(
      'await maker.setModel(sessionId, args.model, args.providerId, args.selection)',
    );
    expect(legacyGuard).toBeGreaterThan(-1);
    expect(legacyGuard).toBeLessThan(setModel);
    expect(helper.slice(legacyGuard, setModel)).toContain('return false;');
    expect(helper).toContain(
      'hostGuardSupported: modelSheetCapabilities?.supportsModelWindowSwitchGuard === true',
    );
    expect(helper).toContain('agentKind: sessionAgentKind');
    expect(helper).not.toContain('isSsh');
    expect(helper).toContain('contextTokens: currentSession?.contextTokens');
    expect(helper).toContain('currentContextWindow: currentSession?.contextWindow');
    expect(helper).toContain('targetContextWindow: args.targetContextWindow');
    expect(helper).toContain('showRemoteModelWindowUnsupported(args.targetContextWindow);');
    expect(rowSelector).toContain(
      'modelSheetCapabilities?.supportsModelWindowSwitchGuard === true',
    );
    expect(rowSelector).toContain('selection: atomicSelection,');
    expect(rowSelector).toContain('setComposerModel({');
    expect(rowSelector).toContain('if (!applied) return false;');
    expect(rowSelector).toContain('if (!atomicSelection && next.effort');
    expect(rowSelector).toContain('if (!atomicSelection && next.fastMode');
    expect(rowSelector.indexOf('if (!applied) return false;')).toBeLessThan(
      rowSelector.indexOf('await maker.setEffort('),
    );
    expect(rowSelector.indexOf('if (!applied) return false;')).toBeLessThan(
      rowSelector.indexOf('await maker.setFastMode('),
    );
    expect(rowSelector).toContain('targetContextWindow: row.model.contextWindow');
    expect(flatSelector).toContain('reconcileRuntimeDraftWithCapabilities({');
    expect(flatSelector).toContain(
      'modelSheetCapabilities?.supportsModelWindowSwitchGuard === true',
    );
    expect(flatSelector).toContain('targetContextWindow: option.contextWindow');
    expect(flatSelector).toContain('selection: atomicSelection,');
    expect(flatSelector).toContain(
      'atomicSelection?.effort ? { effort: atomicSelection.effort }',
    );
    expect(flatSelector).toContain('{ fastMode: atomicSelection.fastMode }');
    expect(source).not.toContain('confirmMobileModelWindowSwitch');
    expect(source).not.toContain('confirmComposerModelWindowSwitch');
    expect(source).not.toContain('setComposerModelWithFinalWindowConfirmation');
    expect(source).not.toContain('contextWindowConfirmationRequired');
    expect(source).not.toContain('contextTokensForConfirmation');
    expect(source).not.toContain('confirmedContextWindow');
    expect(helper).toContain('const reason = formatRemoteError(err);');
    expect(helper).toContain('const isRemoteModelWindowUnsupported =');
    expect(helper).toContain("reason.includes('remote model-window rebuild is unsupported') ||");
    expect(helper).toContain("reason.includes('remote model-window confirmation is unsupported')");
    expect(helper).toContain('!isPreconditionFailedRemoteError(err) ||');
    expect(helper).toContain('!isRemoteModelWindowUnsupported');
    expect(helper).toContain('throw err;');
    expect(helper).not.toContain('Alert.alert(reason);');
    expect(helper).toContain(
      'showRemoteModelWindowUnsupported(args.targetContextWindow, reason);',
    );
    expect(alertHelper).toContain("t('models.contextWindowSwitch.remoteTitle')");
    expect(alertHelper).toContain("t('models.contextWindowSwitch.remoteDescription', {");
    expect(alertHelper).toContain('used: formatModelWindowTokens(contextTokens)');
    expect(alertHelper).toContain('total: formatModelWindowTokens(targetContextWindow)');
    expect(alertHelper).toContain('pct: Math.round((contextTokens / targetContextWindow) * 100)');
    expect(alertHelper).toContain(': fallbackDescription;');
    expect(alertHelper).toContain(
      "{ text: t('models.contextWindowSwitch.cancel'), style: 'cancel' }",
    );
    expect(helper.match(/return false;/g)).toHaveLength(2);
    expect(helper).not.toContain('setError(');
    expect(controlAction).toContain('applied === false && rollbackPatch && deviceId');
    expect(controlAction).toContain('setError(formatRemoteError(err));');
  });
});
