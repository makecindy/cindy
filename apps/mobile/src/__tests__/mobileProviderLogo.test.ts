/**
 * Mobile provider logo render/wiring contract.
 *
 * These source checks are intentional: the Node Vitest environment cannot import React Native
 * components without loading native runtime modules. Whitespace is normalized so formatter line
 * wrapping does not make the wiring assertions brittle.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('MobileProviderMark', () => {
  it('renders shared official paths and keeps unknown providers on the monogram fallback', () => {
    const source = readSource('src/session/MobileProviderMark.tsx');

    expect(source).toContain("from '@cindy/model-providers/branding';");
    expect(source).toContain('isProviderLogoKind(logoKind) ? logoKind : resolveProviderLogoKind(');
    expect(source).toContain('<Path d={PROVIDER_LOGO_PATHS[kind]} fill={fill} />');
    expect(source).toContain('{providerMonogram(name)}');
    expect(source).not.toContain('switch (providerId)');
  });

  it('uses theme text color by default and the error status color for a disconnected source', () => {
    const source = readSource('src/session/MobileProviderMark.tsx');
    const session = readSource('app/sessions/[sessionId].tsx');

    expect(source).toContain('const fill = color ?? colors.textSecondary;');
    expect(source).toContain('fill={fill}');
    expect(source).toContain('color ? { color } : null');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(session).toContain('composerSelectedSourceDisconnected');
    expect(session).toContain('color={composerSelectedSourceDisconnected ? colors.statusError : undefined}');
    expect(session).toContain('providerId={composerPillSourceId}');
  });

  it('passes provider branding through model rows and both current-model entries', () => {
    const list = readSource('src/session/MobileModelPickerList.tsx');
    const draft = readSource('app/sessions/new.tsx');
    const session = readSource('app/sessions/[sessionId].tsx');

    expect(list).toContain('routing={row.provider.routing}');
    expect(list).toContain('logoKind={row.provider.logoKind}');
    expect(draft).toContain('routing={activeSourceProvider.routing}');
    expect(draft).toContain('logoKind={activeSourceProvider.logoKind}');
    expect(session).toContain('routing={composerPillSourceProvider?.routing}');
    expect(session).toContain('logoKind={composerPillSourceProvider?.logoKind}');
  });

  it('advertises the full-logo capability on refresh and subscription frames', () => {
    const context = readSource('src/device-link/DeviceLinkContext.tsx');

    expect(context).toContain(
      "'maker:provider:list', [{ capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2] }]",
    );
    expect(context).toContain(
      'capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2]',
    );
  });
});
