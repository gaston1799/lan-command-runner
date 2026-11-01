const test = require("node:test");
const assert = require("node:assert/strict");

const { createBroker } = require("../lib/broker");
const { generateToken } = require("../lib/auth");
const { signedFetchJson } = require("../lib/transport");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(resolve);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A broker long-poll registers a waiter so an enqueued job can wake it
// immediately. A poll that expires on its own used to leave that waiter behind
// as a settled closure, and the next enqueue drained the dead closure instead of
// the live poll: the job then waited out the whole timeoutMs. Every job after
// the first therefore cost a full poll cycle, which looks exactly like "the
// agent is not fetching tasks".
test("a queued job wakes the open poll instead of waiting for its timeout", async () => {
  const token = generateToken();
  const server = createBroker({ token });
  try {
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}`;

    const registration = await signedFetchJson(`${url}/agent/register`, {
      method: "POST",
      token,
      body: { name: "wakeup" },
    });
    const agentId = registration.agentId;
    const agentToken = registration.agentToken;

    // One poll that expires by timeout, which is what leaves the dead waiter.
    const expired = await signedFetchJson(`${url}/agent/${agentId}/poll?timeoutMs=120`, {
      method: "POST",
      token: agentToken,
      body: {},
    });
    assert.equal(expired.job, null);

    const startedAt = Date.now();
    const pending = signedFetchJson(`${url}/agent/${agentId}/poll?timeoutMs=5000`, {
      method: "POST",
      token: agentToken,
      body: {},
    });
    await sleep(150);

    const submitted = await signedFetchJson(`${url}/agents/${agentId}/run`, {
      method: "POST",
      token,
      body: { command: ["cmd", "/c", "echo", "wake"], stream: true, timeoutMs: 5000 },
    });
    assert.equal(submitted.stream, true);

    const poll = await pending;
    const elapsed = Date.now() - startedAt;
    assert.ok(poll.job, "the open poll must hand the queued job to the agent");
    assert.ok(elapsed < 2000, `the job must wake the poll instead of waiting it out (took ${elapsed}ms)`);
  } finally {
    await close(server);
  }
});

test("a job submitted with no poll open is delivered by the next poll", async () => {
  const token = generateToken();
  const server = createBroker({ token });
  try {
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}`;

    const registration = await signedFetchJson(`${url}/agent/register`, {
      method: "POST",
      token,
      body: { name: "idle" },
    });
    const agentId = registration.agentId;

    await signedFetchJson(`${url}/agents/${agentId}/run`, {
      method: "POST",
      token,
      body: { command: ["cmd", "/c", "echo", "idle"], stream: true, timeoutMs: 5000 },
    });

    const startedAt = Date.now();
    const poll = await signedFetchJson(`${url}/agent/${agentId}/poll?timeoutMs=5000`, {
      method: "POST",
      token: registration.agentToken,
      body: {},
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(poll.job, "an already queued job must be returned without waiting");
    assert.ok(elapsed < 2000, `a queued job must not wait for the poll timeout (took ${elapsed}ms)`);
  } finally {
    await close(server);
  }
});
