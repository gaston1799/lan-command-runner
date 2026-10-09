const crypto = require("node:crypto");
const dgram = require("node:dgram");
const { getBroadcastAddresses, normalizeAddress, parsePort } = require("./addr");

const DISCOVERY_PROTOCOL = "lcr-mesh";
const DISCOVERY_VERSION = 1;
const DEFAULT_DISCOVERY_PORT = 8766;
const GLOBAL_BROADCAST = "255.255.255.255";
const MAX_DATAGRAM_BYTES = 2048;
const MAX_IDENTITY_LENGTH = 64;
const RESPONSE_BURST = 5;
const RESPONSE_REFILL_PER_SECOND = 1;
const RATE_ENTRY_MAX_AGE_MS = 60000;
const MAX_RATE_ENTRIES = 1024;

// The advertisement is identity + where to look, nothing else. It carries no
// token and grants no trust: a responder answering a query only tells the
// asker that a broker exists, never that it may talk to it.
function buildAdvertisement(source) {
  return {
    protocol: DISCOVERY_PROTOCOL,
    v: DISCOVERY_VERSION,
    type: "response",
    nodeId: String(source.nodeId || "").slice(0, MAX_IDENTITY_LENGTH),
    nodeName: String(source.nodeName || "").slice(0, MAX_IDENTITY_LENGTH),
    brokerPort: parsePort(source.brokerPort) || 0,
    protocolVersion: Number(source.protocolVersion) || 0,
    authMode: source.authMode === "none" ? "none" : "token",
    healthPath: "/health",
  };
}

function parseDatagram(buffer) {
  if (buffer.length > MAX_DATAGRAM_BYTES) return null;
  let payload;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.protocol !== DISCOVERY_PROTOCOL) return null;
  if (Number(payload.v) !== DISCOVERY_VERSION) return null;
  return payload;
}

function describeBindError(error, port) {
  if (error.code === "EADDRINUSE") {
    return `discovery port ${port}/udp is already in use; another LCR node or service owns it.`;
  }
  if (error.code === "EACCES") {
    return `discovery port ${port}/udp was refused by the OS or firewall (permission denied).`;
  }
  return `discovery socket error on ${port}/udp: ${error.code || error.message}`;
}

