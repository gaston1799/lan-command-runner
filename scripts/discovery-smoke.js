const dgram = require("node:dgram");
const {
  DISCOVERY_PROTOCOL,
  DISCOVERY_VERSION,
  createDiscoveryResponder,
  discover,
  parseDatagram,
} = require("../lib/discovery");
const { generateToken } = require("../lib/server");
const { assert, assertEqual, createRunner } = require("./test-helpers");

const DISCOVERY_PORT = 18871;
const BROKER_PORT = 18872;
const NODE_ID = "discovery-test-node";
const NODE_NAME = "Discovery Test Node";
const runner = createRunner("discovery smoke");

function sendQuery(port, payload, waitMs = 1500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const responses = [];
    socket.on("message", (message) => responses.push(message));
    socket.bind(0, () => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      socket.send(body, port, "127.0.0.1", () => {
        setTimeout(() => socket.close(() => resolve(responses)), waitMs);
      });
    });
  });
}

function sendBurst(port, payload, count, waitMs = 700) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const responses = [];
    socket.on("message", (message) => responses.push(message));
    socket.bind(0, "127.0.0.1", () => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      for (let index = 0; index < count; index += 1) socket.send(body, port, "127.0.0.1");
      setTimeout(() => socket.close(() => resolve(responses)), waitMs);
    });
  });
}

async function main() {
  // The token exists only to prove it never reaches the wire.
  const brokerToken = generateToken();

  const responder = createDiscoveryResponder({
    port: DISCOVERY_PORT,
    nodeId: NODE_ID,
    nodeName: NODE_NAME,
    brokerPort: BROKER_PORT,
    onError: (message) => console.error(`[discovery-smoke] responder: ${message}`),
  });

  const ready = await responder.ready;
  if (!ready.ok) {
    console.error(`discovery smoke skipped: ${ready.error}`);
    await responder.stop();
    return;
  }

  try {
    await runner.test("a versioned query gets a versioned response", async () => {
      const responses = await sendQuery(DISCOVERY_PORT, {
        protocol: DISCOVERY_PROTOCOL,
        v: DISCOVERY_VERSION,
        type: "query",
        nonce: "abc123",
      });
      assertEqual(responses.length, 1, "exactly one response");
      const payload = parseDatagram(responses[0]);
      assert(payload, "response parses as a discovery datagram");
      assertEqual(payload.type, "response", "response type");
      assertEqual(payload.v, DISCOVERY_VERSION, "protocol version echoed");
      assertEqual(payload.nodeId, NODE_ID, "node id advertised");
      assertEqual(payload.nodeName, NODE_NAME, "node name advertised");
      assertEqual(payload.brokerPort, BROKER_PORT, "broker port advertised");
      assertEqual(payload.healthPath, "/health", "health path advertised");
      assertEqual(payload.nonce, "abc123", "nonce echoed so replies can be correlated");
    });

    await runner.test("the advertisement carries no secrets and no extra fields", async () => {
      const responses = await sendQuery(DISCOVERY_PORT, {
        protocol: DISCOVERY_PROTOCOL,
        v: DISCOVERY_VERSION,
        type: "query",
      });
      assertEqual(responses.length, 1, "exactly one response");
      const raw = responses[0].toString("utf8");
      assert(!raw.includes(brokerToken), "no broker token on the wire");
      assert(!/token|secret|authorization|password/i.test(raw), "no secret-shaped key on the wire");

      const keys = Object.keys(parseDatagram(responses[0])).sort();
      const allowed = ["brokerPort", "healthPath", "nodeId", "nodeName", "protocol", "type", "v"];
      assertEqual(
        keys.join(","),
        allowed.join(","),
        "advertisement exposes only identity and where to look"
      );
    });

    await runner.test("foreign, malformed, and mismatched-version datagrams are ignored", async () => {
      const cases = [
        { protocol: "something-else", v: 1, type: "query" },
        { protocol: DISCOVERY_PROTOCOL, v: 99, type: "query" },
        { protocol: DISCOVERY_PROTOCOL, v: DISCOVERY_VERSION, type: "response" },
      ];
      for (const payload of cases) {
        const responses = await sendQuery(DISCOVERY_PORT, payload, 600);
        assertEqual(responses.length, 0, `ignored: ${JSON.stringify(payload)}`);
      }
    });

    await runner.test("discover() derives the address from the UDP sender", async () => {
      const result = await discover({
        port: DISCOVERY_PORT,
        waitMs: 1200,
        targets: ["127.0.0.1"],
        selfNodeId: NODE_ID,
      });
      assertEqual(result.ok, true, "discovery ran");
      const node = result.nodes.find((entry) => entry.nodeId === NODE_ID);
      assert(node, "the responder was discovered");
      assertEqual(node.address, "127.0.0.1", "address comes from the sender, not the payload");
      assertEqual(node.brokerUrl, `http://127.0.0.1:${BROKER_PORT}`, "broker url built from observed address");
      assertEqual(node.healthUrl, `http://127.0.0.1:${BROKER_PORT}/health`, "health url built from observed address");
      assertEqual(node.self, true, "self node is labelled");
      assert(!JSON.stringify(result).includes(brokerToken), "discovery result carries no token");
    });

    await runner.test("a bind conflict is reported, not thrown", async () => {
      const conflicting = createDiscoveryResponder({
        port: DISCOVERY_PORT,
        nodeId: "conflict",
        nodeName: "Conflict",
        brokerPort: BROKER_PORT,
        onError: () => {},
      });
      const result = await conflicting.ready;
      await conflicting.stop();
      // reuseAddr means the OS may allow the second bind; either outcome is
      // acceptable as long as nothing throws and the error is descriptive.
      if (!result.ok) assert(/already in use|refused|socket error/i.test(result.error), "bind failure is descriptive");
    });

    await runner.test("discovery against a silent port returns empty, not an error", async () => {
      const result = await discover({ port: 18899, waitMs: 400, targets: ["127.0.0.1"] });
      assertEqual(result.ok, true, "discovery completes");
      assertEqual(result.nodes.length, 0, "no nodes found");
    });

    await runner.test("responses cap identity size and rate-limit one source address", async () => {
      const hardenedPort = 18873;
      const hardened = createDiscoveryResponder({
        port: hardenedPort,
        host: "127.0.0.1",
        nodeId: "i".repeat(200),
        nodeName: "n".repeat(1000),
        brokerPort: BROKER_PORT,
        onError: () => {},
      });
      const hardenedReady = await hardened.ready;
      assertEqual(hardenedReady.ok, true, "hardened responder bound to the requested host");
      try {
        const responses = await sendBurst(
          hardenedPort,
          { protocol: DISCOVERY_PROTOCOL, v: DISCOVERY_VERSION, type: "query", nonce: "burst" },
          20
        );
        assert(responses.length >= 1 && responses.length <= 5, "one source receives at most the configured burst");
        const payload = parseDatagram(responses[0]);
        assertEqual(payload.nodeId.length, 64, "node id is capped");
        assertEqual(payload.nodeName.length, 64, "node name is capped");
      } finally {
        await hardened.stop();
      }
    });
  } finally {
    await responder.stop();
  }

  runner.finish();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
