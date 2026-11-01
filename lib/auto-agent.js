const { classifyUrlTarget, normalizeUrlKey } = require("./addr");

function isPrivateBrokerUrl(rawUrl) {
  try {
    const target = classifyUrlTarget(rawUrl);
    return target.scope === "loopback" || target.scope === "lan" || target.scope === "private-vpn";
  } catch {
    return false;
  }
}

function isLocalBrokerUrl(rawUrl, localAddresses = []) {
  try {
    const target = classifyUrlTarget(rawUrl);
    if (target.scope === "loopback") return true;
    return new Set((localAddresses || []).map(String)).has(target.host);
  } catch {
    return false;
  }
}

function ipv4Prefix(address, bits = 24) {
  const parts = String(address || "").split(".");
  if (parts.length !== 4) return "";
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return "";
  return octets.slice(0, Math.max(1, Math.min(4, Math.floor(bits / 8)))).join(".");
}

function urlHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

// Discovery can report the same node through several interfaces. Keep one
// connection per stable node key, preferring LAN over private VPN over
// loopback, then an address on the agent's own subnet, then a fixed lexical
// order. The last two rules matter: without a deterministic tie-break the
// winner follows UDP reply order, so the watcher tears the connection down and
// re-registers on every discovery round when a broker presents two LAN
// addresses.
function mergeBrokerCandidates(candidates, localAddresses = []) {
  const rank = { lan: 0, "private-vpn": 1, loopback: 2 };
  const localSubnets = new Set(
    (localAddresses || []).map((address) => ipv4Prefix(address)).filter(Boolean)
  );
  const ordered = [];
  for (const candidate of candidates || []) {
    if (!candidate || !isPrivateBrokerUrl(candidate.url)) continue;
    const scope = classifyUrlTarget(candidate.url).scope;
    const key = String(candidate.key || normalizeUrlKey(candidate.url));
    const onLocalSubnet = localSubnets.has(ipv4Prefix(urlHost(candidate.url))) ? 0 : 1;
    ordered.push({ ...candidate, key, scope, rank: rank[scope] ?? 3, onLocalSubnet });
  }
  ordered.sort(
    (left, right) =>
      left.rank - right.rank ||
      left.onLocalSubnet - right.onLocalSubnet ||
      (left.url < right.url ? -1 : left.url > right.url ? 1 : 0)
  );

  const selected = new Map();
  for (const candidate of ordered) {
    if (!selected.has(candidate.key)) selected.set(candidate.key, candidate);
  }
  return Array.from(selected.values());
}

module.exports = { isLocalBrokerUrl, isPrivateBrokerUrl, mergeBrokerCandidates };
