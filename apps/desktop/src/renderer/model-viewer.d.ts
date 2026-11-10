/**
 * `<model-viewer>` Web Component (Google) JSX intrinsic — registered at
 * runtime when ModelLightbox first lazy-loads `@google/model-viewer`.
 *
 * The package ships HTMLElement-level types but doesn't auto-augment React's
 * JSX namespace, so we declare just the props that ModelLightbox uses.
 *
 * This file is a MODULE (note the trailing `export {}`), so the
 * `declare module 'react'` block performs proper *augmentation* — merging
 * `JSX.IntrinsicElements` instead of replacing the entire `react` module
 * type surface (which would wipe out `useState` / `useEffect` / etc.). The
 * augmentation lives here rather than in `vite-env.d.ts` because that file
 * is an ambient global script — adding a top-level `import 'react'` to it
 * would break the global `interface Window { electronAPI }` declaration.
 *
 * React 19's new JSX transform resolves intrinsics through
 * `React.JSX.IntrinsicElements`, not the global `JSX` namespace, which is
 * why the merge target lives inside `declare module 'react'`.
 */

import 'react';

declare module 'react' {
  interface ModelViewerJSXAttributes
    extends DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> {
    src?: string;
    poster?: string;
    alt?: string;
    autoplay?: boolean | '';
    'camera-controls'?: boolean | '';
    'auto-rotate'?: boolean | '';
    'auto-rotate-delay'?: string | number;
    'interaction-prompt'?: 'auto' | 'when-focused' | 'none';
    'shadow-intensity'?: string | number;
    exposure?: string | number;
    'environment-image'?: string;
    'disable-tap'?: boolean | '';
    loading?: 'auto' | 'lazy' | 'eager';
    reveal?: 'auto' | 'interaction' | 'manual';
    ar?: boolean | '';
  }
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': ModelViewerJSXAttributes;
    }
  }
}

export {};
