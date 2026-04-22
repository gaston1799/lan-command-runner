const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readJson(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });

    req.on("error", reject);
  });
}

function requireToken(req, token) {
  if (!token) return false;
  const header = req.headers.authorization || "";
  return header === `Bearer ${token}`;
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
