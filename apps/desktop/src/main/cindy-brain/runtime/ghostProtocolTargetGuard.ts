export class GhostProtocolTargetChangedError extends Error {
  constructor() {
    super('Plugin request target changed');
  }
}

export function assertGhostProtocolTargetCurrent(isCurrent?: () => boolean): void {
  if (isCurrent?.() === false) throw new GhostProtocolTargetChangedError();
}
