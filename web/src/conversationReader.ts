/** One ordered read stream per mounted pane; initial reads share the same queue. */
export function createConversationReader<T>(
  read: () => Promise<T>,
  accept: (value: T) => void,
  reject: (error: unknown) => void,
) {
  let disposed = false;
  let running = false;
  let pending = false;

  async function drain() {
    running = true;
    try {
      while (pending && !disposed) {
        pending = false;
        try {
          const value = await read();
          if (!disposed) accept(value);
        } catch (error) {
          if (!disposed) reject(error);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    refresh() {
      if (disposed) return;
      pending = true;
      if (!running) void drain();
    },
    dispose() {
      disposed = true;
      pending = false;
    },
  };
}
