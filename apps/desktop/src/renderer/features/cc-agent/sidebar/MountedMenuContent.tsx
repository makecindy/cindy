import type { ReactNode } from 'react';

/** Build menu rows only while Radix mounts content, including its exit animation. */
export function MountedMenuContent({ children }: { children: () => ReactNode }) {
  return children();
}
