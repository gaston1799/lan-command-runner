const test = require("node:test");
const assert = require("node:assert/strict");

const { createBroker } = require("../lib/broker");
const { createAgentConnection } = require("../lib/agent");
const { scanBrokers } = require("../lib/scan");
const { generateToken } = require("../lib/auth");
const { subnetHostAddresses } = require("../lib/addr");
const { createServer } = require("../lib/server");
const { runRemote } = require("../lib/client");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

test("the /broker probe advertises protocolVersion and authMode (token)", async () => {
  const server = createBroker({ token: generateToken() });
  try {
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/broker`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.protocolVersion, "number");
    assert.equal(payload.authMode, "token");
    // Minimal probe: no hostname, lan addresses, node id, or agent count.
    assert.equal(payload.host, undefined);
    assert.equal(payload.lanAddresses, undefined);
    assert.equal(payload.nodeId, undefined);
    assert.equal(payload.agents, undefined);
  } finally {
    await close(server);
  }
});

test("a none-mode broker accepts tokenless register and admin requests", async () => {
  const server = createBroker({ authMode: "none" });
  try {
    const port = await listen(server);
    const probe = await fetch(`http://127.0.0.1:${port}/broker`);
    assert.equal((await probe.json()).authMode, "none");

    const register = await fetch(`http://127.0.0.1:${port}/agent/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "trusted-agent" }),
    });
    assert.equal(register.status, 200, "register works with no token/signature");
    const { agentId } = await register.json();
    assert.ok(agentId);

    const agents = await fetch(`http://127.0.0.1:${port}/agents`);
    assert.equal(agents.status, 200, "/agents works with no token");
    const payload = await agents.json();
    assert.equal(payload.agents.length, 1);
    assert.equal(payload.agents[0].name, "trusted-agent");
  } finally {
    await close(server);
  }
});

test("a none-mode broker rejects stale unknown-agent traffic cleanly", async () => {
  const server = createBroker({ authMode: "none" });
  try {
    const port = await listen(server);
    for (const route of ["poll", "result", "output"]) {
      const response = await fetch(`http://127.0.0.1:${port}/agent/missing/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /unknown agent/i);
    }
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok, true);
  } finally {
    await close(server);
  }
});

test("token mode grandfathers unsigned pre-signing peers (0.14)", async () => {
  const token = generateToken();
  const server = createBroker({ token });
  try {
    const port = await listen(server);
    // No signature headers, correct bearer, no x-lcr-version → treated as 0.14.
    const response = await fetch(`http://127.0.0.1:${port}/agent/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "legacy-agent" }),
    });
    assert.equal(response.status, 200, "unsigned 0.14 peer is accepted");
  } finally {
    await close(server);
  }
});

test("token mode rejects a modern peer that omits its signature", async () => {
  const token = generateToken();
  const server = createBroker({ token });
  try {
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/agent/register`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-lcr-version": "3",
      },
      body: JSON.stringify({ name: "misbehaving-peer" }),
    });
    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.match(payload.error, /signature/i);
  } finally {
    await close(server);
  }
});

test("a tokenless agent registers with a none-mode broker", async () => {
  const server = createBroker({ authMode: "none" });
  const previousToken = process.env.LCR_TOKEN;
  process.env.LCR_TOKEN = generateToken();
  try {
    const port = await listen(server);
    const connection = createAgentConnection({
      url: `http://127.0.0.1:${port}`,
      token: "",
      allowUnauthenticated: true,
      name: "auto-agent",
      id: "auto-agent-id",
    });
    try {
      let agentId;
      for (let i = 0; i < 100 && !agentId; i += 1) {
        const response = await fetch(`http://127.0.0.1:${port}/agents`);
        const payload = await response.json();
        if (payload.agents.length) agentId = payload.agents[0].id;
        else await sleep(50);
      }
      assert.ok(agentId, "the tokenless agent registered");
    } finally {
      connection.stop();
    }
  } finally {
    if (previousToken == null) delete process.env.LCR_TOKEN;
    else process.env.LCR_TOKEN = previousToken;
    await close(server);
  }
});

test("a token-bearing agent registers once against a none-mode broker and runs jobs", async () => {
  // Regression: a saved token made the agent sign its requests, but a
  // --trust-lan broker cannot sign replies. The agent then rejected every
  // response ("Missing response signature"), re-registered every two seconds,
  // and never polled — so accepted jobs stayed queued forever.
  const events = [];
  const audit = {
    write(record) {
      events.push(record);
      return true;
    },
  };
  const server = createBroker({ authMode: "none", audit });
  try {
    const port = await listen(server);
    const connection = createAgentConnection({
      url: `http://127.0.0.1:${port}`,
      token: "saved-broker-token",
      name: "token-agent",
      id: "token-agent-id",
      audit,
      log: () => {},
      logError: () => {},
    });
    try {
      await sleep(2500);
      const registrations = events.filter((event) => event.event === "agent.register");
      assert.equal(registrations.length, 1, "the agent registers once instead of looping");
      assert.equal(connection.agentId, "token-agent-id");

      const submitted = await fetch(`http://127.0.0.1:${port}/agents/token-agent-id/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: [process.execPath, "--version"], stream: true }),
      });
      assert.equal(submitted.status, 202);
      const { jobId } = await submitted.json();

      let status = "queued";
      for (let i = 0; i < 60 && status !== "done"; i += 1) {
        await sleep(100);
        const listing = await (await fetch(`http://127.0.0.1:${port}/jobs`)).json();
        const job = listing.jobs.find((entry) => entry.id === jobId);
        if (job) status = job.status;
      }
      assert.equal(status, "done", "the queued job was claimed and finished");
      assert.ok(
        events.some((event) => event.event === "job.start"),
        "the agent started the job"
      );
    } finally {
      await connection.stop();
    }
  } finally {
    await close(server);
  }
});

