const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

const { verifyBearer } = require("./auth");

function jsonResponse(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readJson(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        fail(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });

    req.on("error", fail);
  });
}

// Constant-time bearer comparison. Kept as a named export because every server
// surface authenticates through it.
function requireToken(req, token) {
  return verifyBearer(req, token);
}

function clampTimeout(value) {
  const parsed = Number(value || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  clampTimeout,
  jsonResponse,
  readJson,
  requireToken,
};
