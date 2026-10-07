const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  classifyAddress,
  classifyUrlTarget,
  getLanAddresses,
  normalizeAddress,
  normalizeUrlKey,
  parsePort,
} = require("./addr");
const { defaultConfigPath, listPeers, loadConfig, meshView } = require("./config");
const { redactValue, sanitizeError } = require("./redact");
const { DEFAULT_REPO } = require("./update");
const { buildRequestHeaders, verifyResponse, requireSignature } = require("./sign");

const PROBE_TIMEOUT_MS = 5000;
const DEFAULT_PUBLIC_IP_URL = "https://api.ipify.org?format=json";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";

function check(id, name, status, detail, data = {}) {
  return { id, name, status, detail, data };
}

async function fetchJson(url, { timeoutMs = PROBE_TIMEOUT_MS, headers = {}, method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: { accept: "application/json", ...headers },
      ...(body ? { body } : {}),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = null;
    }
    return { ok: response.ok, status: response.status, latencyMs, payload, error: null };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error.name === "AbortError") {
      return { ok: false, status: 0, latencyMs, payload: null, error: `No response within ${timeoutMs}ms.` };
    }
    return { ok: false, status: 0, latencyMs, payload: null, error: sanitizeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function parseVersion(value) {
  const match = String(value || "")
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || "",
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] < b.parts[index] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true }) < 0 ? -1 : 1;
}

function readLocalVersion(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return String(parsed.version || "");
  } catch {
    return "";
  }
}

function readLocalCommit(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function githubUrl(base, repo, suffix) {
  return `${String(base).replace(/\/+$/, "")}/repos/${repo}/${suffix}`;
}

async function updateCheck(options = {}) {
  if (process.env.LCR_DISABLE_UPDATE_CHECK === "1" || options.disableUpdateCheck) {
    return check("updates", "Software updates", "skip", "Update check disabled.", { skipped: true });
  }

  const root = path.resolve(options.packageRoot || path.join(__dirname, ".."));
  const repo = options.repo || process.env.LCR_REPO || DEFAULT_REPO;
  const api = options.githubApiUrl || process.env.LCR_GITHUB_API_URL || DEFAULT_GITHUB_API_URL;
  const localVersion =
    options.localVersion === undefined ? readLocalVersion(root) : String(options.localVersion || "");
  const localCommit =
    options.localCommit === undefined ? readLocalCommit(root) : String(options.localCommit || "");
  const headers = { "user-agent": "lan-command-runner-doctor" };
  const data = {
    repo,
    packageRoot: root,
    localVersion,
    localCommit: localCommit || null,
    latestRelease: null,
    mainCommit: null,
    severity: null,
    updateCommand: "lcr-cli update",
  };

  if (!localVersion) {
    return check(
      "updates",
      "Software updates",
      "warn",
      "Could not read the installed LCR version. Reinstall with the latest release installer.",
      data
    );
  }

  const release = await fetchJson(githubUrl(api, repo, "releases/latest"), { headers });
  if (!release.ok || !release.payload || !release.payload.tag_name) {
    return check(
      "updates",
      "Software updates",
      "warn",
      `Could not check the latest release: ${release.error || `HTTP ${release.status}`}.`,
      data
    );
  }

  data.latestRelease = String(release.payload.tag_name);
  const releaseComparison = compareVersions(localVersion, data.latestRelease);
  if (releaseComparison === null) {
    return check(
      "updates",
      "Software updates",
      "warn",
      `Could not compare local version ${localVersion} with release ${data.latestRelease}.`,
      data
    );
  }
  if (releaseComparison < 0) {
    data.severity = "release";
    return check(
      "updates",
      "Software updates",
      "warn",
      `RELEASE UPDATE AVAILABLE: installed ${localVersion}, latest ${data.latestRelease}. Run: lcr-cli update`,
      data
    );
  }

  if (!localCommit) {
    data.severity = "metadata";
    return check(
      "updates",
      "Software updates",
      "warn",
      `Release ${data.latestRelease} is current, but this installation has no Git commit metadata. Run lcr-cli update to reinstall it as a managed Git clone.`,
      data
    );
  }

  const main = await fetchJson(githubUrl(api, repo, "commits/main"), { headers });
  if (!main.ok || !main.payload || !main.payload.sha) {
    return check(
      "updates",
      "Software updates",
      "warn",
      `Release ${data.latestRelease} is current, but the main branch could not be checked: ${main.error || `HTTP ${main.status}`}.`,
      data
    );
  }

  data.mainCommit = String(main.payload.sha);
  if (localCommit === data.mainCommit) {
    return check(
      "updates",
      "Software updates",
      "ok",
      `Current with release ${data.latestRelease} and main (${localCommit.slice(0, 12)}).`,
      data
    );
  }

  const comparison = await fetchJson(
    githubUrl(api, repo, `compare/${encodeURIComponent(localCommit)}...${encodeURIComponent(data.mainCommit)}`),
    { headers }
  );
  if (!comparison.ok || !comparison.payload) {
    return check(
      "updates",
      "Software updates",
      "warn",
      `Release ${data.latestRelease} is current, but the local commit could not be compared with main: ${
        comparison.error || `HTTP ${comparison.status}`
      }.`,
      data
    );
  }

  const behindBy = Number(comparison.payload.behind_by || 0);
  data.behindBy = behindBy;
  data.aheadBy = Number(comparison.payload.ahead_by || 0);
  data.compareStatus = String(comparison.payload.status || "");
  if (behindBy > 0) {
    data.severity = "main";
    return check(
      "updates",
      "Software updates",
      "warn",
      `Development warning: release ${data.latestRelease} is current, but this copy is ${behindBy} commit(s) behind main. ` +
        "Wait for the next release, or update the Git checkout manually if you intentionally track development.",
      data
    );
  }

  return check(
    "updates",
    "Software updates",
    "ok",
    `Current with release ${data.latestRelease}; local commit is not behind main.`,
    data
  );
}

function tcpProbe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true, error: null }));
    socket.once("timeout", () => finish({ ok: false, error: `No TCP connection within ${timeoutMs}ms.` }));
    socket.once("error", (error) => finish({ ok: false, error: error.code || error.message }));
  });
}

