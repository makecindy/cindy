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
    expect(rowSelector).toMatch(
      /currentSession\.contextTokens,\s+row\.model\.contextWindow,\s+currentSession\.remoteHostId/,
    );
    expect(flatSelector).toMatch(
      /currentSession\?\.contextTokens,\s+option\.contextWindow,\s+currentSession\?\.remoteHostId/,
    );
    expect(rowSelector).toContain('next.model !== currentSession.model');
    expect(flatSelector).toContain('option.id !== currentSession?.model');
    expect(rowSelector.indexOf('confirmMobileModelWindowSwitch')).toBeLessThan(
      rowSelector.indexOf('maker.setModel'),
    );
    expect(flatSelector.indexOf('confirmMobileModelWindowSwitch')).toBeLessThan(
      flatSelector.indexOf('maker.setModel'),
    );
  });
});
