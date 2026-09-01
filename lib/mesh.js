const crypto = require("node:crypto");
const { createAgentConnection } = require("./agent");
const { createBroker } = require("./broker");
const { normalizeUrlKey } = require("./addr");
const { createDiscoveryResponder } = require("./discovery");
const { defaultConfigPath, enabledPeers, loadConfig, meshView } = require("./config");
const { redactText } = require("./redact");

const RECONCILE_INTERVAL_MS = 2000;
const BROKER_RETRY_MS = 5000;

function hashSignature(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

// Includes the token so a rotated peer token forces a reconnect, but is hashed
// so the signature can be logged or diffed without leaking anything.
function peerSignature(peer, node) {
  return hashSignature([normalizeUrlKey(peer.url), peer.token, node.id, node.name]);
}

function brokerSignature(view) {
  return hashSignature([view.broker.host, view.broker.port, view.broker.token, view.node.id, view.node.name]);
}

function discoverySignature(view) {
  return hashSignature([view.discovery.enabled, view.discovery.port, view.node.id, view.node.name, view.broker.port]);
}

function createMeshSupervisor(options = {}) {
  const configPath = options.configPath || defaultConfigPath();
  const log = options.log || ((message) => console.log(`[lcr] ${message}`));
  const logError = options.logError || ((message) => console.error(`[lcr] ${message}`));

  let view = meshView(loadConfig(configPath));
  let stopped = false;
  let reconcileTimer = null;
  let brokerRetryTimer = null;

  let brokerServer = null;
  let currentBrokerSignature = null;
  let discovery = null;
  let currentDiscoverySignature = null;

  const connections = new Map();
  const warnedDuplicates = new Set();

  function startBroker() {
    if (stopped || brokerServer) return;

    let server;
    try {
      server = createBroker({ token: view.broker.token, nodeId: view.node.id, nodeName: view.node.name });
    } catch (error) {
      logError(`local broker could not start: ${redactText(error.message)}`);
      scheduleBrokerRetry();
      return;
    }

    const signature = brokerSignature(view);
    server.on("error", (error) => {
      logError(`local broker error: ${redactText(error.code || error.message)}`);
      if (brokerServer === server) {
        brokerServer = null;
        currentBrokerSignature = null;
      }
      try {
        server.close();
      } catch {
        /* already closing */
      }
      scheduleBrokerRetry();
    });

    server.listen(view.broker.port, view.broker.host, () => {
      log(`local broker listening on ${view.broker.host}:${view.broker.port} as ${view.node.id} (${view.node.name})`);
    });

    brokerServer = server;
    currentBrokerSignature = signature;
  }

  function scheduleBrokerRetry() {
    if (stopped || brokerRetryTimer) return;
    brokerRetryTimer = setTimeout(() => {
      brokerRetryTimer = null;
      startBroker();
    }, BROKER_RETRY_MS);
    if (brokerRetryTimer.unref) brokerRetryTimer.unref();
  }

  function stopBroker() {
    const server = brokerServer;
    brokerServer = null;
    currentBrokerSignature = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        server.close(finish);
        // Peer agents hold 25s long-poll requests open; without this, close()
        // would block shutdown for the full poll window.
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      } catch {
        finish();
      }
      setTimeout(finish, 2000).unref();
    });
  }

  function startDiscovery() {
    if (stopped || discovery || !view.discovery.enabled) return;
    const signature = discoverySignature(view);
    const responder = createDiscoveryResponder({
      port: view.discovery.port,
      host: view.broker.host,
      advertise: () => ({ nodeId: view.node.id, nodeName: view.node.name, brokerPort: view.broker.port }),
      onError: (message) => logError(`discovery: ${message} Mesh routing is unaffected.`),
    });
    discovery = responder;
    currentDiscoverySignature = signature;
    responder.ready.then((result) => {
      if (result.ok) log(`discovery responder listening on ${result.host}:${result.port}/udp`);
      else logError(`discovery: ${result.error} Mesh routing is unaffected.`);
    });
  }

  async function stopDiscovery() {
    const responder = discovery;
    discovery = null;
    currentDiscoverySignature = null;
    if (responder) await responder.stop();
  }

  function startPeer(name, peer, node) {
    const entry = { signature: peerSignature(peer, node), controller: null, suspended: false };
    connections.set(name, entry);

    let controller;
    try {
      controller = createAgentConnection({
        supervised: true,
        url: peer.url,
        token: peer.token,
        name: node.name,
        id: node.id,
        peerName: name,
        log: (message) => log(`peer ${name}: ${message}`),
        logError: (message) => logError(`peer ${name}: ${message}`),
      });
    } catch (error) {
      logError(`peer ${name}: ${redactText(error.message)}`);
      connections.delete(name);
      return;
    }

    entry.controller = controller;
    log(`peer ${name}: connecting to ${peer.url}`);

    controller.done
      .then((outcome) => {
        if (stopped || connections.get(name) !== entry) return;
        if (outcome && outcome.reason === "exit") {
          // The remote asked this connection to disconnect. Honour it until the
          // peer record changes, rather than reconnecting two seconds later.
          entry.suspended = true;
          entry.controller = null;
          log(`peer ${name}: disconnected on request; will stay down until its configuration changes.`);
          return;
        }
        if (outcome && outcome.reason === "error" && outcome.error) {
          logError(`peer ${name}: ${redactText(outcome.error.message || outcome.error)}`);
        }
        connections.delete(name);
      })
      .catch((error) => {
        if (stopped || connections.get(name) !== entry) return;
        logError(`peer ${name}: ${redactText(error.message)}`);
        connections.delete(name);
      });
  }

  function reconcile() {
    if (stopped) return;

    let next;
    try {
      next = meshView(loadConfig(configPath));
    } catch (error) {
      logError(`config reload failed, keeping the running mesh: ${redactText(error.message)}`);
      return;
    }

    view = next;

    if (brokerServer && brokerSignature(next) !== currentBrokerSignature) {
      log("local broker configuration changed; restarting it.");
      stopBroker().then(() => startBroker());
    } else if (!brokerServer && !brokerRetryTimer) {
      startBroker();
    }

    if (!next.discovery.enabled && discovery) {
      stopDiscovery().then(() => log("discovery responder stopped."));
    } else if (next.discovery.enabled && discovery && discoverySignature(next) !== currentDiscoverySignature) {
      stopDiscovery().then(() => startDiscovery());
    } else if (next.discovery.enabled && !discovery) {
      startDiscovery();
    }

    const desired = new Map();
    const claimedUrls = new Map();
    for (const peer of enabledPeers(next)) {
      const key = normalizeUrlKey(peer.url);
      const owner = claimedUrls.get(key);
      if (owner) {
        // Two records on one broker would register with the same node id and
        // repeatedly evict each other.
        const warning = `peer "${peer.name}" points at the same broker as "${owner}"; skipping it.`;
        if (!warnedDuplicates.has(warning)) {
          warnedDuplicates.add(warning);
          logError(warning);
        }
        continue;
      }
      claimedUrls.set(key, peer.name);
      desired.set(peer.name, peer);
    }

    for (const [name, entry] of Array.from(connections.entries())) {
      const peer = desired.get(name);
      if (!peer) {
        if (entry.controller) entry.controller.stop();
        connections.delete(name);
        log(`peer ${name}: removed or disabled; connection stopped.`);
        continue;
      }
      if (peerSignature(peer, next.node) !== entry.signature) {
        if (entry.controller) entry.controller.stop();
        connections.delete(name);
        log(`peer ${name}: configuration changed; reconnecting.`);
      }
    }

    for (const [name, peer] of desired) {
      if (connections.has(name)) continue;
      startPeer(name, peer, next.node);
    }
  }

  function start() {
    if (stopped) throw new Error("This mesh supervisor has already been stopped.");
    startBroker();
    startDiscovery();
    reconcile();
    reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);
    if (reconcileTimer.unref) reconcileTimer.unref();
    return { nodeId: view.node.id, nodeName: view.node.name, brokerPort: view.broker.port };
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (brokerRetryTimer) clearTimeout(brokerRetryTimer);
    reconcileTimer = null;
    brokerRetryTimer = null;

    await stopDiscovery();
    await Promise.allSettled(
      Array.from(connections.values()).map((entry) => (entry.controller ? entry.controller.stop() : Promise.resolve()))
    );
    connections.clear();
    await stopBroker();
  }

  return {
    get node() {
      return view.node;
    },
    get peerNames() {
      return Array.from(connections.keys()).sort();
    },
    configPath,
    reconcile,
    start,
    stop,
  };
}

// Long-running foreground command: local broker + discovery + one reconnecting
// connection per enabled peer, until SIGINT/SIGTERM.
async function mesh(options = {}) {
  const supervisor = createMeshSupervisor(options);
  const view = meshView(loadConfig(supervisor.configPath));

  if (!view.broker.token) {
    throw new Error("No broker token configured. Run lcr-cli mesh init first.");
  }

  const started = supervisor.start();
  console.log(`[lcr] mesh node ${started.nodeId} (${started.nodeName}) started. Config: ${supervisor.configPath}`);
  console.log("[lcr] Press Ctrl+C to stop.");

  await new Promise((resolve) => {
    let shuttingDown = false;
    const shutdown = (signalName) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[lcr] ${signalName} received; stopping mesh node.`);
      supervisor
        .stop()
        .catch((error) => console.error(`[lcr] ${redactText(error.message)}`))
        .finally(() => resolve());
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });

  console.log("[lcr] mesh node stopped.");
}

module.exports = {
  RECONCILE_INTERVAL_MS,
  createMeshSupervisor,
  mesh,
};
