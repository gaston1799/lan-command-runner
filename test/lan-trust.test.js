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
