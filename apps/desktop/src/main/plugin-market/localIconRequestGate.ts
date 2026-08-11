export const MAX_CONCURRENT_LOCAL_ICON_REQUESTS = 2;

/**
 * Main-side hard cap for the privileged work behind plugin-market:local-icons.
 * Renderer throttling is only a performance hint and cannot be a security boundary.
 */
export class LocalIconRequestGate {
  private inFlight = 0;

  tryRun<T>(operation: () => Promise<T>): Promise<T> | null {
    if (this.inFlight >= MAX_CONCURRENT_LOCAL_ICON_REQUESTS) return null;
    this.inFlight += 1;

    let request: Promise<T>;
    try {
      request = operation();
    } catch (error) {
      this.inFlight -= 1;
      throw error;
    }

    return request.finally(() => {
      this.inFlight -= 1;
    });
  }
}
