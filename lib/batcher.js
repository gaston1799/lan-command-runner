// Coalesces streaming command output so the agent posts one request per batch
// (size- or time-bounded) instead of one request per read chunk. Flushes are
// serialized so stdout/stderr order is preserved.

class OutputBatcher {
  constructor({ post, batchBytes = 64 * 1024, batchMs = 50, maxPendingBytes = 8 * 1024 * 1024 }) {
    this.post = post;
    this.batchBytes = batchBytes;
    this.batchMs = batchMs;
    this.maxPendingBytes = maxPendingBytes;
    this.stdout = "";
    this.stderr = "";
    this.timer = null;
    this.chain = Promise.resolve();
    this.pendingBytes = 0;
  }

  _size() {
    return Buffer.byteLength(this.stdout) + Buffer.byteLength(this.stderr);
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._flush();
    }, this.batchMs);
    if (this.timer.unref) this.timer.unref();
  }

  // Serialized so batches reach the broker in order.
  _flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const out = this.stdout;
    const err = this.stderr;
    this.stdout = "";
    this.stderr = "";
    this.pendingBytes = 0;

    const tasks = [];
    if (out) tasks.push(() => this.post("stdout", out));
    if (err) tasks.push(() => this.post("stderr", err));

    const run = this.chain.then(async () => {
      for (const task of tasks) await task();
    });
    this.chain = run.catch(() => {});
    return run;
  }

  push(stream, data) {
    if (stream === "stderr") this.stderr += data;
    else this.stdout += data;
    this.pendingBytes = this._size();

    if (this.pendingBytes >= this.batchBytes) {
      this._flush();
    } else if (this.pendingBytes >= this.maxPendingBytes) {
      // Defensive ceiling: flush rather than buffer without bound.
      this._flush();
    } else {
      this._schedule();
    }
  }

  // Flushes any remaining bytes and settles when the last post has finished.
  async done() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this._flush();
    await this.chain;
  }
}

module.exports = { OutputBatcher };
