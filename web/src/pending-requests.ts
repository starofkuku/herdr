/**
 * The requests a gateway is waiting on, and the frames it could not send yet.
 *
 * These two belong together because they share one failure: a request written
 * while the connection cannot carry it. The frame would be dropped, the server
 * would never see the request, and no reply would ever arrive — so the caller
 * waits forever and a view stays on "loading". Holding the frame until the
 * handshake finishes, plus a deadline for anything that still goes unanswered,
 * is what makes a request settle either way.
 *
 * Pure and free of timers so both halves can be tested directly; the gateway
 * supplies the clock and the socket.
 */

/** A request that has been sent and is waiting for its reply. */
export interface PendingRequest {
  /** Called once, with the reply. */
  resolve: (value: unknown) => void;
  /** Called once, when the request will never be answered. */
  reject: (error: Error) => void;
  /** Releases the request's deadline. */
  cancelTimer: () => void;
}

export class RequestTracker {
  private pending = new Map<string, PendingRequest>();
  private outbox: unknown[] = [];

  /**
   * Registers a request and writes its frame, or holds the frame.
   *
   * `send` reports whether the frame left the process. A frame that did not is
   * queued, not dropped, because the request it belongs to is already
   * registered: discarding it here would leave an entry nothing can settle.
   */
  register(id: string, request: PendingRequest, frame: unknown, send: () => boolean): void {
    this.pending.set(id, request);
    if (!send()) this.outbox.push(frame);
  }

  /** Resolves the request for `id` with `value`, if it is still outstanding. */
  resolve(id: string, value: unknown): boolean {
    const request = this.pending.get(id);
    if (!request) return false;
    this.pending.delete(id);
    request.cancelTimer();
    request.resolve(value);
    return true;
  }

  /**
   * Fails one request, e.g. because its deadline passed.
   *
   * Reports whether it was still outstanding, so a timer that fires late does
   * not report an error for a request that already got its reply.
   */
  fail(id: string, error: Error): boolean {
    const request = this.pending.get(id);
    if (!request) return false;
    this.pending.delete(id);
    request.cancelTimer();
    request.reject(error);
    return true;
  }

  /**
   * Fails every outstanding request. The queued frames go with them: none of
   * them will be answered either, so resending them after a later handshake
   * would double up on requests whose caller has already given up.
   */
  failAll(error: Error): void {
    const requests = [...this.pending.values()];
    this.pending.clear();
    this.outbox = [];
    for (const request of requests) {
      request.cancelTimer();
      request.reject(error);
    }
  }

  /**
   * Writes the held frames in order.
   *
   * `send` reports whether the frame left the process; a frame that still could
   * not be written stays at the front of the queue, so a handshake that is
   * announced before the socket is usable cannot lose requests.
   */
  flush(send: (frame: unknown) => boolean): void {
    while (this.outbox.length > 0) {
      if (!send(this.outbox[0])) return;
      this.outbox.shift();
    }
  }

  /** Frames waiting to be written. */
  get queued(): number {
    return this.outbox.length;
  }

  /** Requests waiting for a reply. */
  get outstanding(): number {
    return this.pending.size;
  }
}
