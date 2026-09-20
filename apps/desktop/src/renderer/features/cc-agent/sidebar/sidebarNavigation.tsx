import { memo, useCallback, useLayoutEffect, useRef, type ComponentType } from 'react';
import {
  useNavigate,
  type NavigateFunction,
  type NavigateOptions,
  type To,
} from 'react-router-dom';

export interface SidebarNavigationProps {
  navigate: NavigateFunction;
}

/** Keep event handlers stable while retaining the latest router-relative semantics. */
export function useSidebarNavigate(): NavigateFunction {
  const navigate = useNavigate();
  const latest = useRef(navigate);
  useLayoutEffect(() => {
    latest.current = navigate;
  }, [navigate]);
  return useCallback((to: To | number, options?: NavigateOptions) => {
    if (typeof to === 'number') return latest.current(to);
    if (options === undefined) return latest.current(to);
    return latest.current(to, options);
  }, []);
}

/** Only this small adapter subscribes to route changes, not the row's UI tree. */
export function withSidebarNavigation<P extends object>(
  Component: ComponentType<P & SidebarNavigationProps>,
) {
  const Row = memo(Component);
  return memo(function SidebarNavigationRow(props: P) {
    const navigate = useSidebarNavigate();
    return <Row {...props} navigate={navigate} />;
  });
}
