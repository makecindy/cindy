export class ScheduledModelSelectionBusyError extends Error {}

/** The queued send can retry as soon as the companion runtime releases its route. */
export class BotRouteWaitingForIdleError extends ScheduledModelSelectionBusyError {
  constructor(readonly isIdle: () => boolean) {
    super('Saved companion route is still pending');
  }
}
