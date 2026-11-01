const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createBroker } = require("../lib/broker");
const { generateToken } = require("../lib/auth");
const { describeVerificationFailure, signedFetchJson } = require("../lib/transport");
const { acquireInstanceLock, lockPath, pidIsAlive } = require("../lib/instance-lock");
const { makeTempDir, removeTempDir, runNode, spawnNode, killChild, waitFor } = require("../scripts/test-helpers");

const CLI = path.join(__dirname, "..", "bin", "lcr-cli.js");

function isolatedEnv(configDir, extra = {}) {
  return { LCR_CONFIG: path.join(configDir, "config.json"), ...extra };
}

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

// /agents is authenticated in token mode, so the probe has to sign like a client.
async function listedAgents(url, token) {
  const payload = await signedFetchJson(`${url}/agents`, { token });
  return payload.agents || [];
}

test("agent --help prints usage and does not start an agent", async () => {
  const dir = makeTempDir("help-agent");
  try {
    const result = await runNode([CLI, "agent", "--help"], isolatedEnv(dir), { timeoutMs: 20000 });
    assert.equal(result.timedOut, false, "--help must not run the agent forever");
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(
      fs.existsSync(path.join(dir, "locks")),
      false,
      "--help must not create an agent instance lock"
    );
  } finally {
    removeTempDir(dir);
  }
});

test("agent -h prints usage too", async () => {
  const dir = makeTempDir("help-agent-short");
  try {
    const result = await runNode([CLI, "agent", "-h"], isolatedEnv(dir), { timeoutMs: 20000 });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
  } finally {
    removeTempDir(dir);
  }
});

test("broker --help does not bind a port", async () => {
  const dir = makeTempDir("help-broker");
  try {
    const result = await runNode([CLI, "broker", "--help"], isolatedEnv(dir), { timeoutMs: 20000 });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
  } finally {
    removeTempDir(dir);
  }
});

test("-h after -- belongs to the remote command, not to the CLI", async () => {
  const dir = makeTempDir("help-remote");
  try {
    // Nothing listens on this port: the CLI must try to connect and fail rather
    // than print usage and exit 0.
    const result = await runNode(
      [CLI, "exec", "some-agent", "--url", "http://127.0.0.1:9", "--no-stream", "--", "cmd", "-h"],
      isolatedEnv(dir),
      { timeoutMs: 20000 }
    );
    assert.equal(result.stdout.includes("Usage:"), false, "a remote -h must not trigger local help");
    assert.notEqual(result.code, 0, "an unreachable broker is an error, not a help exit");
  } finally {
    removeTempDir(dir);
  }
});

test("a second agent process for the same broker and id is refused with a clear message", async () => {
  const dir = makeTempDir("dup-agent");
  const token = generateToken();
  const server = createBroker({ token });
  let first = null;
  try {
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}`;
    const env = isolatedEnv(dir, { LCR_TOKEN: token });

    first = spawnNode([CLI, "agent", "--url", url, "--name", "dupnode", "--id", "dupnode"], env);
    let firstStderr = "";
    first.stderr.on("data", (chunk) => {
      firstStderr += chunk.toString("utf8");
    });

    await waitFor(
      async () => {
        const agents = await listedAgents(url, token);
        return agents.some((agent) => agent.id === "dupnode");
      },
      { description: "the first agent to register" }
    );

    const second = await runNode(
      [CLI, "agent", "--url", url, "--name", "dupnode", "--id", "dupnode"],
      env,
      { timeoutMs: 20000 }
    );

    assert.equal(second.timedOut, false, "the duplicate agent must exit instead of polling");
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already running/);
    assert.match(second.stderr, /--allow-multiple-agents/);
    assert.equal(firstStderr.includes("already running"), false, "the first agent keeps running");
    assert.equal(first.exitCode, null, "the first agent must not be disturbed");
  } finally {
    if (first) await killChild(first);
    await close(server);
    removeTempDir(dir);
  }
});

test("--allow-multiple-agents overrides the guard on purpose", async () => {
  const dir = makeTempDir("dup-override");
  const token = generateToken();
  const server = createBroker({ token });
  const children = [];
  try {
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}`;
    const env = isolatedEnv(dir, { LCR_TOKEN: token });

    const first = spawnNode([CLI, "agent", "--url", url, "--name", "twonodes", "--id", "twonodes"], env);
    children.push(first);
    await waitFor(
      async () => {
        const agents = await listedAgents(url, token);
        return agents.some((agent) => agent.id === "twonodes");
      },
      { description: "the first agent to register" }
    );

    const second = spawnNode(
      [CLI, "agent", "--url", url, "--name", "twonodes", "--id", "twonodes", "--allow-multiple-agents"],
      env
    );
    children.push(second);
    let secondStderr = "";
    second.stderr.on("data", (chunk) => {
      secondStderr += chunk.toString("utf8");
    });

    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(second.exitCode, null, "the override must let the second agent stay up");
    assert.equal(secondStderr.includes("already running"), false);
  } finally {
    for (const child of children) await killChild(child);
    await close(server);
    removeTempDir(dir);
  }
});

