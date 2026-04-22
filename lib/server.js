const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const { spawn } = require("node:child_process");
const {
  DEFAULT_PORT,
  clampTimeout,
  jsonResponse,
  readJson,
  requireToken,
} = require("./protocol");

function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
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

function validateRunPayload(payload) {
  if (payload.shell) {
    if (typeof payload.command !== "string" || !payload.command.trim()) {
      throw new Error("Shell mode requires a non-empty string command.");
    }
    return;
  }

  if (!Array.isArray(payload.command) || !payload.command.length) {
    throw new Error("Command must be a non-empty argument array unless shell=true.");
  }
  if (payload.command.some((part) => typeof part !== "string" || !part.length)) {
    throw new Error("Command arguments must be non-empty strings.");
  }
}

function runCommand(payload, onOutput) {
  validateRunPayload(payload);

  const timeoutMs = clampTimeout(payload.timeoutMs);
  const startedAt = new Date().toISOString();
  const cwd = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd();
  const command = payload.shell ? payload.command : payload.command[0];
  const args = payload.shell ? [] : payload.command.slice(1);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(payload.env && typeof payload.env === "object" ? payload.env : {}) },
    shell: Boolean(payload.shell),
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 1500).unref();
  }, timeoutMs);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    if (onOutput) onOutput("stdout", text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    if (onOutput) onOutput("stderr", text);
  });

  return new Promise((resolve) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        signal: null,
        timedOut,
        startedAt,
        endedAt: new Date().toISOString(),
        cwd,
        stdout,
        stderr: stderr + error.message,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        startedAt,
        endedAt: new Date().toISOString(),
        cwd,
        stdout,
        stderr,
      });
    });
  });
}

function createServer(options) {
  const token = options.token;
  if (!token) throw new Error("A token is required. Pass --token or set LCR_TOKEN.");

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        jsonResponse(res, 200, {
          ok: true,
          host: os.hostname(),
          lanAddresses: getLanAddresses(),
        });
        return;
      }

      if (!requireToken(req, token)) {
        jsonResponse(res, 401, { ok: false, error: "Unauthorized." });
        return;
      }

      if (req.method === "POST" && url.pathname === "/run") {
        const payload = await readJson(req);
        const result = await runCommand(payload);
        jsonResponse(res, 200, result);
        return;
      }

      jsonResponse(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error.message });
    }
  });
}

function serve(options) {
  const host = options.host || process.env.LCR_HOST || "127.0.0.1";
  const port = Number(options.port || process.env.LCR_PORT || DEFAULT_PORT);
  const token = options.token || process.env.LCR_TOKEN;
  const server = createServer({ token });

  server.listen(port, host, () => {
    const addresses = host === "0.0.0.0" ? getLanAddresses() : [host];
    console.log(`[lcr] Listening on ${host}:${port}`);
    console.log(`[lcr] Health: ${addresses.map((address) => `http://${address}:${port}/health`).join(" | ")}`);
    console.log("[lcr] Requests require Authorization: Bearer <token>");
  });
}

module.exports = {
  createServer,
  generateToken,
  getLanAddresses,
  runCommand,
  serve,
};
