const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const { DEFAULT_PORT, clampTimeout, jsonResponse, readJson, requireToken } = require("./protocol");

function generateId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
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

function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    host: agent.host,
    registeredAt: agent.registeredAt,
    lastSeenAt: agent.lastSeenAt,
    pendingJobs: agent.jobs.length,
    info: agent.info,
  };
}

function createBroker(options) {
  const adminToken = options.token;
  if (!adminToken) throw new Error("A token is required. Pass --token or set LCR_TOKEN.");

  const agents = new Map();
  const resultWaiters = new Map();

  function getAgent(id) {
    const agent = agents.get(id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }

  function requireAgentToken(req, agent) {
    return requireToken(req, agent.token);
  }

  function enqueueJob(agent, payload) {
    const job = {
      id: generateId("job"),
      command: payload.command,
      shell: Boolean(payload.shell),
      cwd: payload.cwd || "",
      timeoutMs: clampTimeout(payload.timeoutMs),
      createdAt: new Date().toISOString(),
    };

    agent.jobs.push(job);
    const waiter = agent.pollWaiters.shift();
    if (waiter) waiter();
    return job;
  }

  function waitForResult(jobId, waitMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resultWaiters.delete(jobId);
        resolve({ ok: false, code: null, signal: null, timedOut: true, stdout: "", stderr: "Timed out waiting for agent result." });
      }, waitMs);

      resultWaiters.set(jobId, (result) => {
        clearTimeout(timer);
        resultWaiters.delete(jobId);
        resolve(result);
      });
    });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        jsonResponse(res, 200, {
          ok: true,
          mode: "broker",
          host: os.hostname(),
          lanAddresses: getLanAddresses(),
          agents: agents.size,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agent/register") {
        if (!requireToken(req, adminToken)) {
          jsonResponse(res, 401, { ok: false, error: "Unauthorized." });
          return;
        }

        const payload = await readJson(req);
        const id = payload.id || generateId("agent");
        const agent = {
          id,
          token: generateId("secret"),
          name: payload.name || id,
          host: req.socket.remoteAddress || "",
          info: payload.info || {},
          jobs: [],
          pollWaiters: [],
          registeredAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        };
        agents.set(id, agent);
        jsonResponse(res, 200, { ok: true, agentId: id, agentToken: agent.token });
        return;
      }

      const agentPollMatch = url.pathname.match(/^\/agent\/([^/]+)\/poll$/);
      if (req.method === "POST" && agentPollMatch) {
        const agent = getAgent(agentPollMatch[1]);
        if (!requireAgentToken(req, agent)) {
          jsonResponse(res, 401, { ok: false, error: "Unauthorized." });
          return;
        }

        agent.lastSeenAt = new Date().toISOString();
        const timeoutMs = Math.min(Number(url.searchParams.get("timeoutMs") || 25000), 25000);
        if (!agent.jobs.length) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            agent.pollWaiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }

        jsonResponse(res, 200, { ok: true, job: agent.jobs.shift() || null });
        return;
      }

      const agentResultMatch = url.pathname.match(/^\/agent\/([^/]+)\/result$/);
      if (req.method === "POST" && agentResultMatch) {
        const agent = getAgent(agentResultMatch[1]);
        if (!requireAgentToken(req, agent)) {
          jsonResponse(res, 401, { ok: false, error: "Unauthorized." });
          return;
        }

        agent.lastSeenAt = new Date().toISOString();
        const payload = await readJson(req);
        const waiter = resultWaiters.get(payload.jobId);
        if (waiter) waiter(payload.result);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (!requireToken(req, adminToken)) {
        jsonResponse(res, 401, { ok: false, error: "Unauthorized." });
        return;
      }

      if (req.method === "GET" && url.pathname === "/agents") {
        jsonResponse(res, 200, { ok: true, agents: Array.from(agents.values()).map(publicAgent) });
        return;
      }

      const runMatch = url.pathname.match(/^\/agents\/([^/]+)\/run$/);
      if (req.method === "POST" && runMatch) {
        const agent = getAgent(runMatch[1]);
        const payload = await readJson(req);
        const job = enqueueJob(agent, payload);
        const waitMs = Math.min(Number(payload.waitMs || 120000), 10 * 60 * 1000);
        const result = await waitForResult(job.id, waitMs);
        jsonResponse(res, 200, { ...result, agentId: agent.id, jobId: job.id });
        return;
      }

      jsonResponse(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error.message });
    }
  });
}

function broker(options) {
  const host = options.host || process.env.LCR_HOST || "127.0.0.1";
  const port = Number(options.port || process.env.LCR_PORT || DEFAULT_PORT);
  const token = options.token || process.env.LCR_TOKEN;
  const server = createBroker({ token });

  server.listen(port, host, () => {
    const addresses = host === "0.0.0.0" ? getLanAddresses() : [host];
    console.log(`[lcr] Broker listening on ${host}:${port}`);
    console.log(`[lcr] Health: ${addresses.map((address) => `http://${address}:${port}/health`).join(" | ")}`);
    console.log("[lcr] Agents and clients must use the broker token to connect.");
  });
}

module.exports = {
  broker,
  createBroker,
};
