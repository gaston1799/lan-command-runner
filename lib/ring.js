// A byte-counted buffer with a hard ceiling.
//
// Used for command output: the live stream still receives every chunk, but the
// copy retained for the result stops growing at `limitBytes` and records how
// much it dropped. That turns "the agent OOMs on `yes`" into a bounded result
// with an explicit `truncated` flag.
class BoundedBuffer {
  constructor(limitBytes) {
    const parsed = Number(limitBytes);
    this.limitBytes = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
    this.chunks = [];
    this.size = 0;
    this.droppedBytes = 0;
  }

  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk == null ? "" : chunk), "utf8");
    const length = buffer.length;
    if (length === 0) return this.size;

    if (this.size >= this.limitBytes) {
      this.droppedBytes += length;
      return this.size;
    }

    const room = this.limitBytes - this.size;
    if (length <= room) {
      this.chunks.push(buffer);
      this.size += length;
    } else {
      this.chunks.push(buffer.subarray(0, room));
      this.size = this.limitBytes;
      this.droppedBytes += length - room;
    }
    return this.size;
  }

  get truncated() {
    return this.droppedBytes > 0;
  }

  get length() {
    return this.size;
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.size);
  }

  toString(encoding = "utf8") {
    return this.toBuffer().toString(encoding);
  }

  reset() {
    this.chunks = [];
    this.size = 0;
    this.droppedBytes = 0;
  }
}

// Appends a human-visible marker when output was dropped, so a truncated result
// can never be mistaken for a complete one.
function truncatedText(buffer, label) {
  const text = buffer.toString("utf8");
  if (!buffer.truncated) return text;
  const separator = text.endsWith("\n") || text.length === 0 ? "" : "\n";
  return `${text}${separator}[lcr] ${label} truncated: ${buffer.droppedBytes} byte(s) dropped\n`;
}

module.exports = {
  BoundedBuffer,
  truncatedText,
};
