const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, saveConfig } = require("../lib/config");
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

const runner = createRunner("cli smoke");

async function main() {
  const directory = makeTempDir("cli");
  const configPath = path.join(directory, "config.json");
  const legacyPath = path.join(directory, "legacy.json");
  const peerToken = generateToken();
  const legacyToken = generateToken();

  // Every CLI call runs with an empty LCR_TOKEN so the noninteractive token
  // rules are exercised rather than accidentally satisfied by the environment.
  const cli = (args, extraEnv = {}) =>
    runNode(["bin/lcr-cli.js", ...args], { LCR_CONFIG: configPath, LCR_TOKEN: "", ...extraEnv });

  try {
    await runner.test("mesh init creates a v2 config and generates a broker token", async () => {
      const result = await cli(["mesh", "init", "--node-id", "Alpha PC!", "--name", "Alpha", "--port", "18911"]);
      assertEqual(result.code, 0, `mesh init succeeded: ${result.stderr}`);
      assert(/a new broker token was generated/.test(result.stdout), "the generated token is announced, not printed");

      const config = loadConfig(configPath);
      assertEqual(config.version, 2, "config is version 2");
      assertEqual(config.node.id, "alpha-pc", "node id is sanitized");
      assertEqual(config.node.name, "Alpha", "node name honoured");
      assertEqual(config.broker.port, 18911, "broker port honoured");
      assertEqual(config.broker.host, "127.0.0.1", "broker host defaults to loopback");
      assertEqual(typeof config.broker.token, "string", "a token was stored");
      assert(config.broker.token.length >= 16, "the generated token is not trivial");
      assertEqual(config.discovery.port, 8766, "discovery defaults to 8766/udp");
      assertNoSecrets(result.stdout + result.stderr, [config.broker.token], "mesh init output");
    });

    await runner.test("mesh init is idempotent and never rotates an existing token", async () => {
      const before = loadConfig(configPath).broker.token;
      const result = await cli(["mesh", "init"]);
      assertEqual(result.code, 0, "re-init succeeds");
      const after = loadConfig(configPath);
      assertEqual(after.broker.token, before, "the broker token is preserved");
      assertEqual(after.node.id, "alpha-pc", "node id is preserved");
      assertEqual(after.broker.port, 18911, "broker port is preserved");
    });

    await runner.test("mesh init preserves legacy keys and invents no peer from a legacy url", async () => {
      saveConfig(
        {
          url: "http://192.168.1.50:8765",
          token: legacyToken,
          agentId: "legacy-box",
          agentName: "Legacy Box",
          host: "0.0.0.0",
          port: "9100",
          somethingCustom: { keep: true },
        },
        legacyPath
      );
      const result = await runNode(["bin/lcr-cli.js", "mesh", "init"], { LCR_CONFIG: legacyPath, LCR_TOKEN: "" });
      assertEqual(result.code, 0, `mesh init on a legacy config succeeded: ${result.stderr}`);
      assert(/was NOT added as a peer/.test(result.stdout), "the CLI says the legacy url was not treated as a peer");

      const config = loadConfig(legacyPath);
      assertEqual(config.url, "http://192.168.1.50:8765", "legacy url preserved");
      assertEqual(config.token, legacyToken, "legacy token preserved");
      assertEqual(config.agentId, "legacy-box", "legacy agentId preserved");
      assertEqual(config.agentName, "Legacy Box", "legacy agentName preserved");
      assertEqual(config.somethingCustom.keep, true, "unrelated keys preserved");
      assertEqual(config.node.id, "legacy-box", "node id derived from the legacy agent id");
      assertEqual(config.broker.token, legacyToken, "broker token adopted from the legacy token");
      assertEqual(config.broker.port, 9100, "broker port adopted from the legacy port");
      assertEqual(Object.keys(config.peers).length, 0, "no peer was invented");
      assertNoSecrets(result.stdout + result.stderr, [legacyToken], "legacy mesh init output");
    });

    await runner.test("peer add stores a peer without echoing the token", async () => {
      const result = await cli(["peer", "add", "tower", "--url", "http://192.168.1.9:8765", "--token", peerToken]);
      assertEqual(result.code, 0, `peer add succeeded: ${result.stderr}`);
      assert(/token stored, not shown/.test(result.stdout), "the CLI confirms without echoing");

      const peer = loadConfig(configPath).peers.tower;
      assertEqual(peer.url, "http://192.168.1.9:8765/", "url stored");
      assertEqual(peer.token, peerToken, "token stored");
      assertEqual(peer.enabled, true, "peers default to enabled");
      assertEqual(peer.allowPublicHttp, false, "public http stays off by default");
      assertNoSecrets(result.stdout + result.stderr, [peerToken], "peer add output");
    });

    await runner.test("the reciprocal setup guidance never embeds a token", async () => {
      const result = await cli(["peer", "add", "shed", "--url", "http://192.168.1.11:8765", "--token", peerToken]);
      assertEqual(result.code, 0, "peer add succeeded");
      assert(/peer add alpha-pc --url http:\/\//.test(result.stdout), "guidance shows the reciprocal command");
      assert(!/--token \S/.test(result.stdout), "the guidance carries no --token argument");
      assertNoSecrets(result.stdout, [peerToken, loadConfig(configPath).broker.token], "setup guidance");
    });

    await runner.test("a second peer record on the same broker is refused", async () => {
      const result = await cli(["peer", "add", "tower-again", "--url", "http://192.168.1.9:8765", "--token", peerToken]);
      assertEqual(result.code, 1, "duplicate broker url is refused");
      assert(/already points at that broker/.test(result.stderr), "the error explains why");
      assertEqual(loadConfig(configPath).peers["tower-again"], undefined, "nothing was saved");
    });

    await runner.test("adding this node's own broker as a peer is refused", async () => {
      const result = await cli(["peer", "add", "self", "--url", "http://127.0.0.1:18911", "--token", peerToken]);
      assertEqual(result.code, 1, "self-peering is refused");
      assert(/this node's own broker/.test(result.stderr), "the error explains why");
    });

    await runner.test("plain-http public targets are refused without an explicit opt-in", async () => {
      const address = await cli(["peer", "add", "wan", "--url", "http://203.0.113.5:8765", "--token", peerToken]);
      assertEqual(address.code, 1, "public address is refused");
      assert(/is a public address/.test(address.stderr), "the error names the reason");
      assert(/credential/i.test(address.stderr) && /intercept/i.test(address.stderr), "the security warning is shown");
      assert(/--allow-public-http/.test(address.stderr), "the error names the opt-in");

      const domain = await cli(["peer", "add", "wan", "--url", "http://broker.example.com:8765", "--token", peerToken]);
      assertEqual(domain.code, 1, "unresolved domain is refused");
      assert(/cannot prove is private/.test(domain.stderr), "domains are public by default");

      assertEqual(loadConfig(configPath).peers.wan, undefined, "nothing was saved");
    });

    await runner.test("private and https targets need no opt-in", async () => {
      const vpn = await cli(["peer", "add", "vpn", "--url", "http://100.80.1.2:8765", "--token", peerToken]);
      assertEqual(vpn.code, 0, `private VPN range is allowed: ${vpn.stderr}`);
      const secure = await cli(["peer", "add", "secure", "--url", "https://broker.example.com:8765", "--token", peerToken]);
      assertEqual(secure.code, 0, `https is allowed: ${secure.stderr}`);
    });

    await runner.test("--allow-public-http records the opt-in and warns loudly", async () => {
      const result = await cli([
        "peer",
        "add",
        "--allow-public-http",
        "wan",
        "--url",
        "http://203.0.113.5:8765",
        "--token",
        peerToken,
      ]);
      assertEqual(result.code, 0, `explicit opt-in is accepted: ${result.stderr}`);
      const peer = loadConfig(configPath).peers.wan;
      assert(peer, "the peer name was not swallowed by the boolean flag");
      assertEqual(peer.allowPublicHttp, true, "the opt-in is persisted");
      assert(/explicitly opted into plain-HTTP/.test(result.stdout), "the opt-in is called out");
      assert(/intercept/i.test(result.stdout), "the interception warning is repeated");
    });

    await runner.test("--allow-public-http rejects a non-boolean value instead of trusting it", async () => {
      const result = await cli([
        "peer",
        "add",
        "wan2",
        "--url",
        "http://203.0.113.6:8765",
        "--token",
        peerToken,
        "--allow-public-http=sure",
      ]);
      assertEqual(result.code, 1, "a truthy-looking string is rejected");
      assert(/boolean flag/.test(result.stderr), "the error explains the flag contract");
      assertEqual(loadConfig(configPath).peers.wan2, undefined, "nothing was saved");
    });

    await runner.test("a missing token fails immediately in noninteractive mode", async () => {
      const result = await cli(["peer", "add", "lonely", "--url", "http://192.168.1.30:8765"]);
      assertEqual(result.code, 1, "the command fails rather than hanging");
      assert(
        /--token/.test(result.stderr) && /LCR_PEER_TOKEN/.test(result.stderr),
        "the error names both peer-token input methods"
      );
      assert(/no terminal to prompt on/.test(result.stderr), "the error explains why it did not prompt");
      assertEqual(loadConfig(configPath).peers.lonely, undefined, "nothing was saved");
    });

    await runner.test("peer add never silently reuses the local LCR_TOKEN", async () => {
      const localToken = generateToken();
      const result = await cli(
        ["peer", "add", "wrong-token", "--url", "http://192.168.1.32:8765"],
        { LCR_TOKEN: localToken, LCR_PEER_TOKEN: "" }
      );
      assertEqual(result.code, 1, "the local broker token does not satisfy peer enrollment");
      assert(/LCR_PEER_TOKEN/.test(result.stderr), "the error points to the peer-specific variable");
      assertEqual(loadConfig(configPath).peers["wrong-token"], undefined, "the local token was not stored as a peer token");
    });

    await runner.test("LCR_PEER_TOKEN supports explicit noninteractive automation", async () => {
      const result = await cli(
        ["peer", "add", "automated", "--url", "http://192.168.1.33:8765"],
        { LCR_TOKEN: generateToken(), LCR_PEER_TOKEN: peerToken }
      );
      assertEqual(result.code, 0, `peer-specific environment enrollment succeeds: ${result.stderr}`);
      assertEqual(loadConfig(configPath).peers.automated.token, peerToken, "only the peer-specific token was stored");
      assertNoSecrets(result.stdout + result.stderr, [peerToken], "automated peer add output");
    });

    await runner.test("--enabled=false stores a disabled peer", async () => {
      const result = await cli([
        "peer",
        "add",
        "parked",
        "--url",
        "http://192.168.1.31:8765",
        "--token",
        peerToken,
        "--enabled=false",
      ]);
      assertEqual(result.code, 0, `peer add succeeded: ${result.stderr}`);
      assertEqual(loadConfig(configPath).peers.parked.enabled, false, "the peer is disabled");
    });

    await runner.test("peer list redacts tokens in both output modes", async () => {
      const plain = await cli(["peer", "list"]);
      assertEqual(plain.code, 0, "peer list succeeded");
      assert(/tower/.test(plain.stdout), "peers are listed");
      assert(/token stored/.test(plain.stdout), "token presence is shown, not the token");
      assertNoSecrets(plain.stdout, [peerToken], "peer list");

      const json = await cli(["peer", "list", "--json"]);
      const payload = JSON.parse(json.stdout);
      const tower = payload.peers.find((entry) => entry.name === "tower");
      assertEqual(tower.tokenConfigured, true, "token presence is a boolean");
      assertEqual(tower.token, undefined, "no token field is emitted at all");
      assertNoSecrets(json.stdout, [peerToken], "peer list --json");
    });

    await runner.test("peer remove deletes only the named peer", async () => {
      const result = await cli(["peer", "remove", "shed"]);
      assertEqual(result.code, 0, `peer remove succeeded: ${result.stderr}`);
      const config = loadConfig(configPath);
      assertEqual(config.peers.shed, undefined, "the peer is gone");
      assert(config.peers.tower, "other peers survive");

      const missing = await cli(["peer", "remove", "ghost"]);
      assertEqual(missing.code, 1, "removing an unknown peer fails");
      assert(/Unknown peer/.test(missing.stderr), "the error names the problem");
    });

    await runner.test("show-config redacts by default and reveals only on request", async () => {
      const brokerToken = loadConfig(configPath).broker.token;

      const redacted = await cli(["show-config"]);
      assertEqual(redacted.code, 0, "show-config succeeded");
      assert(/<redacted>/.test(redacted.stdout), "tokens are redacted");
      assert(/Use --reveal/.test(redacted.stdout), "the escape hatch is documented in the output");
      assertNoSecrets(redacted.stdout, [brokerToken, peerToken], "show-config");

      const revealed = await cli(["show-config", "--reveal"]);
      assertEqual(revealed.code, 0, "show-config --reveal succeeded");
      assert(revealed.stdout.includes(brokerToken), "--reveal prints the real token");
    });

    await runner.test("setup stays compatible and redacts its echoed config", async () => {
      const setupToken = generateToken();
      const result = await cli(["setup", "--url", "http://192.168.1.60:8765", "--token", setupToken]);
      assertEqual(result.code, 0, `setup succeeded: ${result.stderr}`);
      assert(/saved config to/.test(result.stdout), "setup reports where it saved");
      assertNoSecrets(result.stdout, [setupToken], "setup output");

      const config = loadConfig(configPath);
      assertEqual(config.url, "http://192.168.1.60:8765", "legacy url written");
      assertEqual(config.token, setupToken, "legacy token written");
      assert(config.peers.tower, "setup did not clobber the mesh peers");
      assertEqual(config.node.id, "alpha-pc", "setup did not clobber the node identity");
    });

    await runner.test("an unreadable config produces a clear error, not a silent empty config", async () => {
      const brokenPath = path.join(directory, "broken.json");
      require("node:fs").writeFileSync(brokenPath, "{ not json", "utf8");
      const result = await runNode(["bin/lcr-cli.js", "peer", "list"], { LCR_CONFIG: brokenPath, LCR_TOKEN: "" });
      assertEqual(result.code, 1, "the command fails");
      assert(/Invalid config JSON/.test(result.stderr), "the error explains the problem");
      assert(result.stderr.includes(brokenPath), "the error names the file");
    });

    await runner.test("usage lists the new mesh commands", async () => {
      const result = await cli(["--help"]);
      for (const fragment of ["mesh init", "peer add", "peer remove", "peer list", "discover", "doctor", "--reveal"]) {
        assert(result.stdout.includes(fragment), `usage documents ${fragment}`);
      }
    });

    await runner.test("tray and updater keep broker tokens out of child command lines", async () => {
      const cliSource = fs.readFileSync(path.join(__dirname, "..", "bin", "lcr-cli.js"), "utf8");
      assert(!/args\.push\("-Token"/.test(cliSource), "tray never appends a token argument");
      assert(/trayEnv[\s\S]*LCR_TOKEN: String\(token\)/.test(cliSource), "tray supplies the token through the child environment");

      const agentSource = fs.readFileSync(path.join(__dirname, "..", "lib", "agent.js"), "utf8");
      const updateStart = agentSource.indexOf("async function scheduleWindowsUpdate");
      const updateEnd = agentSource.indexOf("async function runJob", updateStart);
      const updateSource = agentSource.slice(updateStart, updateEnd);
      assert(!/psString\(enrollToken\)/.test(updateSource), "the encoded updater command contains no token literal");
      assert(!/--token/.test(updateSource), "the updater child command line contains no token flag");
      assert(/env: \{ \.\.\.process\.env, LCR_TOKEN: enrollToken \}/.test(updateSource), "the updater uses its child environment");
    });
  } finally {
    removeTempDir(directory);
  }

  runner.finish();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
