const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { defaultUrl } = require("./client");
const { runCommand } = require("./server");
const { redactText } = require("./redact");

const INSTALLER_URL = "https://github.com/gaston1799/lan-command-runner/releases/latest/download/install.ps1";
const DEFAULT_FILE_STREAM_CHUNK_SIZE = 192 * 1024;
const FILE_STREAM_CHUNK_SIZE = (() => {
  const parsed = Number(process.env.LCR_FILE_STREAM_CHUNK_SIZE || DEFAULT_FILE_STREAM_CHUNK_SIZE);
  if (!Number.isFinite(parsed)) return DEFAULT_FILE_STREAM_CHUNK_SIZE;
  return Math.max(64 * 1024, Math.min(1024 * 1024, Math.floor(parsed)));
})();

async function postJson(url, token, payload, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload || {}),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

// Resolves early when `signal` aborts, so a supervised connection can be torn
// down without waiting out a full reconnect backoff.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal) signal.addEventListener("abort", finish, { once: true });
  });
}

function isAbortError(error) {
  return Boolean(error) && (error.name === "AbortError" || error.code === "ABORT_ERR");
}

function quoteCommandPart(value) {
  const text = String(value);
  if (!text) return '""';
  return /\s|"/.test(text) ? `"${text.replace(/(["\\])/g, "\\$1")}"` : text;
}

function redactCommandParts(command) {
  const parts = Array.isArray(command) ? command.map(String) : [String(command || "")];
  return parts.map((part, index) => {
    const previous = parts[index - 1] || "";
    if (/^--?(peer-token|agent-token|enroll-token|broker-token|token|password|secret|key)$/i.test(previous)) return "<redacted>";
    if (/^--?(peer-token|agent-token|enroll-token|broker-token|token|password|secret|key)=/i.test(part)) {
      return part.replace(/=.*/, "=<redacted>");
    }
    if (/^(authorization:\s*bearer\s+).+/i.test(part)) return part.replace(/^(authorization:\s*bearer\s+).+/i, "$1<redacted>");
    return part;
  });
}

function describeJob(job) {
  if (job.type === "agent.exit") return "agent disconnect";
  if (job.type === "agent.update") return "agent self-update";
  if (job.type === "file.read") return `file read ${quoteCommandPart(job.path || "")}`;
  if (job.type === "file.write") return `file write ${quoteCommandPart(job.path || "")}`;
  if (job.type === "file.append") return `file append ${quoteCommandPart(job.path || "")}`;
  if (job.type === "file.commit") {
    return `file commit ${quoteCommandPart(job.sourcePath || "")} -> ${quoteCommandPart(job.targetPath || "")}`;
  }
  const command = redactCommandParts(job.command);
  const prefix = job.shell ? "shell" : "exec";
  return `${prefix} ${command.map(quoteCommandPart).join(" ")}`.trim();
}

async function runFileJob(job, progress = () => {}) {
  const targetPath = String(job.path || "").trim();
  if (job.type !== "file.commit" && !targetPath) {
    return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: "Missing file path." };
  }

  if (job.type === "file.read") {
    try {
      progress("start", `Reading ${targetPath}`);
      const buffer = await fs.readFile(targetPath);
      const stat = await fs.stat(targetPath);
      progress("read", `Read ${buffer.length} byte(s)`, buffer.length, buffer.length);
      progress("encode", "Encoding file payload", buffer.length, buffer.length);
      return {
        ok: true,
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        file: {
          path: targetPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          contentBase64: buffer.toString("base64"),
        },
      };
    } catch (error) {
      return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: error.message };
    }
  }

  if (job.type === "file.write") {
    try {
      progress("start", `Preparing write to ${targetPath}`);
      const buffer = Buffer.from(String(job.contentBase64 || ""), "base64");
      progress("decode", `Decoded ${buffer.length} byte(s)`, buffer.length, buffer.length);
      if (job.mkdirp !== false) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        progress("mkdir", `Ensured directory ${path.dirname(targetPath)}`);
      }
      const tempPath = `${targetPath}.lcr-${process.pid}-${Date.now()}.tmp`;
      progress("write", `Writing temporary file ${tempPath}`, 0, buffer.length);
      await fs.writeFile(tempPath, buffer);
      progress("write", `Wrote ${buffer.length} byte(s)`, buffer.length, buffer.length);
      await fs.rename(tempPath, targetPath);
      progress("rename", `Moved temporary file into place`);
      return {
        ok: true,
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        file: {
          path: targetPath,
          size: buffer.length,
        },
      };
    } catch (error) {
      return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: error.message };
    }
  }

  if (job.type === "file.append") {
    try {
      const buffer = Buffer.from(String(job.contentBase64 || ""), "base64");
      await fs.appendFile(targetPath, buffer);
      const stat = await fs.stat(targetPath);
      return {
        ok: true,
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        file: { path: targetPath, size: stat.size, appended: buffer.length },
      };
    } catch (error) {
      return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: error.message };
    }
  }

  if (job.type === "file.commit") {
    const sourcePath = String(job.sourcePath || "").trim();
    const destinationPath = String(job.targetPath || "").trim();
    if (!sourcePath || !destinationPath) {
      return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: "Source and target paths are required." };
    }

    try {
      const stat = await fs.stat(sourcePath);
      const expectedSize = Number(job.expectedSize);
      if (Number.isFinite(expectedSize) && expectedSize >= 0 && stat.size !== expectedSize) {
        return {
          ok: false,
          code: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: `Remote upload size mismatch: expected ${expectedSize} byte(s), found ${stat.size}.`,
        };
      }

      const hash = crypto.createHash("sha256");
      const stream = fsSync.createReadStream(sourcePath);
      for await (const chunk of stream) hash.update(chunk);
      const actualHash = hash.digest("hex");
      const expectedHash = String(job.sha256 || "").trim().toLowerCase();
      if (expectedHash && actualHash !== expectedHash) {
        return {
          ok: false,
          code: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: `Remote upload checksum mismatch: expected ${expectedHash}, found ${actualHash}.`,
        };
      }

      if (job.mkdirp !== false) await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      if (job.overwrite === false) {
        try {
          await fs.access(destinationPath);
          return {
            ok: false,
            code: 1,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: `Destination already exists: ${destinationPath}`,
          };
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      } else {
        await fs.rm(destinationPath, { force: true });
      }
      await fs.rename(sourcePath, destinationPath);
      return {
        ok: true,
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        file: { path: destinationPath, size: stat.size, sha256: actualHash },
      };
    } catch (error) {
      return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: error.message };
    }
  }

  return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: `Unknown file job type: ${job.type}` };
}

async function streamFileReadJob(job, postChunk, progress = () => {}) {
  const targetPath = String(job.path || "").trim();
  if (!targetPath) {
    return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: "Missing file path." };
  }

  try {
    const stat = await fs.stat(targetPath);
    progress("start", `Reading ${targetPath}`, 0, stat.size);
    const stream = fsSync.createReadStream(targetPath, { highWaterMark: FILE_STREAM_CHUNK_SIZE });
    let index = 0;
    let sent = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await postChunk(index, buffer, stat.size);
      sent += buffer.length;
      index += 1;
      progress("read", `Read ${sent} byte(s)`, sent, stat.size);
    }
    return {
      ok: true,
      code: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      file: {
        path: targetPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        chunkSize: FILE_STREAM_CHUNK_SIZE,
        chunks: index,
      },
    };
  } catch (error) {
    return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: error.message };
  }
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function scheduleWindowsUpdate({ brokerUrl, enrollToken, name, agentId }) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      code: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Agent self-update currently supports Windows agents only.",
    };
  }

  const updateCommand = `
$ErrorActionPreference = 'Stop'
$logPath = Join-Path $env:TEMP 'lcr-agent-update.log'
"[$(Get-Date -Format o)] Starting LCR self-update for ${agentId}" | Add-Content -LiteralPath $logPath
Start-Sleep -Seconds 2
iwr -UseB ${psString(INSTALLER_URL)} | iex
"[$(Get-Date -Format o)] Installer completed" | Add-Content -LiteralPath $logPath
$env:LCR_URL = ${psString(brokerUrl)}
$env:LCR_AGENT_ID = ${psString(agentId)}
$env:LCR_AGENT_NAME = ${psString(name)}
& lcr agent --url ${psString(brokerUrl)} --name ${psString(name)} --id ${psString(agentId)}
`.trimStart();
  const encodedCommand = Buffer.from(updateCommand, "utf16le").toString("base64");

  const child = spawn("cmd.exe", ["/c", "start", "LCR Agent Update", "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, LCR_TOKEN: enrollToken },
  });
  child.unref();

  return {
    ok: true,
    code: 0,
    signal: null,
    timedOut: false,
    stdout: "Agent update scheduled. The current agent will exit, install the latest release, then reconnect with the same id.\n",
    stderr: "",
    exitAgent: true,
  };
}

async function runJob(job, context) {
  if (job.type === "agent.exit") {
    return {
      ok: true,
      code: 0,
      signal: null,
      timedOut: false,
      stdout: "Agent disconnect requested.\n",
      stderr: "",
      exitAgent: true,
    };
  }
  if (job.type === "agent.update") {
    // A mesh node holds several peer connections in one process; letting any
    // one of them respawn the installer would take the whole node down.
    if (context.supervised) {
      return {
        ok: false,
        code: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Agent self-update is disabled for supervised mesh connections. Update this node directly instead.\n",
      };
    }
    return scheduleWindowsUpdate(context);
  }
  if (String(job.type || "").startsWith("file.") && !job.stream) return runFileJob(job);
  if (!job.stream) return runCommand(job);

  const outputPosts = [];
  const postOutput = (stream, data) => {
    outputPosts.push(postJson(new URL(`/agent/${encodeURIComponent(context.agentId)}/output`, context.brokerUrl).toString(), context.agentToken, {
      jobId: job.id,
      stream,
      data,
    }).catch((error) => {
      console.error(`[lcr] output stream failed: ${error.message}`);
    }));
  };
  const postProgress = (phase, message, current = 0, total = 0) => {
    outputPosts.push(postJson(new URL(`/agent/${encodeURIComponent(context.agentId)}/output`, context.brokerUrl).toString(), context.agentToken, {
      jobId: job.id,
      type: "progress",
      phase,
      message,
      current,
      total,
    }).catch((error) => {
      console.error(`[lcr] progress stream failed: ${error.message}`);
    }));
  };
  const postFileChunk = (index, chunk, totalBytes) => postJson(
    new URL(`/agent/${encodeURIComponent(context.agentId)}/output`, context.brokerUrl).toString(),
    context.agentToken,
    {
      jobId: job.id,
      type: "file-chunk",
      index,
      totalBytes,
      dataBase64: chunk.toString("base64"),
    }
  ).catch((error) => {
    console.error(`[lcr] file chunk stream failed: ${error.message}`);
  });
  let result;
  if (job.type === "file.read" && job.stream) {
    result = await streamFileReadJob(job, postFileChunk, postProgress);
  } else if (String(job.type || "").startsWith("file.")) {
    result = await runFileJob(job, postProgress);
  } else {
    result = await runCommand(job, postOutput);
  }
  await Promise.allSettled(outputPosts);
  return { ...result, stdout: "", stderr: "" };
}

// One reconnecting connection to one broker. Supervised connections are used
// by the mesh supervisor: they take their identity explicitly, never call
// process.exit, and can be stopped without disturbing sibling connections.
function createAgentConnection(options = {}) {
  const supervised = Boolean(options.supervised);
  const brokerUrl = options.url || (supervised ? "" : defaultUrl());
  if (!brokerUrl) throw new Error("A supervised agent connection requires an explicit broker url.");

  const enrollToken = options.token || (supervised ? "" : process.env.LCR_TOKEN);
  if (!enrollToken) {
    throw new Error(
      supervised
        ? "A supervised agent connection requires an explicit peer token."
        : "Missing broker token. Pass --token or set LCR_TOKEN."
    );
  }

  let name;
  let requestedAgentId;
  if (supervised) {
    // Never fall back to LCR_AGENT_ID / LCR_AGENT_NAME here: one stale env var
    // would collapse every peer connection onto a single registration.
    name = String(options.name || "").trim();
    requestedAgentId = String(options.id || "").trim();
    if (!name) throw new Error("A supervised agent connection requires an explicit node name.");
    if (!requestedAgentId) throw new Error("A supervised agent connection requires an explicit node id.");
  } else {
    name = options.name || process.env.LCR_AGENT_NAME || os.hostname();
    requestedAgentId = options.id || process.env.LCR_AGENT_ID || undefined;
  }

  const log = options.log || ((message) => console.log(`[lcr] ${message}`));
  const logError = options.logError || ((message) => console.error(`[lcr] ${message}`));
  const abort = new AbortController();
  const signal = abort.signal;

  let agentId;
  let agentToken;
  let registrationLogged = false;
  let stopping = false;

  async function register() {
    const registration = await postJson(
      new URL("/agent/register", brokerUrl).toString(),
      enrollToken,
      {
        id: requestedAgentId,
        name,
        info: {
          platform: process.platform,
          arch: process.arch,
          hostname: os.hostname(),
          userInfo: os.userInfo().username,
          cwd: process.cwd(),
        },
      },
      signal
    );

    agentId = registration.agentId;
    agentToken = registration.agentToken;
    requestedAgentId = agentId;
    log(`Agent registered: ${agentId} (${name})`);
    registrationLogged = false;
  }

  function shouldReregister(error) {
    return error.status === 400 || error.status === 401 || /Unknown agent|Unauthorized/i.test(error.message);
  }

  async function run() {
    while (!stopping && (!agentId || !agentToken)) {
      try {
        await register();
      } catch (error) {
        if (stopping || isAbortError(error)) break;
        if (!registrationLogged) {
          logError(`Waiting for broker at ${brokerUrl}`);
          registrationLogged = true;
        }
        logError(redactText(error.message));
        await sleep(2000, signal);
      }
    }

    if (stopping) return { reason: "stopped" };

    while (!stopping) {
      try {
        const poll = await postJson(
          new URL(`/agent/${encodeURIComponent(agentId)}/poll?timeoutMs=25000`, brokerUrl).toString(),
          agentToken,
          {},
          signal
        );
        if (!poll.job) continue;
        if (stopping) break;

        log(`Running ${poll.job.id}: ${poll.job.type || "command"}`);
        log(`Command: ${describeJob(poll.job)}`);
        const result = await runJob(poll.job, {
          brokerUrl,
          enrollToken,
          name,
          agentId,
          agentToken,
          supervised,
        });
        await postJson(
          new URL(`/agent/${encodeURIComponent(agentId)}/result`, brokerUrl).toString(),
          agentToken,
          { jobId: poll.job.id, result },
          signal
        );
        if (result.exitAgent) return { reason: "exit" };
      } catch (error) {
        if (stopping || isAbortError(error)) break;
        logError(redactText(error.message));
        if (shouldReregister(error)) {
          agentToken = null;
          agentId = requestedAgentId;
          while (!stopping && !agentToken) {
            try {
              await sleep(1000, signal);
              if (stopping) break;
              await register();
            } catch (registrationError) {
              if (stopping || isAbortError(registrationError)) break;
              logError(redactText(registrationError.message));
              await sleep(2000, signal);
            }
          }
        }
        await sleep(2000, signal);
      }
    }

    return { reason: "stopped" };
  }

  const done = run().catch((error) => ({ reason: "error", error }));

  return {
    name,
    url: brokerUrl,
    peerName: options.peerName || "",
    get agentId() {
      return agentId;
    },
    done,
    stop() {
      if (!stopping) {
        stopping = true;
        abort.abort();
      }
      return done;
    },
  };
}

// Legacy entry point: identical observable behavior to before the refactor,
// including exiting the process when the broker asks the agent to disconnect.
async function agent(options) {
  const connection = createAgentConnection(options || {});
  const outcome = await connection.done;
  if (outcome && outcome.reason === "exit") {
    console.log("[lcr] Disconnect requested; agent exiting.");
    process.exit(0);
  }
  if (outcome && outcome.error) throw outcome.error;
}

module.exports = {
  agent,
  createAgentConnection,
};
