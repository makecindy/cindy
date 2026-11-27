import { isProviderConnectionImage } from '@cindy/model-providers/branding';
import { useState, type ReactNode } from 'react';

export function CustomProviderIcon({ svg, size, className, children }: {
  svg?: string;
  size: number;
  className?: string;
  children: ReactNode;
}) {
  if (typeof svg !== 'string' || !svg) return children;
  let src: string;
  try {
    src = isProviderConnectionImage(svg) ? svg : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    return children;
  }
  return <ProviderImage key={src} src={src} size={size} className={className} fallback={children} />;
}

function ProviderImage({ src, size, className, fallback }: {
  src: string;
  size: number;
  className?: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return <img src={src} alt="" className={className} style={{ width: size, height: size, objectFit: 'contain' }}
    onError={() => setFailed(true)} />;
}
