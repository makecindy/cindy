// @vitest-environment jsdom
import { act, type Dispatch, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHomeViewSession, useRetainedHomeState } from '@/session/homeViewSession';
import { setMobileAuthOwner, invalidateMobileAuthOwnerForSwitch } from '@/auth/authOwnerGeneration';

describe('Home state handoff between page and sidebar', () => {
  let root: Root;
  let container: HTMLDivElement;
  let values: { query: string; device: string | null; expanded: string[]; offset: number };
  let setQuery: Dispatch<SetStateAction<string>>;
  let setDevice: Dispatch<SetStateAction<string | null>>;
  let setExpanded: Dispatch<SetStateAction<string[]>>;
  function HomeProbe() {
    const session = getHomeViewSession();
    const [query, updateQuery] = useRetainedHomeState(session, 'search.query', '');
    const [device, updateDevice] = useRetainedHomeState<string | null>(session, 'selectedDeviceId', null);
    const [expanded, updateExpanded] = useRetainedHomeState<string[]>(session, 'expandedAutomationGroups', []);
    values = { query, device, expanded, offset: session.read('scrollOffset', 0) };
    setQuery = updateQuery; setDevice = updateDevice; setExpanded = updateExpanded;
    return null;
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    setMobileAuthOwner(null); setMobileAuthOwner('first');
    container = document.createElement('div'); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); setMobileAuthOwner(null); });
  it('retains interactions synchronously through full-width → sidebar → full-width remounts', async () => {
    await act(async () => root.render(<HomeProbe key="page" />));
    await act(async () => {
      setQuery('needle'); setDevice('mac');
      setExpanded((previous) => [...previous, 'group-1']);
      setExpanded((previous) => [...previous, 'group-2']);
      getHomeViewSession().write('scrollOffset', 480);
      root.render(<HomeProbe key="sidebar" />);
    });
    expect(values!).toEqual({ query: 'needle', device: 'mac', expanded: ['group-1', 'group-2'], offset: 480 });
    await act(async () => { setQuery('sidebar edit'); root.render(<HomeProbe key="page-again" />); });
    expect(values!.query).toBe('sidebar edit');
    expect(values!.device).toBe('mac');
  });
  it('does not carry view state across account/realm changes or a switch back to the same account', async () => {
    await act(async () => root.render(<HomeProbe key="first" />));
    await act(async () => { setQuery('private'); setDevice('private-mac'); });
    const oldUpdate = setQuery!;
    const oldSession = getHomeViewSession();
    setMobileAuthOwner('first', 'cn');
    await act(async () => root.render(<HomeProbe key="other-realm" />));
    await act(async () => oldUpdate('late callback'));
    oldSession.write('scrollOffset', 900);
    expect(values!).toEqual({ query: '', device: null, expanded: [], offset: 0 });
    expect(getHomeViewSession().read('search.query', '')).toBe('');
    invalidateMobileAuthOwnerForSwitch();
    setMobileAuthOwner('first');
    await act(async () => root.render(<HomeProbe key="returned" />));
    expect(values!.query).toBe('');
  });
  it('updates the mounted Home when a sidebar changes shared filters', async () => {
    await act(async () => root.render(<HomeProbe />));
    await act(async () => {
      getHomeViewSession().write('search.query', 'from sidebar');
      getHomeViewSession().write('selectedDeviceId', 'other-mac');
    });
    expect(values!.query).toBe('from sidebar');
    expect(values!.device).toBe('other-mac');
    await act(async () => setQuery((previous) => `${previous}!`));
    expect(getHomeViewSession().read('search.query', '')).toBe('from sidebar!');
  });
});
