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

  it('confirms overflow before either same-Agent model selection writes through', () => {
    const source = readSource('app/sessions/[sessionId].tsx');
    const rowSelector = source.slice(
      source.indexOf('const selectComposerModelRow'),
      source.indexOf('const selectComposerFlatModel'),
    );
    const flatSelector = source.slice(
      source.indexOf('const selectComposerFlatModel'),
      source.indexOf('const browseComposerModelAgent'),
    );
    const remoteGuard = source.slice(
      source.indexOf('const confirmComposerModelWindowSwitch'),
      source.indexOf('// 选行 = 原子切', source.indexOf('const confirmComposerModelWindowSwitch')),
    );
    expect(rowSelector).toContain(
      'confirmComposerModelWindowSwitch(row.model.contextWindow)',
    );
    expect(flatSelector).toContain(
      'confirmComposerModelWindowSwitch(option.contextWindow)',
    );
    expect(remoteGuard).toContain('currentSession?.contextWindow');
    expect(remoteGuard).toContain(
      'controlBusy || remoteSessionRunning || !hasVerifiedWindows || !hasVerifiedUsage',
    );
    expect(remoteGuard).toContain('targetContextWindow >= currentContextWindow');
    expect(remoteGuard.indexOf('remoteSessionRunning')).toBeLessThan(
      remoteGuard.indexOf('targetContextWindow >= currentContextWindow'),
    );
    expect(rowSelector).toContain(
      'next.model !== currentSession.model || next.providerId !== currentSession.providerId',
    );
    expect(flatSelector).toContain('option.id !== currentSession?.model');
    expect(rowSelector.indexOf('confirmMobileModelWindowSwitch')).toBeLessThan(
      rowSelector.indexOf('maker.setModel'),
    );
    expect(flatSelector.indexOf('confirmMobileModelWindowSwitch')).toBeLessThan(
      flatSelector.indexOf('maker.setModel'),
    );
    expect(rowSelector).toContain(
      'row.model.contextWindow < currentSession.contextWindow',
    );
    expect(rowSelector).toContain(
      'currentSession.contextTokens >= row.model.contextWindow',
    );
    expect(flatSelector).toContain(
      'option.contextWindow < currentSession.contextWindow',
    );
    expect(flatSelector).toContain(
      'currentSession.contextTokens >= option.contextWindow',
    );
    expect(rowSelector).toContain('contextWindow: confirmedContextWindow');
    expect(flatSelector).toContain('confirmedOverflow');
  });

  it('negotiates and sends the append-only model-window confirmation capability', () => {
    const context = readSource('src/device-link/DeviceLinkContext.tsx');
    const transport = readSource('src/device-link/mobileMakerTransport.ts');
    const capabilities = context.slice(
      context.indexOf('const CONTROLLER_CAPABILITIES = ['),
      context.indexOf('];', context.indexOf('const CONTROLLER_CAPABILITIES = [')),
    );

    expect(capabilities).toContain('CONTROLLER_CAPABILITY_MODEL_WINDOW_CONFIRMATION_V1');
    expect(context).toContain('capabilities: CONTROLLER_CAPABILITIES');
    expect(transport).toContain('confirmedContextWindow: confirmedOverflow.contextWindow');
    expect(transport).toContain(
      'modelWindowConfirmationCapability:\n                  CONTROLLER_CAPABILITY_MODEL_WINDOW_CONFIRMATION_V1',
    );
    expect(transport).toContain(
      "typeof result?.contextWindowConfirmationRequired === 'number'",
    );
  });
});
