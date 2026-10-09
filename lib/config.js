const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DEFAULT_PORT } = require("./protocol");
const { parsePort } = require("./addr");

const CONFIG_VERSION = 2;
const DEFAULT_DISCOVERY_PORT = 8766;

let tempCounter = 0;

function defaultConfigPath() {
  if (process.env.LCR_CONFIG) return process.env.LCR_CONFIG;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "lan-command-runner", "config.json");
}

// Returns {} only when the file is absent. Anything unreadable or malformed
// throws, so a torn config can never silently present as "no peers, no token".
function loadConfig(configPath = defaultConfigPath()) {
  if (!fs.existsSync(configPath)) return {};

  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read config at ${configPath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid config JSON at ${configPath}: ${error.message}. Fix or remove the file, then re-run lcr-cli mesh init.`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config at ${configPath}: expected a JSON object.`);
  }
  return parsed;
}

// Best effort, and deliberately quiet about *why* beyond the OS message: the
// config holds broker and peer tokens, so world-readable is not acceptable.
function restrictConfigPermissions(configPath, warn = (message) => console.error(`[lcr] ${message}`)) {
  if (process.env.LCR_SKIP_CONFIG_ACL === "1") return { ok: true, skipped: true };

  if (process.platform !== "win32") {
    try {
      fs.chmodSync(configPath, 0o600);
      return { ok: true, mode: "0600" };
    } catch (error) {
      warn(`warning: could not restrict permissions on ${configPath} (${error.code || error.message}).`);
      return { ok: false, error: error.code || error.message };
    }
  }

  const username = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return process.env.USERNAME || "";
    }
  })();
  if (!username) {
    warn(`warning: could not determine the current user to restrict ${configPath}.`);
    return { ok: false, error: "unknown-user" };
  }

  const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
  const result = spawnSync("icacls", [configPath, "/inheritance:r", "/grant:r", `${principal}:F`], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    warn(`warning: could not restrict permissions on ${configPath} via icacls. Review the file ACL manually.`);
    return { ok: false, error: "icacls-failed" };
  }
  return { ok: true, mode: "icacls" };
}

// Same-directory temp file + atomic rename, so a crash mid-write leaves the
// previous config intact rather than a truncated one.
function saveConfig(config, configPath = defaultConfigPath(), options = {}) {
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true });

  tempCounter += 1;
  const tempPath = path.join(directory, `.${path.basename(configPath)}.tmp-${process.pid}-${tempCounter}`);
  const body = `${JSON.stringify(config, null, 2)}\n`;

  try {
    fs.writeFileSync(tempPath, body, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, configPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      /* the temp file is already gone or unreachable */
    }
    throw error;
  }

  restrictConfigPermissions(configPath, options.warn);
  return configPath;
}

function sanitizeNodeId(value) {
  const cleaned = String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.slice(0, 64);
}

function portOrDefault(value, fallback) {
  return parsePort(value) || fallback;
}

function normalizePeer(name, raw) {
  const peer = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    name: String(name),
    url: String(peer.url || "").trim(),
    token: typeof peer.token === "string" ? peer.token : "",
    enabled: peer.enabled !== false,
    allowPublicHttp: peer.allowPublicHttp === true,
  };
}

// Read-only normalized view. Legacy top-level keys remain the fallback for
// every mesh field so a v1 config keeps working untouched.
function meshView(config) {
  const source = config && typeof config === "object" ? config : {};
  const node = source.node && typeof source.node === "object" ? source.node : {};
  const broker = source.broker && typeof source.broker === "object" ? source.broker : {};
  const discovery = source.discovery && typeof source.discovery === "object" ? source.discovery : {};
  const auth = source.auth && typeof source.auth === "object" ? source.auth : {};
  const rawPeers =
    source.peers && typeof source.peers === "object" && !Array.isArray(source.peers) ? source.peers : {};

  const peers = Object.create(null);
  for (const [name, value] of Object.entries(rawPeers)) peers[name] = normalizePeer(name, value);

  const hostname = os.hostname();
  return {
    version: Number(source.version) || 1,
    node: {
      id: sanitizeNodeId(node.id || source.agentId || hostname) || "lcr-node",
      name: String(node.name || source.agentName || hostname),
    },
    broker: {
      host: String(broker.host || source.host || "127.0.0.1"),
      port: portOrDefault(broker.port != null ? broker.port : source.port, DEFAULT_PORT),
      token: String(broker.token || source.token || ""),
    },
    peers,
    discovery: {
      enabled: discovery.enabled !== false,
      port: portOrDefault(discovery.port, DEFAULT_DISCOVERY_PORT),
    },
    auth: {
      mode: auth.mode === "none" ? "none" : "token",
      allowNodes: Array.isArray(auth.allowNodes) ? auth.allowNodes.map(String) : [],
      allowSubnets: Array.isArray(auth.allowSubnets) ? auth.allowSubnets.map(String) : [],
    },
  };
}

function listPeers(config) {
  return Object.values(meshView(config).peers).sort((a, b) => a.name.localeCompare(b.name));
}

function enabledPeers(config) {
  return listPeers(config).filter((peer) => peer.enabled && peer.url);
}

function hasMeshSection(config) {
  const source = config && typeof config === "object" ? config : {};
  return Boolean(source.node || source.broker || source.peers || source.discovery || source.auth);
}

// Additive: fills in the v2 sections while leaving every existing key in place.
function withMeshDefaults(config, overrides = {}) {
  const source = config && typeof config === "object" ? config : {};
  const view = meshView(source);
  const node = source.node && typeof source.node === "object" ? source.node : {};
  const broker = source.broker && typeof source.broker === "object" ? source.broker : {};
  const discovery = source.discovery && typeof source.discovery === "object" ? source.discovery : {};
  const auth = source.auth && typeof source.auth === "object" ? source.auth : {};
  const peers = source.peers && typeof source.peers === "object" && !Array.isArray(source.peers) ? source.peers : {};

  return {
    ...source,
    version: CONFIG_VERSION,
    node: {
      ...node,
      id: overrides.nodeId ? sanitizeNodeId(overrides.nodeId) : view.node.id,
      name: overrides.nodeName ? String(overrides.nodeName) : view.node.name,
    },
    broker: {
      ...broker,
      host: overrides.brokerHost ? String(overrides.brokerHost) : view.broker.host,
      port: overrides.brokerPort ? portOrDefault(overrides.brokerPort, view.broker.port) : view.broker.port,
      token: overrides.brokerToken ? String(overrides.brokerToken) : view.broker.token,
    },
    peers: { ...peers },
    auth: {
      ...auth,
      ...(overrides.authMode ? { mode: overrides.authMode === "none" ? "none" : "token" } : {}),
    },
    discovery: {
      ...discovery,
      enabled: overrides.discoveryEnabled != null ? Boolean(overrides.discoveryEnabled) : view.discovery.enabled,
      port: overrides.discoveryPort ? portOrDefault(overrides.discoveryPort, view.discovery.port) : view.discovery.port,
    },
  };
}

module.exports = {
  CONFIG_VERSION,
  DEFAULT_DISCOVERY_PORT,
  defaultConfigPath,
  enabledPeers,
  hasMeshSection,
  listPeers,
  loadConfig,
  meshView,
  normalizePeer,
  restrictConfigPermissions,
  sanitizeNodeId,
  saveConfig,
  withMeshDefaults,
};
