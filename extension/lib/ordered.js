/**
 * Concurrency helpers for segment downloads.
 */

/** Writes chunks strictly in index order even when they arrive out of order. */
export class OrderedSink {
  /** @param {(chunk:any, index:number) => Promise<void>} write */
  constructor(write) {
    this.write = write;
    this.next = 0;
    this.pending = new Map();
    this.chain = Promise.resolve();
  }

  /** Queue chunk `index`; resolves once every chunk that is now writable has been written. */
  put(index, chunk) {
    this.pending.set(index, chunk);
    this.chain = this.chain.then(async () => {
      while (this.pending.has(this.next)) {
        const c = this.pending.get(this.next);
        this.pending.delete(this.next);
        await this.write(c, this.next);
        this.next += 1;
      }
    });
    return this.chain;
  }

  /** Number of chunks buffered in memory waiting for an earlier one. */
  get buffered() { return this.pending.size; }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

/**
 * Run `worker(item, index)` over items with bounded concurrency and retries.
 * Resolves with results in input order. Rejects on the first permanent failure or abort.
 */
export async function runPool(items, concurrency, worker, opts = {}) {
  const { retries = 3, retryDelayMs = 500, onProgress, signal } = opts;
  const results = new Array(items.length);
  let nextIdx = 0; let done = 0; let failed = null;
  const check = () => {
    if (failed) throw failed;
    if (signal && signal.aborted) throw new Error('aborted');
  };
  async function lane() {
    while (true) {
      check();
      const i = nextIdx;
      if (i >= items.length) return;
      nextIdx += 1;
      let attempt = 0;
      while (true) {
        check();
        try {
          results[i] = await worker(items[i], i);
          break;
        } catch (e) {
          attempt += 1;
          if (signal && signal.aborted) throw new Error('aborted');
          if (attempt >= retries) { failed = failed || e; throw e; }
          await sleep(retryDelayMs * attempt, signal);
        }
      }
      done += 1;
      if (onProgress) onProgress(done, items.length);
    }
  }
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane);
  await Promise.all(lanes);
  check();
  return results;
}
