// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { WebBrowserTabPillIcon, type WebBrowserState } from '../index';
import { setWebBrowserLoading } from '../browserLoadingStore';

function browserState(favicon: string | null): WebBrowserState {
  return {
    url: 'https://example.com/',
    title: 'Example',
    favicon,
    isAudible: false,
  };
}

describe('WebBrowserTabPillIcon', () => {
  afterEach(() => {
    setWebBrowserLoading('tab-1', false);
    cleanup();
  });

  it('renders the observed page favicon', () => {
    const view = render(
      <WebBrowserTabPillIcon state={browserState('https://example.com/favicon.ico')} tabId="tab-1" />,
    );

    const image = view.container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://example.com/favicon.ico');
    expect(view.container.querySelector('.lucide-globe')).toBeNull();
  });

  it('falls back to Globe when the favicon cannot load', () => {
    const view = render(
      <WebBrowserTabPillIcon state={browserState('https://example.com/missing.ico')} tabId="tab-1" />,
    );

    fireEvent.error(view.container.querySelector('img')!);

    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('.lucide-globe')).toBeTruthy();
  });

  it('retries with a new favicon URL after an earlier URL failed', () => {
    const view = render(
      <WebBrowserTabPillIcon state={browserState('https://example.com/missing.ico')} tabId="tab-1" />,
    );
    fireEvent.error(view.container.querySelector('img')!);

    view.rerender(
      <WebBrowserTabPillIcon state={browserState('https://example.com/favicon-v2.ico')} tabId="tab-1" />,
    );

    expect(view.container.querySelector('img')?.getAttribute('src'))
      .toBe('https://example.com/favicon-v2.ico');
    expect(view.container.querySelector('.lucide-globe')).toBeNull();
  });

  it('shows a loading ring in place of the favicon while the web page is loading', () => {
    const view = render(
      <WebBrowserTabPillIcon
        state={browserState('https://example.com/favicon.ico')}
        tabId="tab-1"
      />,
    );

    act(() => setWebBrowserLoading('tab-1', true));

    expect(view.getByTestId('web-browser-tab-loading')).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();
    const loadingRing = view.getByTestId('web-browser-tab-loading');
    expect(loadingRing.classList.contains('animate-spinner')).toBe(true);
    expect(loadingRing.classList.contains('motion-reduce:animate-none')).toBe(true);

    act(() => setWebBrowserLoading('tab-1', false));
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/favicon.ico',
    );
  });
});
