// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { WebBrowserTabPillIcon, type WebBrowserState } from '../index';

function browserState(favicon: string | null): WebBrowserState {
  return {
    url: 'https://example.com/',
    title: 'Example',
    favicon,
    isAudible: false,
  };
}

describe('WebBrowserTabPillIcon', () => {
  afterEach(cleanup);

  it('renders the observed page favicon', () => {
    const view = render(
      <WebBrowserTabPillIcon state={browserState('https://example.com/favicon.ico')} />,
    );

    const image = view.container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://example.com/favicon.ico');
    expect(view.container.querySelector('.lucide-globe')).toBeNull();
  });

  it('falls back to Globe when the favicon cannot load', () => {
    const view = render(
      <WebBrowserTabPillIcon state={browserState('https://example.com/missing.ico')} />,
    );

    fireEvent.error(view.container.querySelector('img')!);

    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('.lucide-globe')).toBeTruthy();
  });

  it('retries with a new favicon URL after an earlier URL failed', () => {
    const view = render(
      <WebBrowserTabPillIcon state={browserState('https://example.com/missing.ico')} />,
    );
    fireEvent.error(view.container.querySelector('img')!);

    view.rerender(
      <WebBrowserTabPillIcon state={browserState('https://example.com/favicon-v2.ico')} />,
    );

    expect(view.container.querySelector('img')?.getAttribute('src'))
      .toBe('https://example.com/favicon-v2.ico');
    expect(view.container.querySelector('.lucide-globe')).toBeNull();
  });
});
