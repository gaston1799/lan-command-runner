const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");

const { listenOnFreePort, portRange } = require("../lib/port");

test("listenOnFreePort returns an in-range listening port", async () => {
  const server = net.createServer();
  try {
    const range = portRange();
    const port = await listenOnFreePort(server, "127.0.0.1", range);
    assert.ok(port >= range.min && port <= range.max, `port ${port} in ${range.min}-${range.max}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("two servers never get the same port", async () => {
  const first = net.createServer();
  const second = net.createServer();
  try {
    const p1 = await listenOnFreePort(first, "127.0.0.1");
    const p2 = await listenOnFreePort(second, "127.0.0.1");
    assert.notEqual(p1, p2, "bind-retry yields distinct ports");
  } finally {
    await new Promise((resolve) => first.close(resolve));
    await new Promise((resolve) => second.close(resolve));
  }
});

test("listenOnFreePort retries past an occupied port", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const busyPort = blocker.address().port;

  const server = net.createServer();
  try {
    const range = { min: busyPort, max: busyPort + 5 };
    const port = await listenOnFreePort(server, "127.0.0.1", range);
    assert.notEqual(port, busyPort, "occupied port was avoided");
    assert.ok(port >= range.min && port <= range.max);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => blocker.close(resolve));
  }
});
