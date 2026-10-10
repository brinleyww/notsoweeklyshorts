export class PendingActions {
  #requests = new Map<
    string,
    {
      id: string;
      promise: Promise<void>;
      finish: (error?: string) => void;
    }
  >();

  run(key: string, send: (requestId: string) => boolean, timeout = 15000): Promise<void> {
    const existing = this.#requests.get(key);
    if (existing) return existing.promise;
    const id = crypto.randomUUID();
    let finish!: (error?: string) => void;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish('No reply from the organizer. Please try again.'),
        timeout,
      );
      finish = (error) => {
        clearTimeout(timer);
        this.#requests.delete(key);
        if (error) reject(new Error(error));
        else resolve();
      };
    });
    this.#requests.set(key, { id, promise, finish });
    // Keyboard actions may have no awaiting UI; callers can still await and report errors.
    void promise.catch(() => {});
    try {
      if (!send(id)) finish('Connection to the organizer is not ready. Please try again.');
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
    }
    return promise;
  }

  acknowledge(id: string, error?: string) {
    for (const request of this.#requests.values())
      if (request.id === id) {
        request.finish(error);
        return true;
      }
    return false;
  }

  cancel(message: string) {
    for (const request of this.#requests.values()) request.finish(message);
  }
}
