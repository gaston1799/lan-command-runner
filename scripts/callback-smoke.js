const net = require("node:net");
const { createBroker } = require("../lib/broker");
const { generateToken } = require("../lib/server");
const { buildRequestHeaders } = require("../lib/sign");
const { assert, assertEqual, createRunner } = require("./test-helpers");

const CALLER_PORT = 18881;
const TARGET_PORT = 18882;
const SILENT_PORT = 18883;
const CLOSED_PORT = 18884;

const CALLER_NODE_ID = "callback-caller";
const TARGET_NODE_ID = "callback-target";

const runner = createRunner("callback smoke");

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// A server still holding a connection does not reliably fire its close
// callback on Windows, so drop the sockets first and bound the wait.
function close(server, sockets = []) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    for (const socket of sockets) socket.destroy();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    setTimeout(finish, 2000).unref();
  });
}

async function callback(port, token, body) {
  const rawBody = JSON.stringify(body);
  const response = await fetch(`http://127.0.0.1:${port}/diagnostics/callback`, {
    method: "POST",
    headers: {
      ...(token
        ? {
            authorization: `Bearer ${token}`,
            ...buildRequestHeaders({ secret: token, method: "POST", path: "/diagnostics/callback", body: rawBody }),
          }
        : {}),
      "content-type": "application/json",
    },
    body: rawBody,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { status: response.status, payload, raw: text };
}

async function main() {
  const callerToken = generateToken();
  const targetToken = generateToken();

  // "caller" is the broker we ask to perform the callback. Because the request
  // arrives from loopback, the only host it may probe is 127.0.0.1.
  const caller = createBroker({ token: callerToken, nodeId: CALLER_NODE_ID, nodeName: "Caller" });
  const target = createBroker({ token: targetToken, nodeId: TARGET_NODE_ID, nodeName: "Target" });
  const silentSockets = new Set();
  const silent = net.createServer((socket) => {
    // Accept the connection and never answer, to exercise the abort timeout.
    silentSockets.add(socket);
    socket.on("close", () => silentSockets.delete(socket));
  });

  await listen(caller, CALLER_PORT);
  await listen(target, TARGET_PORT);
  await new Promise((resolve) => silent.listen(SILENT_PORT, "127.0.0.1", resolve));

  try {
    await runner.test("the callback endpoint requires the broker admin token", async () => {
      const anonymous = await callback(CALLER_PORT, null, { port: TARGET_PORT, expectedNodeId: TARGET_NODE_ID });
      assertEqual(anonymous.status, 401, "no token is rejected");

      const wrong = await callback(CALLER_PORT, targetToken, { port: TARGET_PORT, expectedNodeId: TARGET_NODE_ID });
      assertEqual(wrong.status, 401, "another node's token is rejected");
      assert(!wrong.raw.includes(callerToken), "the 401 body leaks no token");
    });

    await runner.test("agent endpoints do not reveal whether an agent id exists", async () => {
      const registerBody = JSON.stringify({ id: "oracle-agent", name: "Oracle Agent" });
      const registrationResponse = await fetch(`http://127.0.0.1:${CALLER_PORT}/agent/register`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${callerToken}`,
          "content-type": "application/json",
          ...buildRequestHeaders({ secret: callerToken, method: "POST", path: "/agent/register", body: registerBody }),
        },
        body: registerBody,
      });
      assertEqual(registrationResponse.status, 200, "test agent registered");

      const probe = async (id) => {
        const response = await fetch(`http://127.0.0.1:${CALLER_PORT}/agent/${id}/poll?timeoutMs=1`, {
          method: "POST",
          headers: { authorization: "Bearer definitely-wrong" },
        });
        return { status: response.status, body: await response.text() };
      };
      const known = await probe("oracle-agent");
      const unknown = await probe("missing-agent");
      assertEqual(known.status, 401, "known id with wrong token is unauthorized");
      assertEqual(unknown.status, 401, "unknown id is also unauthorized");
      assertEqual(unknown.body, known.body, "the response body does not distinguish id existence");
    });

    await runner.test("a verified callback reports the observed address and scope", async () => {
      const result = await callback(CALLER_PORT, callerToken, {
        port: TARGET_PORT,
        expectedNodeId: TARGET_NODE_ID,
      });
      assertEqual(result.status, 200, "authorized request succeeds");
      assertEqual(result.payload.reachable, true, "target was reached");
      assertEqual(result.payload.observedAddress, "127.0.0.1", "observed address is the socket peer");
      assertEqual(result.payload.scope, "local", "loopback is labelled local, not public");
      assertEqual(result.payload.testedUrl, `http://127.0.0.1:${TARGET_PORT}/health`, "tested url");
      assertEqual(result.payload.error, null, "no error on success");
      assert(typeof result.payload.latencyMs === "number", "latency is reported");
      assert(!result.raw.includes(callerToken) && !result.raw.includes(targetToken), "no token in the response");
    });

    await runner.test("host, url, path, and protocol from the body are all ignored", async () => {
      const result = await callback(CALLER_PORT, callerToken, {
        host: "169.254.169.254",
        address: "10.0.0.1",
        url: "http://internal.example.com/admin",
        path: "/etc/passwd",
        protocol: "file",
        port: TARGET_PORT,
        expectedNodeId: TARGET_NODE_ID,
      });
      assertEqual(result.status, 200, "request still processed");
      assertEqual(result.payload.observedAddress, "127.0.0.1", "attacker-supplied host ignored");
      assertEqual(
        result.payload.testedUrl,
        `http://127.0.0.1:${TARGET_PORT}/health`,
        "only the observed address, declared port, and /health are used"
      );
      assert(!result.raw.includes("169.254.169.254"), "the supplied host never appears in the result");
      assert(!result.raw.includes("passwd"), "the supplied path never appears in the result");
    });

    await runner.test("a node id mismatch fails even though the broker answered", async () => {
      const result = await callback(CALLER_PORT, callerToken, {
        port: TARGET_PORT,
        expectedNodeId: "some-other-node",
      });
      assertEqual(result.status, 200, "the diagnostic itself succeeds");
      assertEqual(result.payload.reachable, false, "reachability is false");
      assert(/node id did not match/i.test(result.payload.error), "the error explains the mismatch");
    });

    await runner.test("invalid ports are rejected before any request is made", async () => {
      for (const port of [0, -1, 70000, "abc", null, undefined, 8765.5]) {
        const result = await callback(CALLER_PORT, callerToken, { port, expectedNodeId: TARGET_NODE_ID });
        assertEqual(result.status, 400, `port ${JSON.stringify(port)} rejected`);
        assert(/valid broker port/i.test(result.payload.error), "the error names the port requirement");
      }
    });

    await runner.test("a missing expectedNodeId is rejected", async () => {
      const result = await callback(CALLER_PORT, callerToken, { port: TARGET_PORT });
      assertEqual(result.status, 400, "expectedNodeId is mandatory");
      assert(/expectedNodeId/.test(result.payload.error), "the error names the field");
    });

    await runner.test("a closed port reports unreachable with a sanitized error", async () => {
      const result = await callback(CALLER_PORT, callerToken, {
        port: CLOSED_PORT,
        expectedNodeId: TARGET_NODE_ID,
      });
      assertEqual(result.status, 200, "the diagnostic completes");
      assertEqual(result.payload.reachable, false, "unreachable");
      assert(result.payload.error && result.payload.error.length > 0, "an error is reported");
      assert(result.payload.error.length < 320, "the error is bounded, not a raw stack");
    });

    await runner.test("a hung target aborts at the five-second timeout", async () => {
      const startedAt = Date.now();
      const result = await callback(CALLER_PORT, callerToken, {
        port: SILENT_PORT,
        expectedNodeId: TARGET_NODE_ID,
      });
      const elapsed = Date.now() - startedAt;
      assertEqual(result.payload.reachable, false, "unreachable");
      assert(/within 5000ms/.test(result.payload.error), `timeout is reported: ${result.payload.error}`);
      assert(elapsed >= 4500 && elapsed < 12000, `aborted near the 5s budget (took ${elapsed}ms)`);
    });

    await runner.test("/health exposes node identity alongside the existing fields", async () => {
      const response = await fetch(`http://127.0.0.1:${TARGET_PORT}/health`);
      const payload = await response.json();
      assertEqual(payload.ok, true, "ok preserved");
      assertEqual(payload.mode, "broker", "mode preserved");
      assertEqual(typeof payload.host, "string", "host preserved");
      assert(Array.isArray(payload.lanAddresses), "lanAddresses preserved");
      assertEqual(typeof payload.agents, "number", "agents preserved");
      assertEqual(payload.nodeId, TARGET_NODE_ID, "nodeId added");
      assertEqual(payload.nodeName, "Target", "nodeName added");

      const challenged = await fetch(`http://127.0.0.1:${TARGET_PORT}/health?nonce=fresh-callback-challenge`);
      const challengedPayload = await challenged.json();
      assertEqual(challengedPayload.nonce, "fresh-callback-challenge", "health echoes the callback freshness challenge");
    });
  } finally {
    await close(caller);
    await close(target);
    await close(silent, Array.from(silentSockets));
  }

  runner.finish();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
