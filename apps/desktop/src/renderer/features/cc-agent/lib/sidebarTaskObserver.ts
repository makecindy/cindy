/** Coalesce sidebar and portal mutations without observing the chat subtree. */
export function observeSidebarTaskChanges(sidebarRoot: HTMLElement, publish: () => void): () => void {
  let frame: number | null = null;
  const schedulePublish = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      publish();
    });
  };
  const observerOptions: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'aria-hidden'],
  };
  const observer = new MutationObserver(schedulePublish);
  // In rail mode Cmd/Ctrl+B changes only Sidebar's outer shell: the feature's
  // collapsed context and both inner trees can remain unchanged.
  const sidebarShell = sidebarRoot.closest('aside') ?? sidebarRoot;
  observer.observe(sidebarShell, observerOptions);
  // The first RAF can still see the old opacity/visibility during Sidebar's
  // 200ms fade. Re-read once its ancestor transition reaches the final state.
  const onVisibilityTransitionEnd = (event: TransitionEvent) => {
    if (
      (event.propertyName === 'opacity' || event.propertyName === 'visibility') &&
      event.target instanceof Element &&
      event.target.contains(sidebarRoot)
    ) {
      schedulePublish();
    }
  };
  sidebarShell.addEventListener('transitionend', onVisibilityTransitionEnd);
  const portalObservers = new Map<Element, MutationObserver>();
  const portalSelector =
    '[data-rail-panel],[data-conversation-search-overlay],[data-radix-popper-content-wrapper]';
  const attachPortalObserver = (portal: Element) => {
    if (portalObservers.has(portal)) return;
    const portalObserver = new MutationObserver(schedulePublish);
    portalObserver.observe(portal, observerOptions);
    portalObservers.set(portal, portalObserver);
  };
  const syncPortalObservers = () => {
    for (const portal of document.querySelectorAll(portalSelector)) attachPortalObserver(portal);
    for (const [portal, portalObserver] of portalObservers) {
      if (!portal.isConnected) {
        portalObserver.disconnect();
        portalObservers.delete(portal);
      }
    }
  };
  syncPortalObservers();
  const portalLifecycleObserver = new MutationObserver((records) => {
    if (
      records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches(portalSelector) || node.querySelector(portalSelector)),
        ),
      )
    ) {
      syncPortalObservers();
      schedulePublish();
    }
  });
  portalLifecycleObserver.observe(document.body, { childList: true });
  return () => {
    observer.disconnect();
    sidebarShell.removeEventListener('transitionend', onVisibilityTransitionEnd);
    portalLifecycleObserver.disconnect();
    for (const portalObserver of portalObservers.values()) portalObserver.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
