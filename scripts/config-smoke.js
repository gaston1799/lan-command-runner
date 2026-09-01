const fs = require("node:fs");
const path = require("node:path");
const { classifyAddress, classifyUrlTarget, normalizeAddress, parsePort } = require("../lib/addr");
const { parseArgs } = require("../lib/args");
const { listPeers, loadConfig, meshView, saveConfig, sanitizeNodeId, withMeshDefaults } = require("../lib/config");
const { redactText, redactValue } = require("../lib/redact");
const { generateToken } = require("../lib/server");
const {
  assert,
  assertEqual,
  assertDeepEqual,
  assertThrows,
  createRunner,
  makeTempDir,
  removeTempDir,
} = require("./test-helpers");

const runner = createRunner("config smoke");

async function main() {
  const directory = makeTempDir("config");
  const configPath = path.join(directory, "config.json");

  try {
    await runner.test("loadConfig returns {} for an absent file", () => {
      assertDeepEqual(loadConfig(configPath), {}, "absent config");
    });

    await runner.test("loadConfig throws a clear error for invalid JSON", () => {
      fs.writeFileSync(configPath, "{ this is not json", "utf8");
      const error = assertThrows(() => loadConfig(configPath), /Invalid config JSON/, "invalid json");
      assert(error.message.includes(configPath), "error names the offending path");
    });

    await runner.test("loadConfig throws when the top level is not an object", () => {
      fs.writeFileSync(configPath, "[1,2,3]", "utf8");
      assertThrows(() => loadConfig(configPath), /expected a JSON object/, "array config");
    });

    await runner.test("saveConfig writes atomically and leaves no temp files", () => {
      fs.rmSync(configPath, { force: true });
      saveConfig({ version: 2, node: { id: "alpha", name: "Alpha" } }, configPath);
      const reloaded = loadConfig(configPath);
      assertEqual(reloaded.node.id, "alpha", "saved node id round-trips");

      const leftovers = fs.readdirSync(directory).filter((entry) => entry.includes(".tmp-"));
      assertDeepEqual(leftovers, [], "no temp files remain after save");
    });

    await runner.test("saveConfig replaces rather than merges, and stays readable", () => {
      saveConfig({ version: 2, node: { id: "beta", name: "Beta" }, peers: {} }, configPath);
      const reloaded = loadConfig(configPath);
      assertEqual(reloaded.node.id, "beta", "second save wins");
      assertEqual(fs.readFileSync(configPath, "utf8").endsWith("\n"), true, "file ends with a newline");
    });

    await runner.test("legacy config keys still drive the mesh view", () => {
      const view = meshView({
        url: "http://legacy:8765",
        token: "legacy-placeholder-token",
        agentName: "Legacy Box",
        agentId: "legacy-box",
        host: "0.0.0.0",
        port: "9100",
      });
      assertEqual(view.node.id, "legacy-box", "node id falls back to agentId");
      assertEqual(view.node.name, "Legacy Box", "node name falls back to agentName");
      assertEqual(view.broker.host, "0.0.0.0", "broker host falls back to legacy host");
      assertEqual(view.broker.port, 9100, "broker port falls back to legacy port");
      assertEqual(view.broker.token, "legacy-placeholder-token", "broker token falls back to legacy token");
      assertEqual(view.discovery.port, 8766, "discovery defaults to 8766/udp");
      assertEqual(view.discovery.enabled, true, "discovery defaults to enabled");
    });

    await runner.test("withMeshDefaults preserves unknown legacy keys", () => {
      const next = withMeshDefaults(
        { url: "http://legacy:8765", agentName: "Legacy Box", customField: 42 },
        { nodeId: "alpha", nodeName: "Alpha", brokerPort: 9200 }
      );
      assertEqual(next.customField, 42, "unrelated key survives");
      assertEqual(next.url, "http://legacy:8765", "legacy url survives");
      assertEqual(next.version, 2, "config is stamped as version 2");
      assertEqual(next.node.id, "alpha", "override applied");
      assertEqual(next.broker.port, 9200, "broker port override applied");
      assertDeepEqual(next.peers, {}, "no peer is invented from the legacy url");
    });

    await runner.test("peers normalize with safe defaults", () => {
      const peers = listPeers({
        peers: {
          tower: { url: "http://192.168.1.9:8765", token: "placeholder" },
          laptop: { url: "http://192.168.1.10:8765", enabled: false, allowPublicHttp: true },
        },
      });
      assertEqual(peers.length, 2, "both peers listed");
      assertEqual(peers[0].name, "laptop", "peers are sorted by name");
      assertEqual(peers[0].enabled, false, "explicit disable respected");
      assertEqual(peers[0].allowPublicHttp, true, "explicit public-http opt-in respected");
      assertEqual(peers[1].enabled, true, "peers default to enabled");
      assertEqual(peers[1].allowPublicHttp, false, "public-http defaults to off");
    });

    await runner.test("sanitizeNodeId produces a stable slug", () => {
      assertEqual(sanitizeNodeId("Naquan's PC!!"), "naquan-s-pc", "punctuation collapses");
      assertEqual(sanitizeNodeId("  DESKTOP-01  "), "desktop-01", "whitespace and case normalized");
    });

    await runner.test("redactValue hides token-shaped keys recursively", () => {
      const secret = generateToken();
      const redacted = redactValue({
        broker: { token: secret, port: 8765 },
        peers: { tower: { url: "http://x", token: secret } },
        headers: { authorization: `Bearer ${secret}` },
        list: [{ apiSecret: secret }],
        keep: "visible",
      });
      const serialized = JSON.stringify(redacted);
      assert(!serialized.includes(secret), "no secret survives redaction");
      assertEqual(redacted.broker.port, 8765, "non-secret siblings survive");
      assertEqual(redacted.keep, "visible", "unrelated values survive");
      assertEqual(redacted.peers.tower.url, "http://x", "peer url stays visible");
      assertEqual(redacted.list[0].apiSecret, "<redacted>", "array members are redacted");
    });

    await runner.test("redactValue tolerates cycles", () => {
      const node = { name: "loop" };
      node.self = node;
      const redacted = redactValue(node);
      assertEqual(redacted.self, "<circular>", "cycle is marked, not recursed");
    });

    await runner.test("redactText scrubs free-form secrets", () => {
      const secret = generateToken();
      assert(!redactText(`Authorization: Bearer ${secret}`).includes(secret), "bearer header scrubbed");
      assert(!redactText(`lcr-cli agent --token ${secret}`).includes(secret), "--token flag scrubbed");
      assert(!redactText(`{"token":"${secret}"}`).includes(secret), "json token scrubbed");
    });

    await runner.test("boolean flags never consume the following positional", () => {
      const parsed = parseArgs(["add", "--allow-public-http", "tower", "--url", "http://192.168.1.9:8765"]);
      assertDeepEqual(parsed._, ["add", "tower"], "peer name is not swallowed");
      assertEqual(parsed["allow-public-http"], true, "safety flag is a real boolean");
      assertEqual(parsed.url, "http://192.168.1.9:8765", "value flags still take values");
    });

    await runner.test("every documented boolean flag is parsed as a boolean", () => {
      const parsed = parseArgs(["--enabled", "x", "--reveal", "y", "--json", "z", "--no-stream", "w"]);
      assertDeepEqual(parsed._, ["x", "y", "z", "w"], "no positional is consumed");
      for (const key of ["enabled", "reveal", "json", "no-stream"]) {
        assertEqual(parsed[key], true, `--${key} is boolean`);
      }
    });

    await runner.test("safety flags reject non-boolean values", () => {
      assertThrows(() => parseArgs(["--allow-public-http=maybe"]), /boolean flag/, "arbitrary string rejected");
      assertThrows(() => parseArgs(["--reveal=yes"]), /boolean flag/, "yes is not accepted as true");
      assertEqual(parseArgs(["--allow-public-http=false"])["allow-public-http"], false, "explicit false honoured");
      assertEqual(parseArgs(["--enabled=true"]).enabled, true, "explicit true honoured");
    });

    await runner.test("value flags reject a missing value instead of becoming true", () => {
      assertThrows(() => parseArgs(["agent", "--token"]), /Missing value for --token/, "bare --token rejected");
      assertThrows(() => parseArgs(["--url", "--json"]), /Missing value for --url/, "flag-as-value rejected");
    });

    await runner.test("existing CLI argument forms still parse", () => {
      const parsed = parseArgs(["--url", "http://127.0.0.1:8765", "--token", "abc", "--port", "8765"]);
      assertEqual(parsed.url, "http://127.0.0.1:8765", "url preserved");
      assertEqual(parsed.token, "abc", "token preserved");
      assertEqual(parsed.port, "8765", "port preserved");
      const passthrough = parseArgs(["exec", "--", "node", "--version"]);
      assertDeepEqual(passthrough._, ["exec", "node", "--version"], "-- passthrough preserved");
    });

    await runner.test("addresses classify into the documented scopes", () => {
      assertEqual(classifyAddress("127.0.0.1"), "loopback", "IPv4 loopback");
      assertEqual(classifyAddress("::1"), "loopback", "IPv6 loopback");
      assertEqual(classifyAddress("10.1.2.3"), "lan", "RFC1918 10/8");
      assertEqual(classifyAddress("172.16.0.1"), "lan", "RFC1918 172.16/12");
      assertEqual(classifyAddress("172.32.0.1"), "public", "172.32 is outside RFC1918");
      assertEqual(classifyAddress("192.168.4.4"), "lan", "RFC1918 192.168/16");
      assertEqual(classifyAddress("169.254.1.1"), "lan", "IPv4 link-local");
      assertEqual(classifyAddress("fd00::1"), "lan", "IPv6 ULA");
      assertEqual(classifyAddress("fe80::1"), "lan", "IPv6 link-local");
      assertEqual(classifyAddress("100.100.5.5"), "private-vpn", "CGNAT / mesh VPN range");
      assertEqual(classifyAddress("8.8.8.8"), "public", "public IPv4");
    });

    await runner.test("IPv4-mapped IPv6 sources normalize", () => {
      assertEqual(normalizeAddress("::ffff:192.168.1.4"), "192.168.1.4", "mapped address unwrapped");
      assertEqual(classifyAddress("::ffff:192.168.1.4"), "lan", "mapped address classified as LAN");
      assertEqual(normalizeAddress("fe80::1%eth0"), "fe80::1", "zone id stripped");
    });

    await runner.test("plain-http public targets require an explicit opt-in", () => {
      assertEqual(classifyUrlTarget("http://192.168.1.9:8765").requiresPublicHttpOptIn, false, "LAN http is fine");
      assertEqual(classifyUrlTarget("http://127.0.0.1:8765").requiresPublicHttpOptIn, false, "loopback http is fine");
      assertEqual(classifyUrlTarget("http://100.80.1.2:8765").requiresPublicHttpOptIn, false, "private VPN http is fine");
      assertEqual(classifyUrlTarget("http://203.0.113.7:8765").requiresPublicHttpOptIn, true, "public http needs opt-in");
      assertEqual(classifyUrlTarget("http://example.com:8765").requiresPublicHttpOptIn, true, "domains are public by default");
      assertEqual(classifyUrlTarget("https://example.com:8765").requiresPublicHttpOptIn, false, "https needs no opt-in");
      assertThrows(() => classifyUrlTarget("ftp://example.com"), /Unsupported url protocol/, "non-http rejected");
      assertThrows(() => classifyUrlTarget("not a url"), /Invalid url/, "garbage rejected");
    });

    await runner.test("peer names cannot replace the normalized map prototype", () => {
      const source = JSON.parse(
        '{"peers":{"__proto__":{"url":"http://127.0.0.1:8765","token":"synthetic","enabled":true}}}'
      );
      const view = meshView(source);
      assertEqual(Object.getPrototypeOf(view.peers), null, "the normalized peer map has no mutable object prototype");
      assert(Object.hasOwn(view.peers, "__proto__"), "a literal __proto__ peer remains an ordinary own record");
      assertEqual(listPeers(source)[0].name, "__proto__", "the peer is listed without mutating object behavior");
    });

    await runner.test("parsePort rejects out-of-range and non-numeric input", () => {
      assertEqual(parsePort("8765"), 8765, "valid port");
      assertEqual(parsePort(0), null, "zero rejected");
      assertEqual(parsePort(70000), null, "above range rejected");
      assertEqual(parsePort("abc"), null, "non-numeric rejected");
      assertEqual(parsePort(true), null, "bare boolean flag rejected");
      assertEqual(parsePort("-1"), null, "negative rejected");
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
