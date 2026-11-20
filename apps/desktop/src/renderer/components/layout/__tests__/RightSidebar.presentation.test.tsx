// @vitest-environment jsdom
/** Unit rendering regression: RightSidebar must consume the held presentation state,
 * then commit native expansion without a collapsed frame or second animation. Shell tests
 * omit this outer wrapper; prime one toggle while its requested and presented states differ.
 */
import { createRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/right-sidebar/RightSidebarShell', () => ({ RightSidebarShell: () => null }));
import { SidebarPresentationContext } from '@/layout/sidebarPresentation';
import { RightSidebar, type RightSidebarHandle } from '../RightSidebar';
afterEach(cleanup);
it('commits native expansion without a second width transition or collapsed frame', () => {
  const ref = createRef<RightSidebarHandle>();
  const view = (requested: boolean, presented: boolean) => (
    <SidebarPresentationContext.Provider value={{ collapsed: presented, instant: true }}>
      <RightSidebar ref={ref} isCollapsed={requested} width={600} isMac
        sessionId="demo" workdir="" remoteHostId={null} />
    </SidebarPresentationContext.Provider>
  );
  const result = render(view(true, true));
  ref.current!.requestAnimateNextChange();
  result.rerender(view(false, true));
  expect(screen.getByLabelText('rightSidebar.ariaLabel').hasAttribute('data-pane-collapsed')).toBe(true);
  result.rerender(view(false, false));
  const aside = screen.getByLabelText('rightSidebar.ariaLabel');
  expect(aside.hasAttribute('data-pane-collapsed')).toBe(false);
  expect(aside.style.width).toBe('600px');
  expect(aside.className).not.toContain('transition-[width]');
});
