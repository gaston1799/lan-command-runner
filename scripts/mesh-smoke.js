const path = require("node:path");
const { createBroker } = require("../lib/broker");
const { saveConfig } = require("../lib/config");
const { discover } = require("../lib/discovery");
const { createMeshSupervisor } = require("../lib/mesh");
const { generateToken } = require("../lib/server");
const { buildRequestHeaders } = require("../lib/sign");
const {
  assert,
  assertEqual,
  assertNoSecrets,
  createRunner,
  killChild,
  makeTempDir,
  removeTempDir,
  runNode,
  spawnNode,
  waitFor,
} = require("./test-helpers");

// Three isolated nodes, each with its own config file, TCP broker port, and UDP
// discovery port, so the mesh can be exercised entirely on loopback.
const NODES = [
  { key: "alpha", id: "mesh-alpha", name: "Mesh Alpha", brokerPort: 18921, discoveryPort: 18931 },
  { key: "beta", id: "mesh-beta", name: "Mesh Beta", brokerPort: 18922, discoveryPort: 18932 },
  { key: "gamma", id: "mesh-gamma", name: "Mesh Gamma", brokerPort: 18923, discoveryPort: 18933 },
];

const runner = createRunner("mesh smoke");

async function brokerHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function getAgents(node) {
  const response = await fetch(`http://127.0.0.1:${node.brokerPort}/agents`, {
    headers: {
      authorization: `Bearer ${node.token}`,
      ...buildRequestHeaders({ secret: node.token, method: "GET", path: "/agents", body: "" }),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return payload.agents;
}

async function listAgents(node) {
  return (await getAgents(node)).map((entry) => entry.id).sort();
}

async function registrationOf(node, targetId) {
  const agent = (await getAgents(node)).find((entry) => entry.id === targetId);
  return agent ? agent.registeredAt : null;
}

// Runs `node --version` on `targetNode` through `controlNode`'s broker.
// Streamed exec polls forever by design, so the timeout turns a lost job into a
// test failure instead of a hang.
async function execThrough(controlNode, targetNode) {
  return runNode(
    [
      "bin/lcr-cli.js",
      "exec",
      targetNode.id,
      "--url",
      `http://127.0.0.1:${controlNode.brokerPort}`,
      "--token",
      controlNode.token,
      "--",
      process.execPath,
      "--version",
    ],
    {},
    { timeoutMs: 45000 }
  );
}

async function main() {
  const directory = makeTempDir("mesh");
  const children = new Map();
  const logs = new Map();
  const priorGammaRegistration = {};

  for (const node of NODES) {
    node.token = generateToken();
    node.configPath = path.join(directory, `${node.key}.json`);
  }
  const secrets = NODES.map((node) => node.token);

  // Full mesh: every node stores every other node's broker url and token, and
  // never its own, so each broker should end up with exactly two agents.
  for (const node of NODES) {
    const peers = {};
    for (const other of NODES) {
      if (other.key === node.key) continue;
      peers[other.key] = {
        url: `http://127.0.0.1:${other.brokerPort}`,
        token: other.token,
        enabled: true,
        allowPublicHttp: false,
      };
    }
    saveConfig(
      {
        version: 2,
        node: { id: node.id, name: node.name },
        broker: { host: "127.0.0.1", port: node.brokerPort, token: node.token },
        peers,
        discovery: { enabled: true, port: node.discoveryPort },
      },
      node.configPath
    );
  }

  function startNode(node) {
    const child = spawnNode(["bin/lcr-cli.js", "mesh"], {
      LCR_CONFIG: node.configPath,
      // Deliberately hostile environment: a supervised connection must take its
      // identity from the config, never from these.
      LCR_TOKEN: "",
      LCR_URL: "",
      LCR_AGENT_ID: "env-agent-id-that-must-be-ignored",
      LCR_AGENT_NAME: "env-agent-name-that-must-be-ignored",
    });
    const buffer = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => {
      buffer.stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      buffer.stderr += chunk.toString("utf8");
    });
    children.set(node.key, child);
    logs.set(node.key, buffer);
    return child;
  }

  try {
    for (const node of NODES) startNode(node);

    await runner.test("every broker comes up with its configured node identity", async () => {
      for (const node of NODES) {
        const health = await waitFor(() => brokerHealth(node.brokerPort), {
          description: `${node.key} broker health`,
          timeoutMs: 30000,
        });
        assertEqual(health.mode, "broker", `${node.key} is a broker`);
        assertEqual(health.nodeId, node.id, `${node.key} reports its configured node id`);
        assertEqual(health.nodeName, node.name, `${node.key} reports its configured node name`);
      }
    });

    await runner.test("every broker sees the other two nodes as agents", async () => {
      for (const node of NODES) {
        const expected = NODES.filter((other) => other.key !== node.key)
          .map((other) => other.id)
          .sort();
        const agents = await waitFor(
          async () => {
            const ids = await listAgents(node);
            return ids.length === 2 && ids.join(",") === expected.join(",") ? ids : null;
          },
          { description: `${node.key} to see ${expected.join(" and ")}`, timeoutMs: 40000 }
        );
        assertEqual(agents.join(","), expected.join(","), `${node.key} sees exactly the other two nodes`);
      }
    });

    await runner.test("supervised connections ignore LCR_AGENT_ID and LCR_AGENT_NAME", async () => {
      for (const node of NODES) {
        const ids = await listAgents(node);
        assert(
          !ids.includes("env-agent-id-that-must-be-ignored"),
          `${node.key} has no agent registered under the environment id`
        );
      }
    });

    await runner.test("commands work from at least two independent control points", async () => {
      const fromAlpha = await execThrough(NODES[0], NODES[1]);
      assertEqual(fromAlpha.code, 0, `alpha drove beta: ${fromAlpha.stderr}`);
      assert(/^v\d+\./.test(fromAlpha.stdout.trim()), `alpha got real output from beta: ${fromAlpha.stdout}`);

      const fromBeta = await execThrough(NODES[1], NODES[2]);
      assertEqual(fromBeta.code, 0, `beta drove gamma: ${fromBeta.stderr}`);
      assert(/^v\d+\./.test(fromBeta.stdout.trim()), `beta got real output from gamma: ${fromBeta.stdout}`);

      const fromGamma = await execThrough(NODES[2], NODES[0]);
      assertEqual(fromGamma.code, 0, `gamma drove alpha: ${fromGamma.stderr}`);
      assert(/^v\d+\./.test(fromGamma.stdout.trim()), `gamma got real output from alpha: ${fromGamma.stdout}`);
    });

    await runner.test("losing one node leaves the other two mutually controllable", async () => {
      // Brokers keep an agent record until it disconnects cleanly, so remember
      // gamma's current registration to tell the stale entry from the rejoin.
      priorGammaRegistration.alpha = await registrationOf(NODES[0], NODES[2].id);
      priorGammaRegistration.beta = await registrationOf(NODES[1], NODES[2].id);

      await killChild(children.get("gamma"));
      children.delete("gamma");

      await waitFor(
        async () => {
          try {
            await brokerHealth(NODES[2].brokerPort);
            return false;
          } catch {
            return true;
          }
        },
        { description: "gamma's broker to stop answering", timeoutMs: 20000 }
      );

      // Alpha and Beta each still hold a doomed connection to Gamma; that must
      // not disturb the connection they hold to each other.
      const alphaDrivesBeta = await execThrough(NODES[0], NODES[1]);
      assertEqual(alphaDrivesBeta.code, 0, `alpha still drives beta: ${alphaDrivesBeta.stderr}`);
      assert(/^v\d+\./.test(alphaDrivesBeta.stdout.trim()), "alpha got real output from beta after the loss");

      const betaDrivesAlpha = await execThrough(NODES[1], NODES[0]);
      assertEqual(betaDrivesAlpha.code, 0, `beta still drives alpha: ${betaDrivesAlpha.stderr}`);
      assert(/^v\d+\./.test(betaDrivesAlpha.stdout.trim()), "beta got real output from alpha after the loss");

      for (const key of ["alpha", "beta"]) {
        const health = await brokerHealth(NODES.find((node) => node.key === key).brokerPort);
        assertEqual(health.ok, true, `${key} is still healthy`);
      }
    });

    await runner.test("a returning node rejoins the mesh automatically", async () => {
      startNode(NODES[2]);
      for (const node of [NODES[0], NODES[1]]) {
        await waitFor(
          async () => {
            const registeredAt = await registrationOf(node, NODES[2].id);
            return Boolean(registeredAt) && registeredAt !== priorGammaRegistration[node.key];
          },
          { description: `${node.key} to see a fresh gamma registration`, timeoutMs: 40000 }
        );
      }
      const result = await execThrough(NODES[0], NODES[2]);
      assertEqual(result.code, 0, `alpha drives the returned gamma: ${result.stderr}`);
      assert(/^v\d+\./.test(result.stdout.trim()), "the returned gamma produced real output");
    });

    await runner.test("no supervisor ever logged a token", async () => {
      for (const [key, buffer] of logs) {
        assertNoSecrets(buffer.stdout + buffer.stderr, secrets, `${key} supervisor log`);
      }
    });

    await runner.test("the supervisor reconciles config changes and stops cleanly", async () => {
      const SUPERVISOR_PORT = 18941;
      const DISCOVERY_PORT = 18942;
      const TARGET_PORT = 18943;
      const supervisorToken = generateToken();
      const targetToken = generateToken();
      const supervisorConfig = path.join(directory, "reconcile.json");
      const messages = [];

      const writeConfig = (peers) =>
        saveConfig(
          {
            version: 2,
            node: { id: "recon-node", name: "Recon Node" },
            broker: { host: "127.0.0.1", port: SUPERVISOR_PORT, token: supervisorToken },
            peers,
            discovery: { enabled: true, port: DISCOVERY_PORT },
          },
          supervisorConfig
        );

      writeConfig({});
      const target = createBroker({ token: targetToken, nodeId: "recon-target", nodeName: "Recon Target" });
      await new Promise((resolve, reject) => {
        target.once("error", reject);
        target.listen(TARGET_PORT, "127.0.0.1", resolve);
      });

      const supervisor = createMeshSupervisor({
        configPath: supervisorConfig,
        log: (message) => messages.push(message),
        logError: (message) => messages.push(message),
      });

      try {
        supervisor.start();
        await waitFor(() => brokerHealth(SUPERVISOR_PORT), { description: "the supervised broker", timeoutMs: 15000 });

        const discovered = await waitFor(
          async () => {
            const result = await discover({ port: DISCOVERY_PORT, waitMs: 500, targets: ["127.0.0.1"] });
            return result.nodes.find((entry) => entry.nodeId === "recon-node") || null;
          },
          { description: "the discovery responder", timeoutMs: 15000 }
        );
        assertEqual(discovered.brokerPort, SUPERVISOR_PORT, "discovery advertises the live broker port");

        assertEqual(supervisor.peerNames.length, 0, "no peers are connected yet");

        // Adding a peer on disk must be picked up without restarting anything.
        const peerRecord = { url: `http://127.0.0.1:${TARGET_PORT}`, token: targetToken, enabled: true, allowPublicHttp: false };
        writeConfig({ target: peerRecord });
        await waitFor(
          async () => {
            const response = await fetch(`http://127.0.0.1:${TARGET_PORT}/agents`, {
              headers: {
                authorization: `Bearer ${targetToken}`,
                ...buildRequestHeaders({ secret: targetToken, method: "GET", path: "/agents", body: "" }),
              },
            });
            const payload = await response.json();
            return payload.agents.some((entry) => entry.id === "recon-node");
          },
          { description: "the added peer to connect", timeoutMs: 20000 }
        );
        assertEqual(supervisor.peerNames.join(","), "target", "the supervisor tracks the added peer");

        // Disabling it must stop that connection.
        writeConfig({ target: { ...peerRecord, enabled: false } });
        await waitFor(() => supervisor.peerNames.length === 0, {
          description: "the disabled peer to stop",
          timeoutMs: 20000,
        });

        // A duplicate broker url must be refused rather than allowed to fight.
        writeConfig({ target: peerRecord, targetAgain: { ...peerRecord } });
        await waitFor(() => supervisor.peerNames.length === 1, {
          description: "only one of the duplicate peers to connect",
          timeoutMs: 20000,
        });
        assert(
          messages.some((message) => /points at the same broker/.test(message)),
          "the duplicate peer url is reported"
        );
      } finally {
        await supervisor.stop();
        if (typeof target.closeAllConnections === "function") target.closeAllConnections();
        await new Promise((resolve) => {
          target.close(resolve);
          setTimeout(resolve, 2000).unref();
        });
      }

      await waitFor(
        async () => {
          try {
            await brokerHealth(SUPERVISOR_PORT);
            return false;
          } catch {
            return true;
          }
        },
        { description: "the supervised broker to stop listening", timeoutMs: 15000 }
      );

      const afterStop = await discover({ port: DISCOVERY_PORT, waitMs: 500, targets: ["127.0.0.1"] });
      assertEqual(
        afterStop.nodes.filter((entry) => entry.nodeId === "recon-node").length,
        0,
        "the discovery responder stopped answering"
      );
      assertNoSecrets(messages.join("\n"), [supervisorToken, targetToken], "supervisor log messages");
    });
  } finally {
    await Promise.all(Array.from(children.values()).map((child) => killChild(child)));
    removeTempDir(directory);
  }

  runner.finish();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
