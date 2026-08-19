/**
 * The blocking notice for an account handover that aborted mid-teardown.
 *
 * By the time an abort can happen the teardown has already cleared the custom
 * provider catalog and stopped IM, the scheduler, embedding, the Ghost
 * projection and Learn. Their construction duals all hang off the login /
 * DB-ready sequence, which nothing on the abort path re-runs — so the user stays
 * signed in to an account that silently no longer routes models, no longer
 * connects its messaging channels and no longer runs its schedules. A restart
 * rebuilds all of it.
 *
 * Recovering in place is the better fix and is deliberately not what this does:
 * the provider catalog is repopulated by a readiness arm published from the
 * startup closure, so it has no re-entrant entry point today, and reviving only
 * the services that *do* would leave the account looking recovered with its
 * routing still empty.
 *
 * Split out of `bootstrap-electron` so the decision can be tested: that module
 * cannot be imported under test.
 */

export interface AccountBoundaryAbortNoticeDeps {
  /** Localised strings, already resolved by the caller's `t`. */
  readonly strings: {
    readonly title: string;
    readonly message: string;
    readonly detail: string;
    readonly restartNow: string;
    readonly later: string;
  };
  /** Resolves to the index of the button the user chose. */
  readonly showDialog: (options: {
    type: 'warning';
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: true;
  }) => Promise<{ response: number }>;
  readonly relaunch: () => void;
  readonly quit: () => void;
  readonly logError: (message: string, error: unknown) => void;
}

/**
 * Ask once, and only ever once per abort.
 *
 * Deliberately not awaited by the caller: the teardown still has to rethrow and
 * still has to lower its launch fence, and neither may wait on a person. A
 * dialog that cannot be shown at all — no window yet, a headless run — must not
 * turn into a second failure on the abort path either, so everything here is
 * caught and downgraded to a log.
 */
export async function showAccountBoundaryAbortNotice(
  deps: AccountBoundaryAbortNoticeDeps,
): Promise<void> {
  try {
    const { response } = await deps.showDialog({
      type: 'warning',
      title: deps.strings.title,
      message: deps.strings.message,
      detail: deps.strings.detail,
      buttons: [deps.strings.restartNow, deps.strings.later],
      // "Later" is the safe default: nothing is lost by postponing, and a
      // restart the user did not ask for could interrupt work in progress.
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
    // `quit`, not a hard exit: there is no updater process waiting to take over
    // here, so the before-quit chain still has to stop the agents and flush
    // local state. `relaunch` only marks the intent; quitting is what performs
    // it. Same shape as the update-channel relaunch.
    deps.relaunch();
    deps.quit();
  } catch (error) {
    deps.logError('could not show the account handover abort notice', error);
  }
}
