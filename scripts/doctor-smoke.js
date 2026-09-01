const http = require("node:http");
const path = require("node:path");
const { createBroker } = require("../lib/broker");
const { saveConfig } = require("../lib/config");
const { formatReport, readLocalCommit, runDoctor, updateCheck } = require("../lib/doctor");
const { generateToken } = require("../lib/server");
const {
  assert,
  assertEqual,
  assertNoSecrets,
  createRunner,
  makeTempDir,
  removeTempDir,
  runNode,
} = require("./test-helpers");

const LOCAL_PORT = 18901;
const PEER_PORT = 18902;
const PUBLIC_IP_PORT = 18903;
const CLOSED_PORT = 18904;
const GITHUB_PORT = 18906;

const NODE_ID = "doctor-node";
const PEER_NODE_ID = "doctor-peer";
const STUB_PUBLIC_IP = "203.0.113.9";
const LOCAL_VERSION = require("../package.json").version;
const LOCAL_COMMIT = readLocalCommit(path.join(__dirname, "..")) || "a".repeat(40);
const MAIN_COMMIT = LOCAL_COMMIT;
const OLD_COMMIT = "1".repeat(40);

const runner = createRunner("doctor smoke");

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
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

function findCheck(report, id) {
  return report.checks.find((entry) => entry.id === id);
}

