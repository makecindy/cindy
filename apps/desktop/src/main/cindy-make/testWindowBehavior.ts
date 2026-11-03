/** The Make preview is an explicitly opened, disposable process, not a tray app. */
export function createMakeTestWindowBehavior(options: {
  isPackaged: boolean;
  environment: NodeJS.ProcessEnv;
  focus(): void;
  quit(): void;
}) {
  const enabled =
    !options.isPackaged &&
    options.environment.XDT_CINDY_MAKE_TEST === '1' &&
    options.environment.XDT_ISOLATED === '1';
  return {
    ready(): void {
      if (enabled) options.focus();
    },
    close(event: { preventDefault(): void }): boolean {
      if (!enabled) return false;
      event.preventDefault();
      options.quit();
      return true;
    },
  };
}
