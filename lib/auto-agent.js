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

// Discovery can report the same node through several interfaces. Keep one
// connection per stable node key, preferring LAN over private VPN over loopback.
function mergeBrokerCandidates(candidates) {
  const rank = { lan: 0, "private-vpn": 1, loopback: 2 };
  const selected = new Map();
  for (const candidate of candidates || []) {
    if (!candidate || !isPrivateBrokerUrl(candidate.url)) continue;
    const scope = classifyUrlTarget(candidate.url).scope;
    const key = String(candidate.key || normalizeUrlKey(candidate.url));
    const current = selected.get(key);
    if (!current || rank[scope] < rank[current.scope]) selected.set(key, { ...candidate, key, scope });
  }
  return Array.from(selected.values());
}

module.exports = { isLocalBrokerUrl, isPrivateBrokerUrl, mergeBrokerCandidates };