async function main() {
  const directory = makeTempDir("doctor");
  const configPath = path.join(directory, "config.json");

  const localToken = generateToken();
  const peerToken = generateToken();
  const secrets = [localToken, peerToken];
  // Deterministic stand-in for api.ipify.org: these tests never touch the Internet.
  const publicIpUrl = `http://127.0.0.1:${PUBLIC_IP_PORT}/?format=json`;

  saveConfig(
    {
      version: 2,
      node: { id: NODE_ID, name: "Doctor Node" },
      broker: { host: "127.0.0.1", port: LOCAL_PORT, token: localToken },
      peers: {
        alpha: { url: `http://127.0.0.1:${PEER_PORT}`, token: peerToken, enabled: true, allowPublicHttp: false },
        parked: { url: `http://127.0.0.1:${CLOSED_PORT}`, token: peerToken, enabled: false, allowPublicHttp: false },
      },
      discovery: { enabled: true, port: 18905 },
    },
    configPath
  );

  const local = createBroker({ token: localToken, nodeId: NODE_ID, nodeName: "Doctor Node" });
  const peer = createBroker({ token: peerToken, nodeId: PEER_NODE_ID, nodeName: "Doctor Peer" });
  const publicIpStub = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ip: STUB_PUBLIC_IP }));
  });
  const githubStub = http.createServer((req, res) => {
    const body = (() => {
      if (/\/releases\/latest$/.test(req.url)) return { tag_name: `v${LOCAL_VERSION}` };
      if (/\/commits\/main$/.test(req.url)) return { sha: MAIN_COMMIT };
      if (/\/compare\//.test(req.url)) {
        return req.url.includes(OLD_COMMIT)
          ? { status: "behind", behind_by: 3, ahead_by: 0 }
          : { status: "identical", behind_by: 0, ahead_by: 0 };
      }
      return null;
    })();
    if (!body) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await listen(local, LOCAL_PORT);
  await listen(peer, PEER_PORT);
  await listen(publicIpStub, PUBLIC_IP_PORT);
  await listen(githubStub, GITHUB_PORT);
  const previousGithubApiUrl = process.env.LCR_GITHUB_API_URL;
  process.env.LCR_GITHUB_API_URL = `http://127.0.0.1:${GITHUB_PORT}`;

  try {
    await runner.test("the overview validates config, broker, peers, LAN, and public IP", async () => {
      const report = await runDoctor({ configPath, publicIpUrl });
      assertEqual(report.ok, true, `overview passes: ${JSON.stringify(report.summary)}`);
      assertEqual(report.mode, "overview", "overview mode");
      assertEqual(report.node.id, NODE_ID, "node identity reported");
      assertEqual(findCheck(report, "updates").status, "ok", "the installed release and commit are current");

      assertEqual(findCheck(report, "config").status, "ok", "config is valid");
      assertEqual(findCheck(report, "config").data.brokerTokenConfigured, true, "token presence is reported as a boolean");

      const broker = findCheck(report, "local-broker");
      assertEqual(broker.status, "ok", "local broker is healthy");
      assertEqual(broker.data.listening, true, "local broker is listening");
      assertEqual(broker.data.nodeId, NODE_ID, "local broker reports the configured node id");

      assertEqual(findCheck(report, "peer:alpha").status, "ok", "enabled peer is healthy");
      assertEqual(findCheck(report, "peer:alpha").data.nodeId, PEER_NODE_ID, "peer node id observed");
      assertEqual(findCheck(report, "peer:parked").status, "skip", "disabled peer is skipped, not probed");
      const lan = findCheck(report, "lan");
      assertEqual(lan.status, "warn", "a loopback-only broker is not presented as LAN-reachable");
      assertEqual(lan.data.candidates.length, 0, "no unusable LAN url is recommended");
      assert(/--host 0\.0\.0\.0/.test(lan.detail), "the warning gives the corrective mesh init command");
      const discovery = findCheck(report, "discovery");
      assertEqual(discovery.status, "warn", "loopback-bound discovery is reported as unreachable to other PCs");
      assert(/loopback/.test(discovery.detail), "the discovery warning names the binding problem");
    });

    await runner.test("a discovered public IP is never presented as inbound reachability", async () => {
      const report = await runDoctor({ configPath, publicIpUrl });
      const check = findCheck(report, "public-ip");
      assertEqual(check.status, "ok", "public IP lookup succeeded against the stub");
      assertEqual(check.data.ip, STUB_PUBLIC_IP, "stubbed IP used");
      assertEqual(check.data.inboundVerified, false, "inbound reachability is explicitly not claimed");
      assert(/does NOT mean inbound/i.test(check.detail), "the wording refuses to claim public reachability");
    });

    await runner.test("a failed public IP lookup is a warning, not a crash", async () => {
      const report = await runDoctor({ configPath, publicIpUrl: `http://127.0.0.1:${CLOSED_PORT}/` });
      assertEqual(findCheck(report, "public-ip").status, "warn", "lookup failure downgrades to a warning");
      assertEqual(report.ok, true, "the overall report still passes");
      assertEqual(findCheck(report, "local-broker").status, "ok", "unrelated checks still ran");
    });

    await runner.test("an older release gets the prominent update warning and command", async () => {
      const result = await updateCheck({
        localVersion: "0.1.0",
        localCommit: OLD_COMMIT,
        githubApiUrl: `http://127.0.0.1:${GITHUB_PORT}`,
      });
      assertEqual(result.status, "warn", "an older release warns");
      assertEqual(result.data.severity, "release", "release lag has the prominent severity");
      assertEqual(result.data.updateCommand, "lcr-cli update", "the remediation is machine-readable");
      assert(/RELEASE UPDATE AVAILABLE/.test(result.detail), "the release warning is unmistakable");
      assert(/\[UPDATE\]/.test(formatReport({
        ok: true,
        node: { id: NODE_ID, name: "Doctor Node" },
        configPath,
        summary: { total: 1, failed: 0, warned: 1 },
        checks: [result],
      })), "human output uses the prominent UPDATE label");
    });

    await runner.test("a current release behind main gets only a development warning", async () => {
      const result = await updateCheck({
        localVersion: LOCAL_VERSION,
        localCommit: OLD_COMMIT,
        githubApiUrl: `http://127.0.0.1:${GITHUB_PORT}`,
      });
      assertEqual(result.status, "warn", "main lag warns");
      assertEqual(result.data.severity, "main", "main lag has development severity");
      assertEqual(result.data.behindBy, 3, "the commit distance is reported");
      assert(/behind main/.test(result.detail), "the warning explains the branch lag");
      assert(!/\[UPDATE\]/.test(formatReport({
        ok: true,
        node: { id: NODE_ID, name: "Doctor Node" },
        configPath,
        summary: { total: 1, failed: 0, warned: 1 },
        checks: [result],
      })), "main lag is not presented as a release update");
    });

    await runner.test("no token appears anywhere in a doctor report", async () => {
      const report = await runDoctor({ configPath, publicIpUrl, callbackPeer: "alpha" });
      assertNoSecrets(JSON.stringify(report), secrets, "doctor report");
    });

    await runner.test("--url probes an unauthenticated health endpoint", async () => {
      const ok = await runDoctor({ configPath, url: `http://127.0.0.1:${PEER_PORT}` });
      assertEqual(ok.mode, "url", "url mode");
      assertEqual(findCheck(ok, "url").status, "ok", "reachable url passes");
      assertEqual(findCheck(ok, "url").data.nodeId, PEER_NODE_ID, "node id observed");

      const bad = await runDoctor({ configPath, url: `http://127.0.0.1:${CLOSED_PORT}` });
      assertEqual(findCheck(bad, "url").status, "fail", "closed url fails");
      assertEqual(bad.ok, false, "report reflects the failure");
    });

    await runner.test("--url warns about plain HTTP to a non-private target", async () => {
      const warned = await runDoctor({ configPath, url: "http://203.0.113.50:8765" });
      assertEqual(findCheck(warned, "url-transport").status, "warn", "public plain http warns");
      const silenced = await runDoctor({ configPath, url: "http://203.0.113.50:8765", allowPublicHttp: true });
      assertEqual(findCheck(silenced, "url-transport"), undefined, "--allow-public-http silences the warning");
    });

    await runner.test("--peer probes the named peer and rejects unknown names", async () => {
      const ok = await runDoctor({ configPath, peer: "alpha" });
      assertEqual(ok.mode, "peer", "peer mode");
      assertEqual(findCheck(ok, "url").status, "ok", "named peer is reachable");

      const unknown = await runDoctor({ configPath, peer: "nope" });
      assertEqual(findCheck(unknown, "peer").status, "fail", "unknown peer fails");
      assert(/Unknown peer/.test(findCheck(unknown, "peer").detail), "the error names the problem");
    });

    await runner.test("--callback-peer verifies this node through the peer", async () => {
      const report = await runDoctor({ configPath, publicIpUrl, callbackPeer: "alpha" });
      const check = findCheck(report, "callback");
      assertEqual(check.status, "ok", `callback succeeded: ${check.detail}`);
      assertEqual(check.data.reachable, true, "peer reached this node");
      assertEqual(check.data.observedAddress, "127.0.0.1", "the peer-observed source address is reported");
      assertEqual(check.data.scope, "local", "loopback is labelled local, not public");
      assertEqual(check.data.testedUrl, `http://127.0.0.1:${LOCAL_PORT}/health`, "the peer probed our declared port");
    });

    await runner.test("callback failures are reported without taking down the report", async () => {
      const unknown = await runDoctor({ configPath, callbackPeer: "nope" });
      assertEqual(findCheck(unknown, "callback").status, "fail", "unknown callback peer fails");

      const disabled = await runDoctor({ configPath, callbackPeer: "parked" });
      assertEqual(findCheck(disabled, "callback").status, "fail", "unreachable callback peer fails cleanly");
    });

    // Regression: the public-HTTP warning joined the peer *records*, so the
    // detail line read "[object Object]" and named no peer at all.
    await runner.test("public HTTP peers are named, not stringified as objects", async () => {
      const publicHttpConfig = path.join(directory, "public-http.json");
      saveConfig(
        {
          version: 2,
          node: { id: NODE_ID, name: "Doctor Node" },
          broker: { host: "127.0.0.1", port: LOCAL_PORT, token: localToken },
          peers: {
            "site-b": { url: "http://203.0.113.40:8765", token: peerToken, enabled: true, allowPublicHttp: true },
            "site-c": { url: "http://203.0.113.41:8765", token: peerToken, enabled: true, allowPublicHttp: true },
          },
          discovery: { enabled: true, port: 18905 },
        },
        publicHttpConfig
      );

      const report = await runDoctor({ configPath: publicHttpConfig, publicIpUrl });
      const check = findCheck(report, "config");
      assertEqual(check.status, "warn", "opting into public plain HTTP warns");
      assert(!/\[object Object\]/.test(check.detail), `the detail names peers, not objects: ${check.detail}`);
      assert(/site-b/.test(check.detail) && /site-c/.test(check.detail), `both peer names appear: ${check.detail}`);
      assertEqual(check.data.publicHttpPeers.length, 2, "both peers are counted");
      assertNoSecrets(JSON.stringify(report), secrets, "public-http doctor report");
    });

    // Regression: `new URL("/health", "<garbage>")` throws synchronously, which
    // rejected the peerChecks Promise.all and took the whole report down.
    await runner.test("a malformed peer url fails only its own check", async () => {
      const malformedConfig = path.join(directory, "malformed-peer.json");
      saveConfig(
        {
          version: 2,
          node: { id: NODE_ID, name: "Doctor Node" },
          broker: { host: "127.0.0.1", port: LOCAL_PORT, token: localToken },
          peers: {
            alpha: { url: `http://127.0.0.1:${PEER_PORT}`, token: peerToken, enabled: true },
            // Three ways a hand-edited config goes wrong.
            broken: { url: "not a url at all", token: peerToken, enabled: true },
            "no-url": { url: "", token: peerToken, enabled: true },
            "bad-host": { url: "http://[::1", token: peerToken, enabled: true },
          },
          discovery: { enabled: true, port: 18905 },
        },
        malformedConfig
      );

      // The whole point: this must resolve, not reject.
      const report = await runDoctor({ configPath: malformedConfig, publicIpUrl });

      assertEqual(findCheck(report, "peer:broken").status, "fail", "the malformed peer fails");
      assert(/Unusable url/.test(findCheck(report, "peer:broken").detail), "the failure explains what is wrong");
      assertEqual(findCheck(report, "peer:broken").data.malformedUrl, true, "the failure is flagged as a url problem");
      assertEqual(findCheck(report, "peer:no-url").status, "fail", "an empty url fails its own check");
      assertEqual(findCheck(report, "peer:bad-host").status, "fail", "an unparsable host fails its own check");

      assertEqual(findCheck(report, "peer:alpha").status, "ok", "the healthy peer is still probed");
      assert(findCheck(report, "local-broker"), "the local broker check still ran");
      assert(findCheck(report, "public-ip"), "the public IP check still ran");
      assertEqual(report.ok, false, "the report reflects the failures");
      assertNoSecrets(JSON.stringify(report), secrets, "malformed-peer doctor report");
    });

    await runner.test("a stopped local broker fails its own check only", async () => {
      await close(local);
      const report = await runDoctor({ configPath, publicIpUrl });
      assertEqual(findCheck(report, "local-broker").status, "fail", "local broker check fails");
      assert(/lcr-cli mesh/.test(findCheck(report, "local-broker").detail), "the failure says how to fix it");
      assertEqual(findCheck(report, "peer:alpha").status, "ok", "peer check still ran");
      assertEqual(findCheck(report, "public-ip").status, "ok", "public IP check still ran");
      assertEqual(report.ok, false, "the overall report fails");
    });

    await runner.test("the CLI emits stable JSON and redacts tokens", async () => {
      const result = await runNode(["bin/lcr-cli.js", "doctor", "--json"], {
        LCR_CONFIG: configPath,
        LCR_PUBLIC_IP_URL: publicIpUrl,
        LCR_TOKEN: "",
      });
      const report = JSON.parse(result.stdout);
      assertEqual(typeof report.ok, "boolean", "ok is a boolean");
      assertEqual(report.mode, "overview", "mode is stable");
      assert(Array.isArray(report.checks), "checks is an array");
      for (const entry of report.checks) {
        assert(entry.id && entry.name && entry.status, "each check has id, name, and status");
        assert(["ok", "warn", "fail", "skip"].includes(entry.status), `status is one of the documented values: ${entry.status}`);
      }
      assertNoSecrets(result.stdout + result.stderr, secrets, "doctor --json output");
    });

    await runner.test("the human-readable CLI output is readable and token-free", async () => {
      const result = await runNode(["bin/lcr-cli.js", "doctor"], {
        LCR_CONFIG: configPath,
        LCR_PUBLIC_IP_URL: publicIpUrl,
        LCR_TOKEN: "",
      });
      assert(/LCR doctor/.test(result.stdout), "has a header");
      assert(/\[(OK|WARN|FAIL|SKIP)/.test(result.stdout), "has status labels");
      assertNoSecrets(result.stdout + result.stderr, secrets, "doctor output");
    });
  } finally {
    if (previousGithubApiUrl === undefined) delete process.env.LCR_GITHUB_API_URL;
    else process.env.LCR_GITHUB_API_URL = previousGithubApiUrl;
    await close(local);
    await close(peer);
    await close(publicIpStub);
    await close(githubStub);
    removeTempDir(directory);
  }

  runner.finish();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
