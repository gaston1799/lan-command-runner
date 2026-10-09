// Shared request guard for the HTTP surfaces (direct server + broker).
//
// Combines, in order: bearer credential check, auth-failure throttling, and
// (when enabled) HMAC request-signature verification — then returns the parsed
// JSON body. Responses are signed back so a client can reject a substituted
// response.

const { verifyBearer } = require("./auth");
const { jsonResponse } = require("./protocol");
const { ReplayCache, buildResponseHeaders, readSignatureHeaders, requireSignature, verifyRequest } = require("./sign");
const { parsePeerVersion, peerSupportsSigning } = require("./compat");
const limits = require("./limits");

// Reads the request body once and caches it on the request, so a route that
// also calls readJson() does not consume a stream that has already ended.
function readBody(req, limitBytes = limits.maxRequestBodyBytes()) {
  if (req.__lcrBody !== undefined) return Promise.resolve(req.__lcrBody);
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
      const raw = Buffer.concat(chunks);
      req.__lcrBody = raw;
      resolve(raw);
    });
    req.on("error", fail);
  });
}

function parseBody(raw) {
  if (!raw || raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString("utf8").trim());
    return value && typeof value === "object" ? value : {};
  } catch {
    return null;
  }
}

// 401 with a sliding-window lockout that becomes 429 after too many failures.
function deny(req, res, throttle) {
  const address = req.socket.remoteAddress;
  const remaining = throttle ? throttle.lockedForMs(address) : 0;
  const locked = (retryAfterMs) =>
    jsonResponse(
      res,
      429,
      { ok: false, error: "Too many failed authentication attempts. Try again later." },
      { "retry-after": String(Math.ceil(retryAfterMs / 1000)) }
    );
  if (remaining > 0) {
    locked(remaining);
    return;
  }
  if (throttle) {
    const outcome = throttle.recordFailure(address);
    if (outcome.locked) {
      locked(outcome.retryAfterMs);
      return;
    }
  }
  jsonResponse(res, 401, { ok: false, error: "Unauthorized." });
}

// Parses and validates a JSON body, writing a 400 and returning null on failure.
function parseBodyChecked(raw, res) {
  const body = parseBody(raw);
  if (body === null) {
    jsonResponse(res, 400, { ok: false, error: "Invalid JSON body." });
    return null;
  }
  return body;
}

// Verifies a request. Returns the parsed JSON body on success, or null after
// writing an error response.
//
// `mode` is "token" (default) or "none". In "none" (LAN-trust) the bearer and
// signature checks are skipped entirely. In "token" mode, pre-signing peers
// (0.14, no version header) are grandfathered to bearer-only; peers that
// advertise signing support must sign.
async function authorize(req, res, { secret, throttle, replayCache, mode = "token" }) {
  if (mode === "none") {
    const raw = await readBody(req);
    req.__lcrSecret = secret || "";
    req.__lcrNonce = "";
    return parseBodyChecked(raw, res);
  }

  if (!verifyBearer(req, secret)) {
    deny(req, res, throttle);
    return null;
  }
  if (throttle) throttle.recordSuccess(req.socket.remoteAddress);

  const raw = await readBody(req);
  req.__lcrSecret = secret;

  if (!requireSignature()) {
    req.__lcrNonce = "";
    return parseBodyChecked(raw, res);
  }

  const signatureHeaders = readSignatureHeaders(req);
  if (signatureHeaders) {
    const result = verifyRequest({
      secret,
      method: req.method,
      path: req.url,
      rawBody: raw,
      headers: req.headers,
      now: Date.now(),
      replayCache,
    });
    if (!result.ok) {
      jsonResponse(res, 401, { ok: false, error: result.reason });
      return null;
    }
    req.__lcrNonce = result.nonce;
    return parseBodyChecked(raw, res);
  }

  // No signature present. Grandfather pre-signing peers; reject modern peers
  // that should have signed.
  const peerVersion = parsePeerVersion(req);
  if (peerSupportsSigning(peerVersion)) {
    jsonResponse(res, 401, { ok: false, error: "Missing request signature." });
    return null;
  }
  req.__lcrNonce = "";
  return parseBodyChecked(raw, res);
}

// Writes a JSON response, signing it back to the request when signing is on.
function respond(req, res, { secret, status = 200, payload, headers = {} }) {
  const body = JSON.stringify(payload, null, 2);
  let extra = { ...headers };
  if (requireSignature() && req.__lcrNonce) {
    extra = {
      ...extra,
      ...buildResponseHeaders({
        secret: secret || req.__lcrSecret,
        method: req.method,
        path: req.url,
        nonce: req.__lcrNonce,
        body,
      }),
    };
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(body);
}

module.exports = {
  ReplayCache,
  authorize,
  deny,
  parseBody,
  readBody,
  respond,
};
