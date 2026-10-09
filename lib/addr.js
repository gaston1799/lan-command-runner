const os = require("node:os");

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_PATTERN = /^[0-9a-f:]+$/i;

function isIpv4(value) {
  const match = IPV4_PATTERN.exec(String(value || ""));
  if (!match) return false;
  return match.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function isIpv6(value) {
  const text = String(value || "");
  return text.includes(":") && IPV6_PATTERN.test(text);
}

function isIpAddress(value) {
  return isIpv4(value) || isIpv6(value);
}

// Strips brackets, zone ids, and the IPv4-mapped IPv6 prefix so that
// `::ffff:192.168.1.4` and `192.168.1.4` compare equal.
function normalizeAddress(value) {
  let text = String(value == null ? "" : value).trim();
  if (!text) return "";
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end !== -1) text = text.slice(1, end);
  }
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const lower = text.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const tail = text.slice("::ffff:".length);
    if (isIpv4(tail)) return tail;
  }
  if (isIpv6(text)) return lower;
  return text;
}

// One of: loopback | lan | private-vpn | public | unspecified | unknown.
// `lan` covers RFC1918, IPv4 link-local, IPv6 ULA and IPv6 link-local.
// `private-vpn` covers 100.64.0.0/10 (CGNAT range used by mesh VPNs).
function classifyAddress(value) {
  const address = normalizeAddress(value);
  if (!address) return "unknown";

  if (isIpv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0) return "unspecified";
    if (a === 127) return "loopback";
    if (a === 10) return "lan";
    if (a === 172 && b >= 16 && b <= 31) return "lan";
    if (a === 192 && b === 168) return "lan";
    if (a === 169 && b === 254) return "lan";
    if (a === 100 && b >= 64 && b <= 127) return "private-vpn";
    return "public";
  }

  if (isIpv6(address)) {
    if (address === "::1") return "loopback";
    if (address === "::") return "unspecified";
    if (/^f[cd]/.test(address)) return "lan";
    if (/^fe[89ab]/.test(address)) return "lan";
    return "public";
  }

  return "unknown";
}

function isPrivateAddress(value) {
  const scope = classifyAddress(value);
  return scope === "loopback" || scope === "lan" || scope === "private-vpn";
}

// Scope for a URL hostname, which may be a name rather than a literal address.
// Unresolved names are deliberately `unknown`, which callers treat as public.
function hostScope(host) {
  const text = String(host == null ? "" : host).trim().toLowerCase();
  if (!text) return "unknown";
  if (text === "localhost" || text.endsWith(".localhost")) return "loopback";
  if (isIpAddress(normalizeAddress(text))) return classifyAddress(text);
  return "unknown";
}

// Decides whether a peer URL is a plain-HTTP target that leaves the private
// network, which is the case that requires an explicit --allow-public-http.
function classifyUrlTarget(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw new Error(`Invalid url: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported url protocol: ${url.protocol.replace(":", "")}. Use http or https.`);
  }
  const scope = hostScope(url.hostname);
  const plainHttp = url.protocol === "http:";
  const publicTarget = scope === "public" || scope === "unknown";
  return {
    url: url.toString(),
    protocol: url.protocol.replace(":", ""),
    host: url.hostname,
    port: url.port ? Number(url.port) : null,
    scope,
    plainHttp,
    publicTarget,
    requiresPublicHttpOptIn: plainHttp && publicTarget,
  };
}

// Stable key for "these two peer records point at the same broker".
function normalizeUrlKey(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.protocol}//${normalizeAddress(url.hostname).toLowerCase()}:${port}`;
  } catch {
    return String(rawUrl || "").trim().toLowerCase();
  }
}

function formatHost(address) {
  const normalized = normalizeAddress(address);
  return isIpv6(normalized) ? `[${normalized}]` : normalized;
}

function parsePort(value) {
  if (value === true || value == null || value === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function getLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function ipv4ToUint(value) {
  if (!isIpv4(value)) return null;
  return value.split(".").map(Number).reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
}

function uintToIpv4(value) {
  const unsigned = value >>> 0;
  return [unsigned >>> 24, (unsigned >>> 16) & 255, (unsigned >>> 8) & 255, unsigned & 255].join(".");
}

// Enumerates usable hosts on an interface subnet. Very large subnets are
// deliberately narrowed to the interface's local /24 so a fallback scan can
// never fan out across an entire /8 or /16.
function subnetHostAddresses(address, netmask, maxHosts = 254) {
  const addressValue = ipv4ToUint(address);
  const maskValue = ipv4ToUint(netmask);
  if (addressValue === null || maskValue === null || maxHosts < 1) return [];

  const network = (addressValue & maskValue) >>> 0;
  const broadcast = (network | (~maskValue >>> 0)) >>> 0;
  if (broadcast <= network + 1) return [address];

  let first = network + 1;
  let last = broadcast - 1;
  if (last - first + 1 > maxHosts) {
    const local24 = (addressValue & 0xffffff00) >>> 0;
    first = Math.max(first, local24 + 1);
    last = Math.min(last, local24 + 254);
  }

  const results = [];
  for (let value = first; value <= last && results.length < maxHosts; value += 1) {
    results.push(uintToIpv4(value));
  }
  return results;
}

// Concrete LAN hosts for TCP fallback discovery. Unlike UDP discovery,
// connecting to a subnet's broadcast address is not useful.
function getLanScanAddresses() {
  const targets = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      for (const address of subnetHostAddresses(entry.address, entry.netmask)) targets.add(address);
    }
  }
  return Array.from(targets);
}

// True when any non-internal interface holds a public (non-RFC1918) address.
// Used to refuse LAN-trust (no-auth) mode on a host that is also reachable
// from the public internet.
function hasPublicInterface() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal && classifyAddress(entry.address) === "public") {
        return true;
      }
    }
  }
  return false;
}

// IPv4 broadcast addresses for every non-internal interface, used as discovery
// targets alongside the global 255.255.255.255.
function getBroadcastAddresses() {
  const targets = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!isIpv4(entry.address) || !isIpv4(entry.netmask)) continue;
      const address = entry.address.split(".").map(Number);
      const mask = entry.netmask.split(".").map(Number);
      const broadcast = address.map((octet, index) => (octet & mask[index]) | (~mask[index] & 255));
      targets.add(broadcast.join("."));
    }
  }
  return Array.from(targets);
}

module.exports = {
  classifyAddress,
  classifyUrlTarget,
  formatHost,
  getBroadcastAddresses,
  getLanAddresses,
  getLanScanAddresses,
  hasPublicInterface,
  hostScope,
  isIpAddress,
  isIpv4,
  isIpv6,
  isPrivateAddress,
  normalizeAddress,
  normalizeUrlKey,
  parsePort,
  subnetHostAddresses,
};
