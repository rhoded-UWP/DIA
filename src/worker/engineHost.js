/**
 * Main-thread client for the engine worker.
 *
 * The host owns the worker's lifetime. Every job carries a deadline, and when a job
 * overruns or the user cancels, the worker is terminated outright rather than asked
 * politely to stop — a worker stuck inside a synchronous loop cannot service a message.
 * A fresh worker is started for the next job, so a hostile file poisons one job instead
 * of the session.
 */

import { LIMITS } from '../engine/limits.js';

export class EngineHost {
  constructor() {
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  #ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./engine.worker.js', import.meta.url), {
      type: 'module',
      name: 'dia-engine',
    });
    this.worker.addEventListener('message', (event) => this.#onMessage(event));
    this.worker.addEventListener('error', (event) => {
      this.#failAll(event.message || 'The processing engine stopped unexpectedly.');
    });
    return this.worker;
  }

  #onMessage(event) {
    const { id, type, message, fraction, result } = event.data ?? {};
    const job = this.pending.get(id);
    if (!job) return;

    if (type === 'progress') {
      job.onProgress?.({ message, fraction });
      return;
    }
    clearTimeout(job.timer);
    this.pending.delete(id);
    if (type === 'done') job.resolve(result);
    else job.reject(new Error(message ?? 'The processing engine reported an error.'));
  }

  #failAll(message) {
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error(message));
    }
    this.pending.clear();
    this.#discardWorker();
  }

  #discardWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /**
   * @param {string} type
   * @param {object} payload
   * @param {{onProgress?: Function, timeoutMs?: number, transfer?: Transferable[]}} opts
   */
  run(type, payload, opts = {}) {
    const worker = this.#ensureWorker();
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? LIMITS.perFileTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.#discardWorker();
        reject(new Error(
          `Processing took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. ` +
          'One of these files may be unusually large or complex — try a smaller batch.',
        ));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, onProgress: opts.onProgress });
      worker.postMessage({ id, type, payload }, opts.transfer ?? []);
    });
  }

  /** Stop whatever is running now. The next run() starts a clean worker. */
  cancel() {
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error('Cancelled.'));
    }
    this.pending.clear();
    this.#discardWorker();
  }
}

export const engine = new EngineHost();
