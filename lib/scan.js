// TCP /broker scan — the fallback/enumeration discovery path (UDP broadcast is
// primary). Probes the broker port range on LAN hosts and reports any LCR
// broker it finds via its minimal /broker endpoint.

const { getLanScanAddresses } = require("./addr");
const { portRange } = require("./port");

async function probeBroker(host, port, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${port}/broker`, {
      signal: controller.signal,
      redirect: "manual",
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || payload.ok !== true || !Number.isFinite(payload.protocolVersion)) return null;
    return {
      host,
      port,
      protocolVersion: payload.protocolVersion,
      authMode: payload.authMode === "none" ? "none" : "token",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Scans [range.min, range.max] on each target host. Connection-refused ports
// fail fast; only a listening non-LCR port waits out the timeout.
async function scanBrokers({ hosts, range = portRange(), concurrency = 32, timeoutMs = 350 } = {}) {
  const targets = hosts && hosts.length ? hosts : getLanScanAddresses();
  const finalTargets = targets.length ? targets : ["127.0.0.1"];

  const jobs = [];
  for (const host of finalTargets) {
    for (let port = range.min; port <= range.max; port += 1) jobs.push([host, port]);
  }

  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const [host, port] = jobs[cursor];
      cursor += 1;
      const found = await probeBroker(host, port, timeoutMs);
      if (found) results.push(found);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const seen = new Set();
  return results
    .filter((entry) => {
      const key = `${entry.host}:${entry.port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port);
}

module.exports = {
  probeBroker,
  scanBrokers,
};