async function probeHealth(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const healthUrl = new URL("/health", url).toString();
  const result = await fetchJson(healthUrl, { timeoutMs });
  return { ...result, healthUrl };
}

// Overridable so tests never touch the Internet.
async function fetchPublicIp(options = {}) {
  if (process.env.LCR_DISABLE_PUBLIC_IP === "1") {
    return { ok: false, skipped: true, ip: null, error: "Public IP lookup disabled by LCR_DISABLE_PUBLIC_IP." };
  }
  const url = options.publicIpUrl || process.env.LCR_PUBLIC_IP_URL || DEFAULT_PUBLIC_IP_URL;
  const result = await fetchJson(url, { timeoutMs: PROBE_TIMEOUT_MS });
  if (!result.ok || !result.payload || !result.payload.ip) {
    return { ok: false, skipped: false, ip: null, url, error: result.error || `Lookup returned HTTP ${result.status}.` };
  }
  return { ok: true, skipped: false, ip: String(result.payload.ip), url, latencyMs: result.latencyMs };
}

function localProbeHost(host) {
  if (!host || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

function configCheck(configPath, config, view) {
  const peers = listPeers(config);
  const enabled = peers.filter((peer) => peer.enabled && peer.url);
  const publicHttp = peers.filter((peer) => peer.allowPublicHttp);

  const duplicates = [];
  const byUrl = new Map();
  for (const peer of enabled) {
    const key = normalizeUrlKey(peer.url);
    if (byUrl.has(key)) duplicates.push(`${peer.name} duplicates ${byUrl.get(key)}`);
    else byUrl.set(key, peer.name);
  }

  const problems = [];
  if (!view.broker.token) problems.push("no broker token configured");
  if (!view.node.id) problems.push("no node id configured");
  if (duplicates.length) problems.push(`duplicate peer broker urls (${duplicates.join("; ")})`);

  const data = {
    path: configPath,
    version: view.version,
    nodeId: view.node.id,
    nodeName: view.node.name,
    brokerHost: view.broker.host,
    brokerPort: view.broker.port,
    brokerTokenConfigured: Boolean(view.broker.token),
    discoveryEnabled: view.discovery.enabled,
    discoveryPort: view.discovery.port,
    peerCount: peers.length,
    enabledPeerCount: enabled.length,
    publicHttpPeers: publicHttp.map((peer) => peer.name),
    duplicatePeerUrls: duplicates,
  };

  if (problems.length) return check("config", "Configuration", "fail", problems.join("; "), data);
  if (view.version < 2) {
    return check("config", "Configuration", "warn", "Legacy v1 configuration; run mesh init to add mesh fields.", data);
  }
  if (publicHttp.length) {
    return check(
      "config",
      "Configuration",
      "warn",
      // Names, not peer objects: joining the records themselves rendered as
      // "[object Object]" and hid which peer had opted in.
      `Valid, but ${publicHttp.length} peer(s) opted into plain-HTTP public transport: ${data.publicHttpPeers.join(", ")}.`,
      data
    );
  }
  return check("config", "Configuration", "ok", `Valid v${view.version} configuration with ${peers.length} peer(s).`, data);
}

async function localBrokerCheck(view) {
  const host = localProbeHost(view.broker.host);
  const port = view.broker.port;
  const listening = await tcpProbe(host, port);
  if (!listening.ok) {
    return check(
      "local-broker",
      "Local broker",
      "fail",
      `Nothing is accepting TCP on ${host}:${port} (${listening.error}). Start it with: lcr-cli mesh`,
      { host, port, listening: false }
    );
  }

  const health = await probeHealth(`http://${host}:${port}`);
  if (!health.ok || !health.payload) {
    return check(
      "local-broker",
      "Local broker",
      "fail",
      `Port ${port} is open but /health failed: ${health.error || `HTTP ${health.status}`}.`,
      { host, port, listening: true, healthUrl: health.healthUrl }
    );
  }
  if (health.payload.mode !== "broker") {
    return check("local-broker", "Local broker", "fail", `${health.healthUrl} is not an LCR broker.`, {
      host,
      port,
      listening: true,
      healthUrl: health.healthUrl,
    });
  }

  const reportedNodeId = String(health.payload.nodeId || "");
  const data = {
    host,
    port,
    listening: true,
    healthUrl: health.healthUrl,
    latencyMs: health.latencyMs,
    nodeId: reportedNodeId,
    nodeName: String(health.payload.nodeName || ""),
    agents: Number(health.payload.agents || 0),
  };
  if (reportedNodeId && reportedNodeId !== view.node.id) {
    return check(
      "local-broker",
      "Local broker",
      "warn",
      `Running broker reports node id "${reportedNodeId}" but the config says "${view.node.id}". Restart the mesh node.`,
      data
    );
  }
  return check(
    "local-broker",
    "Local broker",
    "ok",
    `Healthy on ${host}:${port} with ${data.agents} connected agent(s).`,
    data
  );
}

async function peerChecks(view) {
  const peers = Object.values(view.peers).sort((a, b) => a.name.localeCompare(b.name));
  if (!peers.length) {
    return [check("peers", "Peers", "warn", "No peers configured. Add one with: lcr-cli peer add <name> --url <url>", { peers: [] })];
  }

  const results = await Promise.all(
    peers.map(async (peer) => {
      if (!peer.enabled) {
        return check(`peer:${peer.name}`, `Peer ${peer.name}`, "skip", "Disabled in configuration.", {
          name: peer.name,
          url: peer.url,
          enabled: false,
        });
      }
      // A hand-edited config can hold a peer url that `new URL()` refuses. That
      // must degrade to one failed peer check, never to a rejected Promise.all
      // that takes the entire report down with it.
      if (!peer.url) {
        return check(`peer:${peer.name}`, `Peer ${peer.name}`, "fail", "No url configured.", {
          name: peer.name,
          url: "",
          enabled: true,
          allowPublicHttp: peer.allowPublicHttp,
          reachable: false,
        });
      }

      let health;
      try {
        health = await probeHealth(peer.url);
      } catch (error) {
        return check(
          `peer:${peer.name}`,
          `Peer ${peer.name}`,
          "fail",
          `Unusable url "${peer.url}": ${sanitizeError(error)} Fix it with: lcr-cli peer add ${peer.name} --url <url>`,
          {
            name: peer.name,
            url: peer.url,
            enabled: true,
            allowPublicHttp: peer.allowPublicHttp,
            reachable: false,
            malformedUrl: true,
          }
        );
      }

      const data = {
        name: peer.name,
        url: peer.url,
        enabled: true,
        allowPublicHttp: peer.allowPublicHttp,
        healthUrl: health.healthUrl,
        latencyMs: health.latencyMs,
        nodeId: health.payload ? String(health.payload.nodeId || "") : "",
        nodeName: health.payload ? String(health.payload.nodeName || "") : "",
        reachable: Boolean(health.ok && health.payload && health.payload.mode === "broker"),
      };
      if (!health.ok || !health.payload) {
        return check(
          `peer:${peer.name}`,
          `Peer ${peer.name}`,
          "fail",
          `Unreachable: ${health.error || `HTTP ${health.status}`}.`,
          data
        );
      }
      if (health.payload.mode !== "broker") {
        return check(`peer:${peer.name}`, `Peer ${peer.name}`, "fail", "Responded, but is not an LCR broker.", data);
      }
      return check(
        `peer:${peer.name}`,
        `Peer ${peer.name}`,
        "ok",
        `Healthy at ${peer.url} as ${data.nodeId || "<no node id>"} (${data.latencyMs}ms).`,
        data
      );
    })
  );
  return results;
}

function lanCandidateCheck(view) {
  const addresses = getLanAddresses();
  const brokerHost = normalizeAddress(view.broker.host);
  const scope = classifyAddress(brokerHost);
  const wildcard = brokerHost === "0.0.0.0" || brokerHost === "::";
  const boundLanAddress = addresses.find((address) => normalizeAddress(address) === brokerHost);
  const candidates = wildcard
    ? addresses.map((address) => `http://${address}:${view.broker.port}`)
    : boundLanAddress
      ? [`http://${boundLanAddress}:${view.broker.port}`]
      : [];

  if (scope === "loopback") {
    return check(
      "lan",
      "LAN candidates",
      "warn",
      `The broker is bound to ${view.broker.host}, so other PCs cannot reach it. Re-run: lcr-cli mesh init --host 0.0.0.0`,
      { brokerHost: view.broker.host, addresses, candidates: [] }
    );
  }
  if (!wildcard && !boundLanAddress) {
    return check(
      "lan",
      "LAN candidates",
      "warn",
      `The configured broker host "${view.broker.host}" is not a current LAN interface; no reachable LAN URL can be confirmed.`,
      { brokerHost: view.broker.host, addresses, candidates: [] }
    );
  }
  if (!candidates.length) {
    return check("lan", "LAN candidates", "warn", "No non-internal IPv4 interface found; peers cannot reach this node over the LAN.", {
      addresses,
      candidates,
    });
  }
  return check("lan", "LAN candidates", "ok", `Peers on this LAN should use: ${candidates.join(" | ")}`, {
    addresses,
    candidates,
  });
}

function discoveryConfigCheck(view) {
  if (!view.discovery.enabled) {
    return check("discovery", "LAN discovery", "skip", "Disabled in configuration.", {
      enabled: false,
      host: view.broker.host,
      port: view.discovery.port,
    });
  }
  const scope = classifyAddress(normalizeAddress(view.broker.host));
  if (scope === "loopback") {
    return check(
      "discovery",
      "LAN discovery",
      "warn",
      `Enabled but bound to loopback with the broker at ${view.broker.host}:${view.discovery.port}/udp; other PCs cannot discover this node.`,
      { enabled: true, host: view.broker.host, port: view.discovery.port }
    );
  }
  return check(
    "discovery",
    "LAN discovery",
    "ok",
    `Configured on ${view.broker.host}:${view.discovery.port}/udp. Discovery advertises identity only and grants no trust.`,
    { enabled: true, host: view.broker.host, port: view.discovery.port }
  );
}

async function publicIpCheck(view, options) {
  const result = await fetchPublicIp(options);
  if (result.skipped) {
    return check("public-ip", "Public IPv4 candidate", "skip", result.error, { skipped: true });
  }
  if (!result.ok) {
    return check("public-ip", "Public IPv4 candidate", "warn", `Lookup failed: ${result.error}`, { ok: false });
  }
  return check(
    "public-ip",
    "Public IPv4 candidate",
    "ok",
    `This network egresses as ${result.ip}. This does NOT mean inbound ${view.broker.port}/tcp is reachable — confirm with: lcr-cli doctor --callback-peer <name>`,
    { ip: result.ip, url: result.url, latencyMs: result.latencyMs, inboundVerified: false }
  );
}

async function urlCheck(rawUrl, allowPublicHttp) {
  let target;
  try {
    target = classifyUrlTarget(rawUrl);
  } catch (error) {
    return [check("url", "Target url", "fail", error.message, { url: String(rawUrl) })];
  }

  const checks = [];
  if (target.requiresPublicHttpOptIn && !allowPublicHttp) {
    checks.push(
      check(
        "url-transport",
        "Target transport",
        "warn",
        `${target.url} is plain HTTP to a non-private target. Probing sends no token, but running a broker there exposes credentials and remote commands to interception. Pass --allow-public-http to silence this.`,
        { scope: target.scope, protocol: target.protocol }
      )
    );
  }

  const health = await probeHealth(rawUrl);
  const data = {
    url: rawUrl,
    healthUrl: health.healthUrl,
    scope: target.scope,
    latencyMs: health.latencyMs,
    mode: health.payload ? String(health.payload.mode || "") : "",
    nodeId: health.payload ? String(health.payload.nodeId || "") : "",
    nodeName: health.payload ? String(health.payload.nodeName || "") : "",
  };

  if (!health.ok || !health.payload) {
    checks.push(check("url", "Target health", "fail", `Unreachable: ${health.error || `HTTP ${health.status}`}.`, data));
    return checks;
  }
  checks.push(
    check(
      "url",
      "Target health",
      "ok",
      `Reachable from this machine in ${health.latencyMs}ms (mode: ${data.mode || "unknown"}${data.nodeId ? `, node ${data.nodeId}` : ""}).`,
      data
    )
  );
  return checks;
}

// Asks an authenticated peer to call back to *our* observed source address on
// our configured broker port. The peer decides the host; we only declare a port
// and the node id it must find there.
async function callbackCheck(view, peerName) {
  const peer = view.peers[peerName];
  if (!peer) {
    return check("callback", "Callback reachability", "fail", `Unknown peer "${peerName}".`, { peer: peerName });
  }
  if (!peer.url) return check("callback", "Callback reachability", "fail", `Peer "${peerName}" has no url.`, { peer: peerName });
  if (!peer.token) {
    return check(
      "callback",
      "Callback reachability",
      "fail",
      `Peer "${peerName}" has no token; the callback endpoint requires the peer broker's admin token.`,
      { peer: peerName }
    );
  }

  const callbackBody = JSON.stringify({ port: view.broker.port, expectedNodeId: view.node.id });
  const signatureHeaders = buildRequestHeaders({
    secret: peer.token,
    method: "POST",
    path: "/diagnostics/callback",
    body: callbackBody,
  });
  const result = await fetchJson(new URL("/diagnostics/callback", peer.url).toString(), {
    method: "POST",
    timeoutMs: PROBE_TIMEOUT_MS + 3000,
    headers: { authorization: `Bearer ${peer.token}`, "content-type": "application/json", ...signatureHeaders },
    body: callbackBody,
  });

  const data = {
    peer: peerName,
    peerUrl: peer.url,
    declaredPort: view.broker.port,
    expectedNodeId: view.node.id,
  };

  if (!result.ok || !result.payload) {
    if (result.status === 401) {
      return check("callback", "Callback reachability", "fail", `Peer "${peerName}" rejected the stored token.`, data);
    }
    return check(
      "callback",
      "Callback reachability",
      "fail",
      `Peer "${peerName}" did not complete the callback: ${result.error || `HTTP ${result.status}`}.`,
      data
    );
  }

  const payload = result.payload;
  Object.assign(data, {
    observedAddress: payload.observedAddress,
    scope: payload.scope,
    testedUrl: payload.testedUrl,
    reachable: Boolean(payload.reachable),
    latencyMs: payload.latencyMs,
    error: payload.error || null,
  });

  if (!payload.reachable) {
    return check(
      "callback",
      "Callback reachability",
      "fail",
      `${peerName} saw us as ${payload.observedAddress} (${payload.scope}) but could not verify ${payload.testedUrl}: ${payload.error}`,
      data
    );
  }
  return check(
    "callback",
    "Callback reachability",
    "ok",
    `${peerName} reached this node at ${payload.testedUrl} in ${payload.latencyMs}ms. Verified path scope: ${payload.scope}.`,
    data
  );
}

async function runDoctor(options = {}) {
  const configPath = options.configPath || defaultConfigPath();
  const checks = [await updateCheck(options)];
  let config = {};
  let view = meshView({});

  try {
    config = loadConfig(configPath);
    view = meshView(config);
  } catch (error) {
    checks.push(check("config", "Configuration", "fail", sanitizeError(error), { path: configPath }));
    return finalize(checks, view, configPath, options);
  }

  if (options.url) {
    checks.push(...(await urlCheck(options.url, Boolean(options.allowPublicHttp))));
  } else if (options.peer) {
    const peer = view.peers[options.peer];
    if (!peer) {
      checks.push(check("peer", "Peer", "fail", `Unknown peer "${options.peer}".`, { peer: options.peer }));
    } else {
      checks.push(...(await urlCheck(peer.url, Boolean(options.allowPublicHttp || peer.allowPublicHttp))));
    }
  } else {
    checks.push(configCheck(configPath, config, view));
    checks.push(await localBrokerCheck(view));
    checks.push(...(await peerChecks(view)));
    checks.push(discoveryConfigCheck(view));
    checks.push(lanCandidateCheck(view));
    checks.push(await publicIpCheck(view, options));
  }

  if (options.callbackPeer) {
    checks.push(await callbackCheck(view, options.callbackPeer));
  }

  return finalize(checks, view, configPath, options);
}

function finalize(checks, view, configPath, options) {
  const failed = checks.filter((entry) => entry.status === "fail").length;
  const warned = checks.filter((entry) => entry.status === "warn").length;
  const report = {
    ok: failed === 0,
    mode: options.url ? "url" : options.peer ? "peer" : "overview",
    configPath,
    node: { id: view.node.id, name: view.node.name },
    summary: { total: checks.length, failed, warned },
    checks,
  };
  // Defence in depth: nothing token-shaped should reach stdout or a log file.
  return redactValue(report);
}

const STATUS_LABEL = { ok: "OK    ", warn: "WARN  ", fail: "FAIL  ", skip: "SKIP  " };

function formatReport(report) {
  const lines = [];
  lines.push(`LCR doctor — node ${report.node.id} (${report.node.name})`);
  lines.push(`Config: ${report.configPath}`);
  lines.push("");
  for (const entry of report.checks) {
    const label = entry.id === "updates" && entry.data && entry.data.severity === "release"
      ? "UPDATE"
      : STATUS_LABEL[entry.status] || entry.status;
    lines.push(`[${label}] ${entry.name}`);
    if (entry.detail) lines.push(`       ${entry.detail}`);
  }
  lines.push("");
  lines.push(
    report.ok
      ? `All ${report.summary.total} check(s) passed${report.summary.warned ? ` with ${report.summary.warned} warning(s)` : ""}.`
      : `${report.summary.failed} of ${report.summary.total} check(s) failed.`
  );
  return lines.join("\n");
}

module.exports = {
  DEFAULT_GITHUB_API_URL,
  DEFAULT_PUBLIC_IP_URL,
  PROBE_TIMEOUT_MS,
  compareVersions,
  fetchPublicIp,
  formatReport,
  probeHealth,
  readLocalCommit,
  readLocalVersion,
  runDoctor,
  tcpProbe,
  updateCheck,
};
