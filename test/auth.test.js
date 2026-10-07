const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AuthThrottle,
  bearerToken,
  generateAgentToken,
  generateNodeId,
  generateToken,
  tokensEqual,
  verifyBearer,
} = require("../lib/auth");
const { createBroker } = require("../lib/broker");
const { createServer } = require("../lib/server");

// This suite exercises throttling, not request signing; allow unsigned
// requests so the assertions focus on the failure/lockout behaviour.
process.env.LCR_ALLOW_UNSIGNED = "1";

test("tokensEqual is true only for identical non-empty strings", () => {
  assert.equal(tokensEqual("abc123", "abc123"), true);
  assert.equal(tokensEqual("abc123", "abc124"), false);
  assert.equal(tokensEqual("abc123", "abc1234"), false);
  assert.equal(tokensEqual("", ""), false);
  assert.equal(tokensEqual("abc", ""), false);
  assert.equal(tokensEqual(null, "abc"), false);
  assert.equal(tokensEqual(undefined, undefined), false);
});

test("generateAgentToken produces 128 bits of base64url", () => {
  const token = generateAgentToken();
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(token, "base64url").length, 16);
  assert.notEqual(generateAgentToken(), generateAgentToken());
});

test("generateToken produces 192 bits and generateNodeId is readable", () => {
  const token = generateToken();
  assert.equal(Buffer.from(token, "base64url").length, 24);
  const id = generateNodeId("agent");
  assert.match(id, /^agent-[0-9a-f]{16}$/);
});

test("bearerToken parses only well-formed credentials", () => {
  assert.equal(bearerToken({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(bearerToken({ headers: { authorization: "bearer  abc  " } }), "abc");
  assert.equal(bearerToken({ headers: { authorization: "Basic abc" } }), "");
  assert.equal(bearerToken({ headers: { authorization: "Bearer" } }), "");
  assert.equal(bearerToken({ headers: {} }), "");
  assert.equal(bearerToken(null), "");
  assert.equal(verifyBearer({ headers: { authorization: "Bearer abc" } }, "abc"), true);
  assert.equal(verifyBearer({ headers: { authorization: "Bearer abc" } }, ""), false);
});

test("AuthThrottle locks after the failure limit and clears on success", () => {
  const throttle = new AuthThrottle({ limit: 3, windowMs: 1000, lockoutMs: 5000 });
  const now = 1_000_000;
  assert.equal(throttle.lockedForMs("10.0.0.1", now), 0);
  assert.equal(throttle.recordFailure("10.0.0.1", now).locked, false);
  assert.equal(throttle.recordFailure("10.0.0.1", now + 1).locked, false);
  const third = throttle.recordFailure("10.0.0.1", now + 2);
  assert.equal(third.locked, true);
  assert.ok(throttle.lockedForMs("10.0.0.1", now + 2) > 0);
  // A different address is unaffected.
  assert.equal(throttle.lockedForMs("10.0.0.2", now + 2), 0);
  // The lockout expires.
  assert.equal(throttle.lockedForMs("10.0.0.1", now + 2 + 5001), 0);
  // Success clears the record.
  throttle.recordFailure("10.0.0.3", now);
  throttle.recordSuccess("10.0.0.3");
  assert.equal(throttle.size, 1, "only the locked entry remains");
  // Failures older than the window do not accumulate.
  const slow = new AuthThrottle({ limit: 2, windowMs: 100, lockoutMs: 1000 });
  slow.recordFailure("10.0.0.9", 0);
  assert.equal(slow.recordFailure("10.0.0.9", 500).locked, false);
});

async function withServer(server, run) {
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

test("the broker answers 401 up to the limit, then 429 with Retry-After", async () => {
  const previous = process.env.LCR_AUTH_FAILURE_LIMIT;
  process.env.LCR_AUTH_FAILURE_LIMIT = "3";
  const server = createBroker({ token: generateToken() });
  try {
    await withServer(server, async (port) => {
      const attempt = async () => {
        const response = await fetch(`http://127.0.0.1:${port}/agents`, {
          headers: { authorization: "Bearer wrong-token" },
        });
        return { status: response.status, retryAfter: response.headers.get("retry-after") };
      };
      assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 401);
      const locked = await attempt();
      assert.equal(locked.status, 429);
      assert.ok(Number(locked.retryAfter) > 0, "Retry-After is present");
      // Still locked, and still not revealing anything about the token.
      const again = await attempt();
      assert.equal(again.status, 429);
    });
  } finally {
    if (previous === undefined) delete process.env.LCR_AUTH_FAILURE_LIMIT;
    else process.env.LCR_AUTH_FAILURE_LIMIT = previous;
  }
});

test("a valid token succeeds and resets the failure window", async () => {
  const previous = process.env.LCR_AUTH_FAILURE_LIMIT;
  process.env.LCR_AUTH_FAILURE_LIMIT = "3";
  const token = generateToken();
  const server = createBroker({ token });
  try {
    await withServer(server, async (port) => {
      const bad = () =>
        fetch(`http://127.0.0.1:${port}/agents`, { headers: { authorization: "Bearer wrong" } });
      const good = () =>
        fetch(`http://127.0.0.1:${port}/agents`, { headers: { authorization: `Bearer ${token}` } });

      await bad();
      await bad();
      assert.equal((await good()).status, 200, "valid token still works below the limit");
      await bad();
      await bad();
      assert.equal((await good()).status, 200, "success reset the window");
    });
  } finally {
    if (previous === undefined) delete process.env.LCR_AUTH_FAILURE_LIMIT;
    else process.env.LCR_AUTH_FAILURE_LIMIT = previous;
  }
});

test("direct server mode also throttles failed authentication", async () => {
  const previous = process.env.LCR_AUTH_FAILURE_LIMIT;
  process.env.LCR_AUTH_FAILURE_LIMIT = "2";
  const server = createServer({ token: generateToken() });
  try {
    await withServer(server, async (port) => {
      const attempt = () =>
        fetch(`http://127.0.0.1:${port}/run`, {
          method: "POST",
          headers: { authorization: "Bearer nope", "content-type": "application/json" },
          body: JSON.stringify({ command: ["node", "-v"] }),
        });
      assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 429);
    });
  } finally {
    if (previous === undefined) delete process.env.LCR_AUTH_FAILURE_LIMIT;
    else process.env.LCR_AUTH_FAILURE_LIMIT = previous;
  }
});

test("agent credentials are 128-bit and agent ids do not leak token material", async () => {
  const token = generateToken();
  const server = createBroker({ token });
  await withServer(server, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/agent/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "entropy-check" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(Buffer.from(payload.agentToken, "base64url").length, 16, "128-bit agent token");
    assert.match(payload.agentId, /^agent-[0-9a-f]{16}$/, "node id is a readable 64-bit identifier");
  });
});
