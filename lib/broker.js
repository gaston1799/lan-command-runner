const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const { DEFAULT_PORT, clampTimeout, jsonResponse } = require("./protocol");
const { classifyAddress, formatHost, normalizeAddress, parsePort } = require("./addr");
const { sanitizeError } = require("./redact");
const { AuthThrottle, generateAgentToken, generateNodeId } = require("./auth");
const { ReplayCache, authorize, respond } = require("./guard");
const { createAuditLogger } = require("./audit");
const limits = require("./limits");
const MAX_EVENTS_PER_POLL = 24;
const CALLBACK_TIMEOUT_MS = 5000;

function generateId(prefix) {
  return generateNodeId(prefix);
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

function publicAgent(agent, now = Date.now()) {
  const ageMs = Math.max(0, now - Date.parse(agent.lastSeenAt || 0));
  return {
    id: agent.id,
    name: agent.name,
    host: agent.host,
    registeredAt: agent.registeredAt,
    lastSeenAt: agent.lastSeenAt,
    online: ageMs < limits.agentOfflineMs(),
    lastSeenAgeMs: ageMs,
    pendingJobs: agent.jobs.length,
    info: agent.info,
  };
}

// Maps the address a peer observed us arriving from onto a human-facing scope.
// This is the only honest way to answer "can that node actually reach me?".
function callbackScope(address) {
  const scope = classifyAddress(address);
  if (scope === "loopback") return "local";
  if (scope === "lan") return "lan";
  if (scope === "private-vpn") return "private-vpn";
  if (scope === "public") return "public";
  return "unknown";
}

// Probes the caller's *observed* source address on a caller-declared port.
// Deliberately not an open fetcher: no host, url, path, or protocol from the
// request body is ever honoured, so this cannot be turned into an SSRF or a
// port scanner aimed at third parties.
async function probeCallback(observedAddress, port, expectedNodeId) {
  const testedUrl = `http://${formatHost(observedAddress)}:${port}/health`;
  const nonce = crypto.randomBytes(16).toString("hex");
  const probeUrl = `${testedUrl}?nonce=${nonce}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(probeUrl, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return { reachable: false, testedUrl, latencyMs, error: `Health endpoint returned HTTP ${response.status}.` };
    }
    if (!payload || typeof payload !== "object") {
      return { reachable: false, testedUrl, latencyMs, error: "Health endpoint did not return JSON." };
    }
    if (payload.mode !== "broker") {
      return { reachable: false, testedUrl, latencyMs, error: "Health endpoint is not an LCR broker." };
    }
    if (String(payload.nodeId || "") !== expectedNodeId) {
      return {
        reachable: false,
        testedUrl,
        latencyMs,
        error: "Reached a broker, but its node id did not match the expected node id.",
      };
    }
    if (String(payload.nonce || "") !== nonce) {
      return {
        reachable: false,
        testedUrl,
        latencyMs,
        error: "Reached a broker, but its health response did not echo the callback challenge.",
      };
    }
    return { reachable: true, testedUrl, latencyMs, error: null, nodeName: String(payload.nodeName || "") };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error.name === "AbortError") {
      return { reachable: false, testedUrl, latencyMs, error: `No response within ${CALLBACK_TIMEOUT_MS}ms.` };
    }
    return { reachable: false, testedUrl, latencyMs, error: sanitizeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function createBroker(options) {
  const adminToken = options.token;
  if (!adminToken) throw new Error("A token is required. Pass --token or set LCR_TOKEN.");
  const nodeId = options.nodeId ? String(options.nodeId) : "";
  const nodeName = options.nodeName ? String(options.nodeName) : "";

  const agents = new Map();
  const resultWaiters = new Map();
  const jobStreams = new Map();
  const jobIndex = new Map(); // jobId -> { id, agentId, type, createdAt, startedAt, endedAt, status }
  const activeJobs = new Map(); // jobId -> agentId while the agent is running it
  const throttle = new AuthThrottle();
  const replayCache = new ReplayCache();
  const audit = options.audit || createAuditLogger();
  let sweepTimer = null;

  function sweepLiveness(now = Date.now()) {
    for (const [id, agent] of agents) {
      const ageMs = now - Date.parse(agent.lastSeenAt || 0);
      if (ageMs >= limits.agentPruneMs()) {
        for (const job of agent.jobs) {
          jobIndex.delete(job.id);
          activeJobs.delete(job.id);
          const stream = jobStreams.get(job.id);
          if (stream) {
            stream.done = true;
            setTimeout(() => jobStreams.delete(job.id), 1000).unref();
          }
        }
        agents.delete(id);
        audit.write({ host: "broker", event: "agent.pruned", agentId: id });
        continue;
      }
    }
    const cutoff = now - limits.jobTtlMs();
    for (const [jobId, meta] of jobIndex) {
      if (meta.status === "done" && meta.endedAt && meta.endedAt < cutoff) jobIndex.delete(jobId);
    }
  }

  function getAgent(id) {
    const agent = agents.get(id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }

  function enqueueJob(agent, payload) {
    if (agent.jobs.length >= limits.jobBacklogMax()) {
      const error = new Error(
        `Agent ${agent.id} already has ${agent.jobs.length} queued job(s); refusing more.`
      );
      error.status = 429;
      throw error;
    }

    const job = {
      id: generateId("job"),
      type: payload.type || "command",
      command: payload.command,
      shell: Boolean(payload.shell),
      cwd: payload.cwd || "",
      timeoutMs: clampTimeout(payload.timeoutMs),
      path: payload.path || "",
      sourcePath: payload.sourcePath || "",
      targetPath: payload.targetPath || "",
      contentBase64: payload.contentBase64 || "",
      mkdirp: payload.mkdirp !== false,
      expectedSize: payload.expectedSize,
      sha256: payload.sha256 || "",
      overwrite: payload.overwrite !== false,
      stream: Boolean(payload.stream),
      createdAt: new Date().toISOString(),
    };

    jobIndex.set(job.id, {
      id: job.id,
      agentId: agent.id,
      type: job.type,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      status: "queued",
    });
    audit.write({ host: "broker", event: "job.queued", jobId: job.id, agentId: agent.id, type: job.type });

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
      clientCursor: 0,
      bufferedBytes: 0,
      drainWaiters: [],
    };
    jobStreams.set(jobId, stream);
    return stream;
  }

  function eventBytes(event) {
    if (event.type === "file-chunk") return Buffer.byteLength(event.dataBase64 || "");
    if (event.type === "output") return Buffer.byteLength(event.data || "");
    return 0;
  }

  function recomputeBuffered(stream) {
    let total = 0;
    for (const event of stream.events) {
      if (event.seq > stream.clientCursor) total += eventBytes(event);
    }
    stream.bufferedBytes = total;
  }

  function releaseDrains(stream) {
    if (stream.bufferedBytes <= limits.streamLowWaterBytes()) {
      const waiters = stream.drainWaiters.splice(0);
      for (const waiter of waiters) waiter();
    }
  }

  // Backpressure: while more than HIGH_WATER bytes sit unread by the client,
  // the agent's /output POST is held, pacing the producer to the consumer.
  async function drainIfNeeded(stream) {
    if (!stream) return;
    const high = limits.streamHighWaterBytes();
    let remaining = limits.streamDrainTimeoutMs();
    while (stream.bufferedBytes > high && remaining > 0) {
      const started = Date.now();
      if (stream.drainWaiters.length < 64) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, remaining);
          stream.drainWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 500)));
      }
      remaining -= Date.now() - started;
    }
  }

  function appendJobEvent(jobId, event) {
    const stream = jobStreams.get(jobId);
    if (!stream) return null;
    const entry = {
      seq: stream.nextSeq,
      at: new Date().toISOString(),
      ...event,
    };
    stream.nextSeq += 1;
    stream.events.push(entry);
    if (stream.events.length > 1000) stream.events.splice(0, stream.events.length - 1000);
    recomputeBuffered(stream);
    if (entry.type === "result") {
      stream.done = true;
      setTimeout(() => jobStreams.delete(jobId), 5 * 60 * 1000).unref();
    }
    const waiters = stream.waiters.splice(0);
    for (const waiter of waiters) waiter();
    return stream;
  }

  async function waitForJobEvents(jobId, afterSeq, waitMs) {
    const stream = jobStreams.get(jobId);
    if (!stream) throw new Error(`Unknown streamed job: ${jobId}`);
    stream.clientCursor = Math.max(stream.clientCursor, Number(afterSeq) || 0);
    recomputeBuffered(stream);
    releaseDrains(stream);
    const pendingEvents = stream.events.filter((event) => event.seq > afterSeq);
    if (pendingEvents.length || stream.done) {
      return {
        events: pendingEvents.slice(0, MAX_EVENTS_PER_POLL),
        done: stream.done && pendingEvents.length <= MAX_EVENTS_PER_POLL,
      };
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      stream.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    const nextPendingEvents = stream.events.filter((event) => event.seq > afterSeq);
    return {
      events: nextPendingEvents.slice(0, MAX_EVENTS_PER_POLL),
      done: stream.done && nextPendingEvents.length <= MAX_EVENTS_PER_POLL,
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

  // Sends a job to the agent and waits for (or opens the stream of) its result.
  async function dispatchJob(req, res, agent, payload, jobSpec) {
    const job = enqueueJob(agent, { ...jobSpec });
    if (payload.stream) {
      respond(req, res, { status: 202, payload: { ok: true, agentId: agent.id, jobId: job.id, stream: true } });
      return;
    }
    const waitMs = Math.min(Number(payload.waitMs || 120000), 10 * 60 * 1000);
    const result = await waitForResult(job.id, waitMs);
    respond(req, res, { payload: { ...result, agentId: agent.id, jobId: job.id } });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        const nonce = String(url.searchParams.get("nonce") || "").slice(0, 64);
        jsonResponse(res, 200, {
          ok: true,
          mode: "broker",
          host: os.hostname(),
          lanAddresses: getLanAddresses(),
          agents: agents.size,
          nodeId,
          nodeName,
          ...(nonce ? { nonce } : {}),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agent/register") {
        const payload = await authorize(req, res, { secret: adminToken, throttle, replayCache });
        if (payload === null) return;
        const id = payload.id || generateId("agent");
        const agent = {
          id,
          token: generateAgentToken(),
          name: payload.name || id,
          host: req.socket.remoteAddress || "",
          info: payload.info || {},
          jobs: [],
          pollWaiters: [],
          registeredAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        };
        agents.set(id, agent);
        audit.write({ host: "broker", event: "agent.register", agentId: id, name: agent.name, remoteIp: req.socket.remoteAddress || "" });
        respond(req, res, { payload: { ok: true, agentId: id, agentToken: agent.token } });
        return;
      }

      const agentPollMatch = url.pathname.match(/^\/agent\/([^/]+)\/poll$/);
      if (req.method === "POST" && agentPollMatch) {
        const agent = agents.get(agentPollMatch[1]);
        const payload = await authorize(req, res, { secret: agent ? agent.token : "", throttle, replayCache });
        if (payload === null) return;

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

        const job = agent.jobs.shift() || null;
        if (job) {
          activeJobs.set(job.id, agent.id);
          const meta = jobIndex.get(job.id);
          if (meta) {
            meta.status = "running";
            meta.startedAt = Date.now();
          }
        }
        respond(req, res, { payload: { ok: true, job } });
        return;
      }

      const agentResultMatch = url.pathname.match(/^\/agent\/([^/]+)\/result$/);
      if (req.method === "POST" && agentResultMatch) {
        const agent = agents.get(agentResultMatch[1]);
        const payload = await authorize(req, res, { secret: agent ? agent.token : "", throttle, replayCache });
        if (payload === null) return;

        agent.lastSeenAt = new Date().toISOString();
        appendJobEvent(payload.jobId, { type: "result", result: payload.result });
        const waiter = resultWaiters.get(payload.jobId);
        if (waiter) waiter(payload.result);
        activeJobs.delete(payload.jobId);
        const meta = jobIndex.get(payload.jobId);
        if (meta) {
          meta.status = "done";
          meta.endedAt = Date.now();
        }
        audit.write({
          host: "broker",
          event: "job.result",
          jobId: payload.jobId,
          agentId: agent.id,
          ok: !!(payload.result && payload.result.ok),
        });
        respond(req, res, { payload: { ok: true } });
        return;
      }

      const agentOutputMatch = url.pathname.match(/^\/agent\/([^/]+)\/output$/);
      if (req.method === "POST" && agentOutputMatch) {
        const agent = agents.get(agentOutputMatch[1]);
        const payload = await authorize(req, res, { secret: agent ? agent.token : "", throttle, replayCache });
        if (payload === null) return;

        agent.lastSeenAt = new Date().toISOString();
        if (payload.type === "progress") {
          appendJobEvent(payload.jobId, {
            type: "progress",
            phase: String(payload.phase || "progress"),
            message: String(payload.message || ""),
            current: Number(payload.current || 0),
            total: Number(payload.total || 0),
          });
        } else if (payload.type === "file-chunk") {
          const stream = appendJobEvent(payload.jobId, {
            type: "file-chunk",
            index: Number(payload.index || 0),
            totalBytes: Number(payload.totalBytes || 0),
            dataBase64: String(payload.dataBase64 || ""),
          });
          await drainIfNeeded(stream);
        } else {
          appendJobEvent(payload.jobId, {
            type: "output",
            stream: payload.stream === "stderr" ? "stderr" : "stdout",
            data: String(payload.data || ""),
          });
        }
        respond(req, res, { payload: { ok: true } });
        return;
      }

      const payload = await authorize(req, res, { secret: adminToken, throttle, replayCache });
      if (payload === null) return;

      if (req.method === "POST" && url.pathname === "/diagnostics/callback") {
        const observedAddress = normalizeAddress(req.socket.remoteAddress || "");
        const port = parsePort(payload.port);
        const expectedNodeId = String(payload.expectedNodeId || "").trim();

        if (!observedAddress) {
          respond(req, res, { status: 400, payload: { ok: false, error: "Unable to determine the source address of this request." } });
          return;
        }
        if (!port) {
          respond(req, res, { status: 400, payload: { ok: false, error: "A valid broker port between 1 and 65535 is required." } });
          return;
        }
        if (!expectedNodeId) {
          respond(req, res, { status: 400, payload: { ok: false, error: "expectedNodeId is required." } });
          return;
        }

        const probe = await probeCallback(observedAddress, port, expectedNodeId);
        respond(req, res, {
          payload: {
            ok: true,
            observedAddress,
            scope: callbackScope(observedAddress),
            expectedNodeId,
            testedUrl: probe.testedUrl,
            reachable: probe.reachable,
            latencyMs: probe.latencyMs,
            error: probe.error,
            respondingNodeId: nodeId,
            respondingNodeName: nodeName,
          },
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/agents") {
        respond(req, res, { payload: { ok: true, agents: Array.from(agents.values()).map((agent) => publicAgent(agent)) } });
        return;
      }

      if (req.method === "GET" && url.pathname === "/jobs") {
        const agentFilter = url.searchParams.get("agent");
        const jobs = Array.from(jobIndex.values())
          .filter((meta) => !agentFilter || meta.agentId === agentFilter)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 500);
        respond(req, res, { payload: { ok: true, jobs } });
        return;
      }

      const cancelMatch = url.pathname.match(/^\/agents\/([^/]+)\/jobs\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        const agent = getAgent(cancelMatch[1]);
        const jobId = cancelMatch[2];
        const queuedIndex = agent.jobs.findIndex((job) => job.id === jobId);
        if (queuedIndex !== -1) {
          agent.jobs.splice(queuedIndex, 1);
          jobIndex.delete(jobId);
          activeJobs.delete(jobId);
          audit.write({ host: "broker", event: "job.cancelled", jobId, agentId: agent.id });
          respond(req, res, { payload: { ok: true, cancelled: true, status: "queued", jobId, agentId: agent.id } });
          return;
        }
        if (activeJobs.has(jobId)) {
          respond(req, res, {
            status: 409,
            payload: { ok: false, cancelled: false, status: "running", jobId, agentId: agent.id, error: "The job is already running and cannot be cancelled remotely." },
          });
          return;
        }
        respond(req, res, {
          status: 404,
          payload: { ok: false, cancelled: false, status: "unknown", jobId, agentId: agent.id, error: `Unknown job: ${jobId}` },
        });
        return;
      }

      const runMatch = url.pathname.match(/^\/agents\/([^/]+)\/run$/);
      if (req.method === "POST" && runMatch) {
        const agent = getAgent(runMatch[1]);
        await dispatchJob(req, res, agent, payload, {
          type: payload.type || "command",
          command: payload.command,
          shell: payload.shell,
          cwd: payload.cwd,
          timeoutMs: payload.timeoutMs,
          stream: payload.stream,
        });
        return;
      }

      const jobEventsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
      if (req.method === "GET" && jobEventsMatch) {
        const jobId = jobEventsMatch[1];
        const afterSeq = Number(url.searchParams.get("after") || 0);
        const waitMs = Math.min(Number(url.searchParams.get("waitMs") || 25000), 25000);
        const eventsPayload = await waitForJobEvents(jobId, afterSeq, waitMs);
        respond(req, res, { payload: { ok: true, ...eventsPayload } });
        return;
      }

      const fileReadMatch = url.pathname.match(/^\/agents\/([^/]+)\/file\/read$/);
      if (req.method === "POST" && fileReadMatch) {
        const agent = getAgent(fileReadMatch[1]);
        await dispatchJob(req, res, agent, payload, {
          type: "file.read",
          path: payload.path,
          timeoutMs: payload.timeoutMs,
          stream: payload.stream,
        });
        return;
      }

      const fileWriteMatch = url.pathname.match(/^\/agents\/([^/]+)\/file\/write$/);
      if (req.method === "POST" && fileWriteMatch) {
        const agent = getAgent(fileWriteMatch[1]);
        await dispatchJob(req, res, agent, payload, {
          type: payload.type || "file.write",
          path: payload.path,
          sourcePath: payload.sourcePath,
          targetPath: payload.targetPath,
          contentBase64: payload.contentBase64,
          mkdirp: payload.mkdirp,
          expectedSize: payload.expectedSize,
          sha256: payload.sha256,
          overwrite: payload.overwrite,
          timeoutMs: payload.timeoutMs,
          stream: payload.stream,
        });
        return;
      }

      const disconnectMatch = url.pathname.match(/^\/agents\/([^/]+)\/disconnect$/);
      if (req.method === "POST" && disconnectMatch) {
        const agent = getAgent(disconnectMatch[1]);
        const job = enqueueJob(agent, { type: "agent.exit", timeoutMs: payload.timeoutMs });
        const waitMs = Math.min(Number(payload.waitMs || 30000), 120000);
        const result = await waitForResult(job.id, waitMs);
        agents.delete(agent.id);
        respond(req, res, { payload: { ...result, agentId: agent.id, jobId: job.id } });
        return;
      }

      const updateMatch = url.pathname.match(/^\/agents\/([^/]+)\/update$/);
      if (req.method === "POST" && updateMatch) {
        const agent = getAgent(updateMatch[1]);
        const job = enqueueJob(agent, { type: "agent.update", timeoutMs: payload.timeoutMs });
        const waitMs = Math.min(Number(payload.waitMs || 30000), 120000);
        const result = await waitForResult(job.id, waitMs);
        if (result.ok) agents.delete(agent.id);
        respond(req, res, { payload: { ...result, agentId: agent.id, jobId: job.id } });
        return;
      }

      respond(req, res, { status: 404, payload: { ok: false, error: "Not found." } });
    } catch (error) {
      respond(req, res, { status: error.status || 400, payload: { ok: false, error: error.message } });
    }
  });

  sweepTimer = setInterval(sweepLiveness, 30000);
  if (sweepTimer.unref) sweepTimer.unref();
  server.on("close", () => {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  });

  return server;
}

function broker(options) {
  const host = options.host || process.env.LCR_HOST || "127.0.0.1";
  const port = Number(options.port || process.env.LCR_PORT || DEFAULT_PORT);
  const token = options.token || process.env.LCR_TOKEN;
  const server = createBroker({ token, nodeId: options.nodeId, nodeName: options.nodeName });

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
