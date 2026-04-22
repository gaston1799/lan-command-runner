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
  const jobStreams = new Map();

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
      type: payload.type || "command",
      command: payload.command,
      shell: Boolean(payload.shell),
      cwd: payload.cwd || "",
      timeoutMs: clampTimeout(payload.timeoutMs),
      path: payload.path || "",
      contentBase64: payload.contentBase64 || "",
      mkdirp: payload.mkdirp !== false,
      stream: Boolean(payload.stream),
      createdAt: new Date().toISOString(),
    };

    if (job.stream) createJobStream(job.id);
    agent.jobs.push(job);
    const waiter = agent.pollWaiters.shift();
    if (waiter) waiter();
    return job;
  }

  function createJobStream(jobId) {
    const stream = {
      events: [],
      waiters: [],
      nextSeq: 1,
      done: false,
      createdAt: Date.now(),
    };
    jobStreams.set(jobId, stream);
    return stream;
  }

  function appendJobEvent(jobId, event) {
    const stream = jobStreams.get(jobId);
    if (!stream) return;
    const entry = {
      seq: stream.nextSeq,
      at: new Date().toISOString(),
      ...event,
    };
    stream.nextSeq += 1;
    stream.events.push(entry);
    if (stream.events.length > 1000) stream.events.splice(0, stream.events.length - 1000);
    if (entry.type === "result") {
      stream.done = true;
      setTimeout(() => jobStreams.delete(jobId), 5 * 60 * 1000).unref();
    }
    const waiters = stream.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  async function waitForJobEvents(jobId, afterSeq, waitMs) {
    const stream = jobStreams.get(jobId);
    if (!stream) throw new Error(`Unknown streamed job: ${jobId}`);
    const events = stream.events.filter((event) => event.seq > afterSeq);
    if (events.length || stream.done) return { events, done: stream.done };
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      stream.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return {
      events: stream.events.filter((event) => event.seq > afterSeq),
      done: stream.done,
    };
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
        appendJobEvent(payload.jobId, { type: "result", result: payload.result });
        const waiter = resultWaiters.get(payload.jobId);
        if (waiter) waiter(payload.result);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      const agentOutputMatch = url.pathname.match(/^\/agent\/([^/]+)\/output$/);
      if (req.method === "POST" && agentOutputMatch) {
        const agent = getAgent(agentOutputMatch[1]);
        if (!requireAgentToken(req, agent)) {
          jsonResponse(res, 401, { ok: false, error: "Unauthorized." });
          return;
        }

        agent.lastSeenAt = new Date().toISOString();
        const payload = await readJson(req);
        appendJobEvent(payload.jobId, {
          type: "output",
          stream: payload.stream === "stderr" ? "stderr" : "stdout",
          data: String(payload.data || ""),
        });
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
        if (payload.stream) {
          jsonResponse(res, 202, { ok: true, agentId: agent.id, jobId: job.id, stream: true });
          return;
        }
        const waitMs = Math.min(Number(payload.waitMs || 120000), 10 * 60 * 1000);
        const result = await waitForResult(job.id, waitMs);
        jsonResponse(res, 200, { ...result, agentId: agent.id, jobId: job.id });
        return;
      }

      const jobEventsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
      if (req.method === "GET" && jobEventsMatch) {
        const jobId = jobEventsMatch[1];
        const afterSeq = Number(url.searchParams.get("after") || 0);
        const waitMs = Math.min(Number(url.searchParams.get("waitMs") || 25000), 25000);
        const payload = await waitForJobEvents(jobId, afterSeq, waitMs);
        jsonResponse(res, 200, { ok: true, ...payload });
        return;
      }

      const fileReadMatch = url.pathname.match(/^\/agents\/([^/]+)\/file\/read$/);
      if (req.method === "POST" && fileReadMatch) {
        const agent = getAgent(fileReadMatch[1]);
        const payload = await readJson(req);
        const job = enqueueJob(agent, { type: "file.read", path: payload.path, timeoutMs: payload.timeoutMs });
        const waitMs = Math.min(Number(payload.waitMs || 120000), 10 * 60 * 1000);
        const result = await waitForResult(job.id, waitMs);
        jsonResponse(res, 200, { ...result, agentId: agent.id, jobId: job.id });
        return;
      }

      const fileWriteMatch = url.pathname.match(/^\/agents\/([^/]+)\/file\/write$/);
      if (req.method === "POST" && fileWriteMatch) {
        const agent = getAgent(fileWriteMatch[1]);
        const payload = await readJson(req);
        const job = enqueueJob(agent, {
          type: "file.write",
          path: payload.path,
          contentBase64: payload.contentBase64,
          mkdirp: payload.mkdirp,
          timeoutMs: payload.timeoutMs,
        });
        const waitMs = Math.min(Number(payload.waitMs || 120000), 10 * 60 * 1000);
        const result = await waitForResult(job.id, waitMs);
        jsonResponse(res, 200, { ...result, agentId: agent.id, jobId: job.id });
        return;
      }

      const disconnectMatch = url.pathname.match(/^\/agents\/([^/]+)\/disconnect$/);
      if (req.method === "POST" && disconnectMatch) {
        const agent = getAgent(disconnectMatch[1]);
        const payload = await readJson(req);
        const job = enqueueJob(agent, { type: "agent.exit", timeoutMs: payload.timeoutMs });
        const waitMs = Math.min(Number(payload.waitMs || 30000), 120000);
        const result = await waitForResult(job.id, waitMs);
        agents.delete(agent.id);
        jsonResponse(res, 200, { ...result, agentId: agent.id, jobId: job.id });
        return;
      }

      const updateMatch = url.pathname.match(/^\/agents\/([^/]+)\/update$/);
      if (req.method === "POST" && updateMatch) {
        const agent = getAgent(updateMatch[1]);
        const payload = await readJson(req);
        const job = enqueueJob(agent, { type: "agent.update", timeoutMs: payload.timeoutMs });
        const waitMs = Math.min(Number(payload.waitMs || 30000), 120000);
        const result = await waitForResult(job.id, waitMs);
        if (result.ok) agents.delete(agent.id);
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
