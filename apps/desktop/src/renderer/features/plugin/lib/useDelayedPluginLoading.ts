import { useEffect, useState } from 'react';

export function useDelayedPluginLoading(waiting: boolean) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!waiting) { setShow(false); return; }
    const timer = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(timer);
  }, [waiting]);
  return waiting && show;
}