test("agent --url attaches to a --trust-lan broker with no token at all", async () => {
  const dir = makeTempDir("tokenless");
  const server = createBroker({ authMode: "none" });
  const children = [];
  try {
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}`;

    const child = spawnNode([CLI, "agent", "--url", url, "--name", "tokenless", "--id", "tokenless"], isolatedEnv(dir));
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    await waitFor(
      async () => {
        const response = await fetch(`${url}/agents`);
        const payload = await response.json();
        return (payload.agents || []).some((agent) => agent.id === "tokenless");
      },
      { description: "a tokenless agent to register on a trust-lan broker" }
    );
    assert.equal(child.exitCode, null);
    assert.equal(stderr.includes("Missing token"), false);
  } finally {
    for (const child of children) await killChild(child);
    await close(server);
    removeTempDir(dir);
  }
});

test("the instance lock ignores a dead holder and refuses a live one", async () => {
  const dir = makeTempDir("lock-unit");
  const previous = process.env.LCR_CONFIG;
  try {
    process.env.LCR_CONFIG = path.join(dir, "config.json");
    const identity = "http://example.invalid:8765\nlocknode";

    const dead = acquireInstanceLock({ identity, label: "locknode" });
    assert.equal(dead.ok, true);
    fs.writeFileSync(dead.path, JSON.stringify({ pid: 999999999, label: "ghost" }));

    const takeover = acquireInstanceLock({ identity, label: "locknode" });
    assert.equal(takeover.ok, true, "a dead PID must not block the next start");
    assert.equal(takeover.tookOver, true);
    assert.equal(pidIsAlive(999999999), false);
  } finally {
    if (previous === undefined) delete process.env.LCR_CONFIG;
    else process.env.LCR_CONFIG = previous;
    removeTempDir(dir);
  }
});

test("one agent per broker even when the url is formatted differently", async () => {
  const dir = makeTempDir("dup-url");
  const token = generateToken();
  const server = createBroker({ token });
  let first = null;
  try {
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const env = isolatedEnv(dir, { LCR_TOKEN: token });

    first = spawnNode([CLI, "agent", "--url", base, "--name", "urlform", "--id", "urlform"], env);
    await waitFor(
      async () => (await listedAgents(base, token)).some((agent) => agent.id === "urlform"),
      { description: "the first agent to register" }
    );

    const second = await runNode(
      [CLI, "agent", "--url", `${base}/`, "--name", "urlform", "--id", "urlform"],
      env,
      { timeoutMs: 20000 }
    );
    assert.equal(second.timedOut, false, "the equivalent url must be refused, not started");
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already running/);
  } finally {
    if (first) await killChild(first);
    await close(server);
    removeTempDir(dir);
  }
});

test("releasing a connection's lock never evicts a newer owner", () => {
  const dir = makeTempDir("lock-release");
  const previous = process.env.LCR_CONFIG;
  try {
    process.env.LCR_CONFIG = path.join(dir, "config.json");
    const identity = "http://127.0.0.1:1\nreleasenode";

    const first = acquireInstanceLock({ identity, label: "releasenode" });
    assert.equal(first.ok, true);
    const second = acquireInstanceLock({ identity, label: "releasenode" });
    assert.equal(second.ok, true, "a reconnect in this process retakes the slot");

    assert.equal(first.release(), false, "a superseded handle must not delete the newer record");
    assert.equal(fs.existsSync(second.path), true);

    assert.equal(second.release(), true, "the owner releases its own record");
    assert.equal(fs.existsSync(second.path), false);

    const third = acquireInstanceLock({ identity, label: "releasenode" });
    assert.equal(third.ok, true, "a released slot is immediately usable");
    third.release();
  } finally {
    if (previous === undefined) delete process.env.LCR_CONFIG;
    else process.env.LCR_CONFIG = previous;
    removeTempDir(dir);
  }
});

test("concurrent takeovers of a dead holder elect exactly one owner", async () => {
  const dir = makeTempDir("lock-race");
  const previous = process.env.LCR_CONFIG;
  const children = [];
  try {
    process.env.LCR_CONFIG = path.join(dir, "config.json");
    const identity = "http://127.0.0.1:1\nracenode";
    const file = lockPath("agent", identity);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Every racer starts from the same dead record, which is the state left
    // behind by a force-killed agent.
    fs.writeFileSync(file, JSON.stringify({ pid: 999999999, label: "ghost" }));

    const modulePath = path.join(__dirname, "..", "lib", "instance-lock.js");
    const script = `
      const { acquireInstanceLock } = require(${JSON.stringify(modulePath)});
      const lock = acquireInstanceLock({ identity: process.argv[1], label: "racenode" });
      process.stdout.write((lock.ok ? "OK " : "REFUSED ") + process.pid + "\\n");
      if (lock.ok) setTimeout(() => process.exit(0), 600);
    `;

    for (let index = 0; index < 5; index += 1) children.push(spawnNode(["-e", script, identity], isolatedEnv(dir)));

    const outputs = await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            let text = "";
            child.stdout.on("data", (chunk) => {
              text += chunk.toString("utf8");
            });
            child.on("close", () => resolve(text));
            setTimeout(() => resolve(text), 15000).unref();
          })
      )
    );

    const winners = outputs.filter((text) => text.startsWith("OK "));
    assert.equal(
      winners.length,
      1,
      `exactly one takeover may win, got ${winners.length}: ${JSON.stringify(outputs)}`
    );
    assert.equal(outputs.filter((text) => text.startsWith("REFUSED ")).length, 4);
  } finally {
    for (const child of children) await killChild(child);
    if (previous === undefined) delete process.env.LCR_CONFIG;
    else process.env.LCR_CONFIG = previous;
    removeTempDir(dir);
  }
});

test("a missing response signature names the peer and the remedy", () => {
  const message = describeVerificationFailure("Missing response signature.", "http://10.0.0.5:8765/agent/x/poll?timeoutMs=1");
  assert.match(message, /http:\/\/10\.0\.0\.5:8765/);
  assert.match(message, /older than 0\.15|--trust-lan/);
  assert.match(message, /Retrying cannot fix this/);
  assert.equal(message.includes("/agent/x/poll"), false, "only the origin is reported");

  const other = describeVerificationFailure("Invalid response signature.", "http://10.0.0.5:8765");
  assert.equal(other, "Response signature verification failed: Invalid response signature.");
});