test("re-registering an agent id keeps its queued jobs", async () => {
  const server = createBroker({ authMode: "none" });
  try {
    const port = await listen(server);
    const register = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/agent/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "sticky-agent", name: "sticky" }),
      });
      return response.json();
    };

    await register();
    const submitted = await fetch(`http://127.0.0.1:${port}/agents/sticky-agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: [process.execPath, "--version"], stream: true }),
    });
    assert.equal(submitted.status, 202);
    const { jobId } = await submitted.json();

    await register(); // reconnect while the job is still queued

    const poll = await fetch(`http://127.0.0.1:${port}/agent/sticky-agent/poll?timeoutMs=0`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const claimed = await poll.json();
    assert.equal(claimed.job && claimed.job.id, jobId, "the queued job survived re-registration");
  } finally {
    await close(server);
  }
});

test("a long-poll from a replaced connection retires without stealing a job", async () => {
  const server = createBroker({ authMode: "none" });
  try {
    const port = await listen(server);
    const register = async () => {
      await fetch(`http://127.0.0.1:${port}/agent/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "epoch-agent", name: "epoch" }),
      });
    };

    await register();
    const stalePoll = fetch(`http://127.0.0.1:${port}/agent/epoch-agent/poll?timeoutMs=10000`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await sleep(100);

    await register(); // rotates the agent record while the poll is parked
    const retired = await (await stalePoll).json();
    assert.equal(retired.job, null, "the superseded long-poll returns empty");

    const submitted = await fetch(`http://127.0.0.1:${port}/agents/epoch-agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: [process.execPath, "--version"], stream: true }),
    });
    const { jobId } = await submitted.json();

    const poll = await fetch(`http://127.0.0.1:${port}/agent/epoch-agent/poll?timeoutMs=0`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const claimed = await poll.json();
    assert.equal(claimed.job && claimed.job.id, jobId, "the newest connection claims the job");
  } finally {
    await close(server);
  }
});

test("a none-mode broker signs replies for a caller that signs its requests", async () => {
  // An agent whose saved config still carries a broker token signs every
  // request; a --trust-lan broker does not authenticate it but must not answer
  // unsigned, or that agent rejects the reply and never stops re-registering.
  const { signedFetchJson } = require("../lib/transport");
  const server = createBroker({ authMode: "none" });
  try {
    const port = await listen(server);
    const result = await signedFetchJson(`http://127.0.0.1:${port}/agent/register`, {
      method: "POST",
      token: generateToken(),
      body: { name: "legacy-token-agent" },
    });
    assert.ok(result.agentId);
    assert.ok(result.agentToken);
  } finally {
    await close(server);
  }
});

test("a tokenless direct client runs against a none-mode server", async () => {
  const server = createServer({ authMode: "none" });
  try {
    const port = await listen(server);
    const result = await runRemote({
      url: `http://127.0.0.1:${port}`,
      command: [process.execPath, "--version"],
    });
    assert.equal(result.ok, true);
    assert.match(result.stdout, /^v\d+\./);
  } finally {
    await close(server);
  }
});

test("TCP scan finds a broker via /broker", async () => {
  const server = createBroker({ authMode: "none" });
  try {
    const port = await listen(server);
    const results = await scanBrokers({ hosts: ["127.0.0.1"], range: { min: port, max: port }, timeoutMs: 500 });
    assert.equal(results.length, 1);
    assert.equal(results[0].port, port);
    assert.equal(results[0].authMode, "none");
    assert.equal(typeof results[0].protocolVersion, "number");
  } finally {
    await close(server);
  }
});

test("TCP fallback enumerates hosts instead of the subnet broadcast address", () => {
  const hosts = subnetHostAddresses("192.168.50.42", "255.255.255.0");
  assert.equal(hosts.length, 254);
  assert.equal(hosts[0], "192.168.50.1");
  assert.equal(hosts.at(-1), "192.168.50.254");
  assert.ok(hosts.includes("192.168.50.42"));
  assert.ok(!hosts.includes("192.168.50.255"));
});

test("TCP fallback bounds large subnets to the interface local /24", () => {
  const hosts = subnetHostAddresses("10.25.14.9", "255.0.0.0");
  assert.equal(hosts.length, 254);
  assert.equal(hosts[0], "10.25.14.1");
  assert.equal(hosts.at(-1), "10.25.14.254");
});
