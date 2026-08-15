// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PiPackageView } from '../../../../shared/piPackages';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: (props: { checked: boolean; ['aria-label']?: string }) => (
    <button role="switch" aria-checked={props.checked} aria-label={props['aria-label']} />
  ),
}));

import { PiPackagesSection } from '../PiPackagesSection';

function packageView(index: number): PiPackageView {
  return {
    source: `npm:sample-extension-${index}`,
    name: `sample-extension-${index}`,
    version: `1.0.${index}`,
    enabled: index % 2 === 0,
    resources: [{
      kind: 'extension',
      name: `extensions/index-${index}.ts`,
      compatibility: 'supported',
    }],
  };
}

describe('PiPackagesSection compact installed list', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: {
        listPiPackages: vi.fn(async () => ({
          available: true,
          packages: Array.from({ length: 6 }, (_, index) => packageView(index + 1)),
        })),
        mutatePiPackage: vi.fn(),
      },
    };
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('keeps each installed extension to one collapsed row until details are requested', async () => {
    render(<PiPackagesSection />);

    await waitFor(() => {
      expect(screen.getByText('sample-extension-6')).toBeTruthy();
    });
    expect(screen.getAllByRole('switch')).toHaveLength(6);
    expect(screen.getAllByRole('button', { name: 'settings.piPackages.showDetails' })).toHaveLength(6);
    expect(screen.queryByText('settings.piPackages.status.extensionSupported')).toBeNull();
    expect(screen.queryByText('npm:sample-extension-1')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.piPackages.showDetails' })[0]!);

    expect(screen.getByText('settings.piPackages.status.extensionSupported')).toBeTruthy();
    expect(screen.getByText('npm:sample-extension-1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.piPackages.collapseDetails' })).toBeTruthy();
  });
});
