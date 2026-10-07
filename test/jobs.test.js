const test = require("node:test");
const assert = require("node:assert/strict");

const { createBroker } = require("../lib/broker");
const { generateToken } = require("../lib/auth");

process.env.LCR_ALLOW_UNSIGNED = "1";

async function withBroker(token, run) {
  const server = createBroker({ token });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      server.close(resolve);
    });
  }
}

async function register(port, token, name) {
  const response = await fetch(`http://127.0.0.1:${port}/agent/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return response.json();
}

async function runJob(port, token, agentId, command, stream = true) {
  const response = await fetch(`http://127.0.0.1:${port}/agents/${agentId}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ command, stream }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function jobs(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/jobs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.json();
}

test("a registered agent is reported online", async () => {
  const token = generateToken();
  await withBroker(token, async (port) => {
    const agent = await register(port, token, "online-check");
    const response = await fetch(`http://127.0.0.1:${port}/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = await response.json();
    const entry = payload.agents.find((a) => a.id === agent.agentId);
    assert.ok(entry, "agent appears in the list");
    assert.equal(entry.online, true, "a freshly registered agent is online");
    assert.equal(typeof entry.lastSeenAgeMs, "number");
    assert.equal(entry.pendingJobs, 0);
  });
});

test("the backlog cap refuses further jobs with 429", async () => {
  const previous = process.env.LCR_JOB_BACKLOG_MAX;
  process.env.LCR_JOB_BACKLOG_MAX = "2";
  const token = generateToken();
  try {
    await withBroker(token, async (port) => {
      const agent = await register(port, token, "backlog");
      const first = await runJob(port, token, agent.agentId, ["node", "-v"]);
      const second = await runJob(port, token, agent.agentId, ["node", "-v"]);
      const third = await runJob(port, token, agent.agentId, ["node", "-v"]);
      assert.equal(first.status, 202);
      assert.equal(second.status, 202);
      assert.equal(third.status, 429);
      assert.match(third.body.error, /refusing more/i);
    });
  } finally {
    if (previous === undefined) delete process.env.LCR_JOB_BACKLOG_MAX;
    else process.env.LCR_JOB_BACKLOG_MAX = previous;
  }
});

test("jobs are listed and a queued job can be cancelled", async () => {
  const token = generateToken();
  await withBroker(token, async (port) => {
    const agent = await register(port, token, "cancel");
    const queued = await runJob(port, token, agent.agentId, ["node", "-e", "setTimeout(()=>{},3000)"]);
    assert.equal(queued.status, 202);
    const jobId = queued.body.jobId;

    const listing = await jobs(port, token);
    assert.ok(listing.jobs.some((job) => job.id === jobId && job.status === "queued"), "job is queued");

    const cancelResponse = await fetch(
      `http://127.0.0.1:${port}/agents/${agent.agentId}/jobs/${jobId}/cancel`,
      { method: "POST", headers: { authorization: `Bearer ${token}` } }
    );
    const cancel = await cancelResponse.json();
    assert.equal(cancel.ok, true);
    assert.equal(cancel.cancelled, true);
    assert.equal(cancel.status, "queued");

    const after = await jobs(port, token);
    assert.ok(!after.jobs.some((job) => job.id === jobId), "cancelled job removed from the listing");

    // Cancelling an unknown job reports 404.
    const missingResponse = await fetch(
      `http://127.0.0.1:${port}/agents/${agent.agentId}/jobs/nope/cancel`,
      { method: "POST", headers: { authorization: `Bearer ${token}` } }
    );
    assert.equal(missingResponse.status, 404);
  });
});