// Answers discovery queries. Binding failures are surfaced through onError and
// never thrown, so a blocked UDP port cannot take down the supervisor.
function createDiscoveryResponder(options = {}) {
  const port = parsePort(options.port) || DEFAULT_DISCOVERY_PORT;
  const host = String(options.host || "0.0.0.0");
  const onError = options.onError || (() => {});
  const describe =
    typeof options.advertise === "function"
      ? options.advertise
      : () => ({ nodeId: options.nodeId, nodeName: options.nodeName, brokerPort: options.brokerPort });

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
  let closed = false;
  let listening = false;
  const responseBuckets = new Map();

  function allowResponse(address) {
    const now = Date.now();
    if (!responseBuckets.has(address) && responseBuckets.size >= MAX_RATE_ENTRIES) {
      responseBuckets.delete(responseBuckets.keys().next().value);
    }
    const previous = responseBuckets.get(address) || { tokens: RESPONSE_BURST, updatedAt: now };
    const elapsedSeconds = Math.max(0, now - previous.updatedAt) / 1000;
    const tokens = Math.min(RESPONSE_BURST, previous.tokens + elapsedSeconds * RESPONSE_REFILL_PER_SECOND);
    if (tokens < 1) {
      responseBuckets.set(address, { tokens, updatedAt: now });
      return false;
    }
    responseBuckets.set(address, { tokens: tokens - 1, updatedAt: now });
    if (responseBuckets.size > 256) {
      for (const [key, value] of responseBuckets) {
        if (now - value.updatedAt > RATE_ENTRY_MAX_AGE_MS) responseBuckets.delete(key);
      }
    }
    return true;
  }

  const ready = new Promise((resolve) => {
    socket.once("listening", () => {
      listening = true;
      try {
        socket.setBroadcast(true);
      } catch {
        /* broadcast is a nicety for responses; unicast replies still work */
      }
      resolve({ ok: true, host, port });
    });
    socket.once("error", (error) => {
      resolve({ ok: false, host, port, error: describeBindError(error, port) });
    });
  });

  socket.on("error", (error) => {
    if (closed) return;
    onError(describeBindError(error, port));
    closed = true;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  });

  socket.on("message", (message, rinfo) => {
    const query = parseDatagram(message);
    if (!query || query.type !== "query") return;
    if (!allowResponse(rinfo.address)) return;

    const advertisement = buildAdvertisement(describe() || {});
    if (query.nonce) advertisement.nonce = String(query.nonce).slice(0, 64);
    const body = Buffer.from(JSON.stringify(advertisement), "utf8");
    socket.send(body, rinfo.port, rinfo.address, (error) => {
      if (error && !closed) onError(`discovery reply to ${rinfo.address}:${rinfo.port} failed: ${error.code || error.message}`);
    });
  });

  socket.bind(port, host);

  return {
    port,
    host,
    ready,
    isListening: () => listening && !closed,
    stop() {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}

// Broadcasts a query and collects responses for `waitMs`. The reachable
// address always comes from the UDP sender, never from the payload.
async function discover(options = {}) {
  const port = parsePort(options.port) || DEFAULT_DISCOVERY_PORT;
  const waitMs = Math.min(Math.max(Number(options.waitMs) || 3000, 200), 30000);
  const selfNodeId = options.selfNodeId ? String(options.selfNodeId) : "";
  const nonce = crypto.randomBytes(8).toString("hex");
  const errors = [];
  const nodes = new Map();

  const explicitTargets = Array.isArray(options.targets) ? options.targets.filter(Boolean) : null;
  const targets = explicitTargets && explicitTargets.length
    ? Array.from(new Set(explicitTargets))
    : Array.from(new Set([...getBroadcastAddresses(), GLOBAL_BROADCAST]));

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  const bound = await new Promise((resolve) => {
    socket.once("listening", () => resolve({ ok: true }));
    socket.once("error", (error) => resolve({ ok: false, error: describeBindError(error, 0) }));
    socket.bind(0);
  });

  if (!bound.ok) {
    try {
      socket.close();
    } catch {
      /* nothing bound */
    }
    return { ok: false, port, waitMs, targets, nodes: [], errors: [bound.error] };
  }

  socket.on("error", (error) => errors.push(`discovery socket error: ${error.code || error.message}`));

  socket.on("message", (message, rinfo) => {
    const payload = parseDatagram(message);
    if (!payload || payload.type !== "response") return;
    if (payload.nonce && payload.nonce !== nonce) return;

    const address = normalizeAddress(rinfo.address);
    const brokerPort = parsePort(payload.brokerPort);
    const nodeId = String(payload.nodeId || "");
    if (!address || !brokerPort || !nodeId) return;

    const healthPath = payload.healthPath === "/health" ? "/health" : "/health";
    const key = `${nodeId}@${address}:${brokerPort}`;
    if (nodes.has(key)) return;
    nodes.set(key, {
      nodeId,
      nodeName: String(payload.nodeName || ""),
      address,
      brokerPort,
      healthPath,
      protocolVersion: Number(payload.protocolVersion) || 0,
      authMode: payload.authMode === "none" ? "none" : "token",
      brokerUrl: `http://${address}:${brokerPort}`,
      healthUrl: `http://${address}:${brokerPort}${healthPath}`,
      self: Boolean(selfNodeId) && nodeId === selfNodeId,
    });
  });

  try {
    socket.setBroadcast(true);
  } catch (error) {
    errors.push(`could not enable UDP broadcast: ${error.code || error.message}`);
  }

  const query = Buffer.from(
    JSON.stringify({ protocol: DISCOVERY_PROTOCOL, v: DISCOVERY_VERSION, type: "query", nonce }),
    "utf8"
  );

  await Promise.all(
    targets.map(
      (target) =>
        new Promise((resolve) => {
          socket.send(query, port, target, (error) => {
            if (error) errors.push(`query to ${target}:${port} failed: ${error.code || error.message}`);
            resolve();
          });
        })
    )
  );

  await new Promise((resolve) => setTimeout(resolve, waitMs));
  await new Promise((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });

  return {
    ok: true,
    port,
    waitMs,
    targets,
    nodes: Array.from(nodes.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    errors,
  };
}

module.exports = {
  DEFAULT_DISCOVERY_PORT,
  DISCOVERY_PROTOCOL,
  DISCOVERY_VERSION,
  buildAdvertisement,
  createDiscoveryResponder,
  discover,
  parseDatagram,
};
