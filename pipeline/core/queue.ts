/** Minimal async fan-in queue: push from callbacks, consume as an async iterable. */
export class EventQueue<T> {
  private buf: T[] = [];
  private waiter?: () => void;
  private done = false;

  push(v: T): void {
    this.buf.push(v);
    this.waiter?.();
    this.waiter = undefined;
  }

  close(): void {
    this.done = true;
    this.waiter?.();
    this.waiter = undefined;
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.buf.length > 0) yield this.buf.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiter = r;
      });
    }
  }
}
