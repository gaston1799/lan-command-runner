const test = require("node:test");
const assert = require("node:assert/strict");

const { OutputBatcher } = require("../lib/batcher");

test("batcher coalesces many small pushes into one post per stream", async () => {
  const posts = [];
  const batcher = new OutputBatcher({
    batchBytes: 1024,
    batchMs: 10,
    post: (stream, data) => posts.push({ stream, data }),
  });

  for (let i = 0; i < 100; i += 1) batcher.push("stdout", "a");
  batcher.push("stderr", "bbb");
  await batcher.done();

  assert.equal(posts.length, 2, "one stdout post and one stderr post");
  const stdout = posts.filter((p) => p.stream === "stdout").map((p) => p.data).join("");
  const stderr = posts.filter((p) => p.stream === "stderr").map((p) => p.data).join("");
  assert.equal(stdout, "a".repeat(100));
  assert.equal(stderr, "bbb");
});

test("batcher flushes immediately past the byte threshold", async () => {
  const posts = [];
  const batcher = new OutputBatcher({ batchBytes: 8, batchMs: 1000, post: (s, d) => posts.push({ s, d }) });
  batcher.push("stdout", "12345");
  // Under threshold; wait for the timer would be slow, so push to cross it.
  batcher.push("stdout", "67890");
  await batcher.done();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].d, "1234567890");
});

test("batcher preserves stdout/stderr order across serialized flushes", async () => {
  const order = [];
  const batcher = new OutputBatcher({
    batchBytes: 2,
    batchMs: 5,
    post: async (s, d) => {
      order.push(`${s}:${d}`);
    },
  });
  batcher.push("stdout", "1");
  batcher.push("stderr", "x");
  batcher.push("stdout", "2");
  await batcher.done();
  // The first two pushes cross the threshold and flush together; the third is
  // its own flush. Within each stream the bytes stay in order.
  assert.deepEqual(order, ["stdout:1", "stderr:x", "stdout:2"]);
});
