const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BoundedBuffer, truncatedText } = require("../lib/ring");
const { killProcessTree, spawnCommand } = require("../lib/proc");
const { runCommand } = require("../lib/server");

test("BoundedBuffer keeps everything under the limit", () => {
  const buffer = new BoundedBuffer(64);
  buffer.push(Buffer.from("hello "));
  buffer.push(Buffer.from("world"));
  assert.equal(buffer.truncated, false);
  assert.equal(buffer.droppedBytes, 0);
  assert.equal(buffer.toString(), "hello world");
  assert.equal(truncatedText(buffer, "stdout"), "hello world");
});

test("BoundedBuffer stops growing at the limit and counts what it dropped", () => {
  const buffer = new BoundedBuffer(8);
  buffer.push(Buffer.from("12345"));
  buffer.push(Buffer.from("67890"));
  buffer.push(Buffer.from("abc"));
  assert.equal(buffer.truncated, true);
  assert.equal(buffer.length, 8);
  assert.equal(buffer.toString(), "12345678");
  // "67890" contributed 2 dropped bytes (only "678" fit) and "abc" all 3.
  assert.equal(buffer.droppedBytes, 5);
  const text = truncatedText(buffer, "stdout");
  assert.match(text, /^12345678\n\[lcr\] stdout truncated: 5 byte\(s\) dropped\n$/);
});

test("BoundedBuffer handles a single oversized chunk", () => {
  const buffer = new BoundedBuffer(4);
  buffer.push(Buffer.from("abcdefghij"));
  assert.equal(buffer.toString(), "abcd");
  assert.equal(buffer.droppedBytes, 6);
});

test("runCommand caps buffered output but streams every byte", async () => {
  const megabytes = 6;
  const child = `process.stdout.write("x".repeat(${megabytes}*1024*1024))`;
  let streamed = 0;
  const result = await runCommand(
    { command: [process.execPath, "-e", child], timeoutMs: 60000 },
    (stream, text) => {
      if (stream === "stdout") streamed += text.length;
    },
    { outputLimitBytes: 256 * 1024 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(result.stdout.length < 300 * 1024, `buffered ${result.stdout.length} bytes`);
  assert.equal(result.droppedBytes, megabytes * 1024 * 1024 - 256 * 1024);
  assert.equal(streamed, megabytes * 1024 * 1024);
  assert.match(result.stdout, /\[lcr\] stdout truncated:/);
});

test("runCommand reports a clean, untruncated result for normal output", async () => {
  const result = await runCommand({
    command: [process.execPath, "-e", "process.stdout.write('hello')"],
    timeoutMs: 30000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.equal(result.stdout, "hello");
  assert.equal(result.droppedBytes, 0);
});

test("runCommand reports a missing executable instead of hanging", async () => {
  const result = await runCommand({
    command: ["lcr-definitely-not-a-real-binary-9f3a", "--version"],
    timeoutMs: 15000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.match(result.stderr, /ENOENT|not found|no such file/i);
});

test("runCommand times out and kills the tree", async () => {
  const started = Date.now();
  const result = await runCommand({
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 700,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.ok(elapsed < 10000, `took ${elapsed}ms; timeout kill did not land`);
});

test("killProcessTree reaches grandchildren", async () => {
  const marker = path.join(os.tmpdir(), `lcr-treekill-${process.pid}-${Date.now()}.txt`);
  // The grandchild writes the marker after 2.5s. If the tree kill works, it
  // never gets to run.
  const grandchild = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 2500)`;
  const parent = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    "setInterval(() => {}, 1000);",
  ].join("\n");

  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", parent], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 400));

  killProcessTree(child, true);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  assert.equal(fs.existsSync(marker), false, "grandchild survived the tree kill");
  try {
    fs.rmSync(marker, { force: true });
  } catch {
    /* nothing to remove */
  }
});

test("spawnCommand resolves rather than rejecting on abortable work", async () => {
  const result = await spawnCommand({
    command: process.execPath,
    args: ["-e", "process.exit(3)"],
    timeoutMs: 20000,
    outputLimitBytes: 4096,
  });
  assert.equal(result.code, 3);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
});
