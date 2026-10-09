const http = require("node:http");
const os = require("node:os");
const {
  DEFAULT_PORT,
  clampTimeout,
  jsonResponse,
} = require("./protocol");
const { AuthThrottle, generateToken } = require("./auth");
const { ReplayCache, authorize, respond } = require("./guard");
const { hasPublicInterface } = require("./addr");
const { PROTOCOL_VERSION } = require("./compat");
const { listenOnFreePort } = require("./port");
const limits = require("./limits");
const { spawnCommand } = require("./proc");

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

// Bounded, tree-kill-capable execution. The legacy `onOutput(stream, text)`
// callback contract is preserved; the buffered copy is now capped instead of
// growing with the command's output.
function runCommand(payload, onOutput, options = {}) {
  validateRunPayload(payload);

  const timeoutMs = clampTimeout(payload.timeoutMs);
  const cwd = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd();
  const command = payload.shell ? payload.command : payload.command[0];
  const args = payload.shell ? [] : payload.command.slice(1);

  return spawnCommand({
    command,
    args,
    shell: Boolean(payload.shell),
    cwd,
    env: { ...process.env, ...(payload.env && typeof payload.env === "object" ? payload.env : {}) },
    timeoutMs,
    outputLimitBytes:
      options.outputLimitBytes != null ? options.outputLimitBytes : limits.outputLimitBytes(),
    onOutput,
  });
}

function createServer(options) {
  const authMode = options.authMode === "none" ? "none" : "token";
  const token = options.token || "";
  if (!token && authMode !== "none") {
    throw new Error("A token is required. Pass --token or set LCR_TOKEN, or use --trust-lan.");
  }
  const throttle = new AuthThrottle();
  const replayCache = new ReplayCache();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        jsonResponse(res, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          authMode,
          host: os.hostname(),
          lanAddresses: getLanAddresses(),
        });
        return;
      }

      const payload = await authorize(req, res, { secret: token, throttle, replayCache, mode: authMode });
      if (payload === null) return;

      if (req.method === "POST" && url.pathname === "/run") {
        const result = await runCommand(payload);
        respond(req, res, { secret: token, payload: result });
        return;
      }

      respond(req, res, { secret: token, status: 404, payload: { ok: false, error: "Not found." } });
    } catch (error) {
      respond(req, res, { secret: token, status: 400, payload: { ok: false, error: error.message } });
    }
  });
}

async function serve(options) {
  const host = options.host || process.env.LCR_HOST || "127.0.0.1";
  const token = options.token || process.env.LCR_TOKEN;
  const authMode = options.authMode === "none" ? "none" : "token";
  const explicitPort = options.port || process.env.LCR_PORT;

  if (authMode === "none" && hasPublicInterface()) {
    throw new Error(
      "Refusing --trust-lan: this machine has a public (non-private) interface, so a no-auth server would be reachable from the internet. Keep auth on, or connect only through a private LAN/VPN."
    );
  }

  const server = createServer({ token, authMode });

  const announce = (port) => {
    const addresses = host === "0.0.0.0" ? getLanAddresses() : [host];
    console.log(`[lcr] Listening on ${host}:${port}`);
    console.log(`[lcr] Health: ${addresses.map((address) => `http://${address}:${port}/health`).join(" | ")}`);
    console.log(authMode === "none" ? "[lcr] LAN-trust mode: no token required on this private LAN." : "[lcr] Requests require Authorization: Bearer <token>");
  };

  if (explicitPort) {
    const port = Number(explicitPort);
    server.listen(port, host, () => announce(port));
  } else {
    const port = await listenOnFreePort(server, host);
    announce(port);
  }
}

module.exports = {
  createServer,
  generateToken,
  getLanAddresses,
  runCommand,
  serve,
  validateRunPayload,
};
