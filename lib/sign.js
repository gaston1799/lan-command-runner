// Application-layer request/response signing (HMAC-SHA256) with replay
// protection. Zero runtime dependencies: this is `node:crypto` only.
//
// A request is signed over:
//     method\npath\sha256(rawBody)\ntimestamp\nnonce
// A response is signed over:
//     resp\nmethod\npath\nrequestNonce\nsha256(body)\ntimestamp
//
// The secret is the existing shared token, so a valid signature *is* proof of
// possession of that token. The bearer header remains as a cheap first check;
// the signature is what makes a request tamper-evident and replay-proof.

const crypto = require("node:crypto");
const limits = require("./limits");

const HEADER_SIG = "x-lcr-sig";
const HEADER_TS = "x-lcr-ts";
const HEADER_NONCE = "x-lcr-nonce";
const HEADER_RSIG = "x-lcr-rsig";
const HEADER_RTS = "x-lcr-rts";

function sha256(input) {
  return crypto.createHash("sha256").update(input == null ? "" : input).digest("hex");
}

function hmac(secret, message) {
  return crypto.createHmac("sha256", secret).update(message).digest("base64url");
}

function constantEqual(left, right) {
  const a = Buffer.from(String(left == null ? "" : left));
  const b = Buffer.from(String(right == null ? "" : right));
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizePath(path) {
  const text = String(path == null ? "" : path);
  return text || "/";
}

function asBuffer(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(String(body), "utf8");
}

function requestCanonical({ method, path, rawBody, timestamp, nonce }) {
  return [
    String(method || "GET").toUpperCase(),
    normalizePath(path),
    sha256(asBuffer(rawBody)),
    String(timestamp),
    String(nonce),
  ].join("\n");
}

function responseCanonical({ method, path, nonce, body, timestamp }) {
  return [
    "resp",
    String(method || "GET").toUpperCase(),
    normalizePath(path),
    String(nonce),
    sha256(asBuffer(body)),
    String(timestamp),
  ].join("\n");
}

function buildRequestHeaders({ secret, method, path, body, nonce, timestamp }) {
  const ts = String(timestamp || Date.now());
  const n = nonce || crypto.randomBytes(16).toString("hex");
  return {
    [HEADER_TS]: ts,
    [HEADER_NONCE]: n,
    [HEADER_SIG]: hmac(secret, requestCanonical({ method, path, rawBody: body, timestamp: ts, nonce: n })),
  };
}

function buildResponseHeaders({ secret, method, path, nonce, body, timestamp }) {
  const ts = String(timestamp || Date.now());
  return {
    [HEADER_RTS]: ts,
    [HEADER_RSIG]: hmac(
      secret,
      responseCanonical({ method, path, nonce, body, timestamp: ts })
    ),
  };
}

// Reads a header from either a fetch Headers object or a plain object.
function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value == null ? undefined : value;
  }
  const value = headers[name] ?? headers[name.toLowerCase()];
  return value == null ? undefined : value;
}

// Reads signature headers from a Headers-like object (http.IncomingMessage or
// fetch Headers). Returns { timestamp, nonce, signature } or null.
function readSignatureHeaders(reqOrHeaders) {
  const headers =
    reqOrHeaders && reqOrHeaders.headers && typeof reqOrHeaders.headers === "object"
      ? reqOrHeaders.headers
      : reqOrHeaders || {};
  const timestamp = headerValue(headers, HEADER_TS);
  const nonce = headerValue(headers, HEADER_NONCE);
  const signature = headerValue(headers, HEADER_SIG);
  if (timestamp == null || nonce == null || signature == null) return null;
  return { timestamp: String(timestamp), nonce: String(nonce), signature: String(signature) };
}

// Bounded nonce cache: remembers (secret, nonce) pairs long enough to reject a
// replay, then forgets them. One instance is shared across a server.
class ReplayCache {
  constructor(ttlMs = limits.signNonceTtlMs(), maxEntries = 16384) {
    this.ttlMs = Number.isFinite(Number(ttlMs)) ? Math.max(1000, Number(ttlMs)) : limits.signNonceTtlMs();
    this.maxEntries = Number.isFinite(Number(maxEntries)) ? Math.max(100, Number(maxEntries)) : 16384;
    this.seen = new Map();
  }

  has(secret, nonce, now = Date.now()) {
    const bucket = this.seen.get(String(secret));
    if (!bucket) return false;
    return bucket.has(String(nonce));
  }

  remember(secret, nonce, now = Date.now()) {
    const key = String(secret);
    let bucket = this.seen.get(key);
    if (!bucket) {
      bucket = new Map();
      this.seen.set(key, bucket);
    }
    bucket.set(String(nonce), now + this.ttlMs);
    this.prune(now);
  }

  prune(now = Date.now()) {
    let total = 0;
    for (const bucket of this.seen.values()) total += bucket.size;
    if (total <= this.maxEntries) return;
    for (const [key, bucket] of this.seen) {
      for (const [nonce, expires] of bucket) {
        if (expires <= now) bucket.delete(nonce);
      }
      if (bucket.size === 0) this.seen.delete(key);
      total = 0;
      for (const b of this.seen.values()) total += b.size;
      if (total <= this.maxEntries) return;
    }
  }

  get size() {
    let total = 0;
    for (const bucket of this.seen.values()) total += bucket.size;
    return total;
  }
}

function verifyRequest({ secret, method, path, rawBody, headers, now = Date.now(), replayCache }) {
  const parsed = readSignatureHeaders(headers);
  if (!parsed) return { ok: false, reason: "Missing request signature." };

  const timestamp = Number(parsed.timestamp);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "Invalid request timestamp." };
  const skew = Math.abs(now - timestamp);
  if (skew > limits.signSkewMs()) {
    return { ok: false, reason: "Request timestamp is outside the allowed window." };
  }

  const canonical = requestCanonical({
    method,
    path,
    rawBody: asBuffer(rawBody),
    timestamp: parsed.timestamp,
    nonce: parsed.nonce,
  });
  if (!constantEqual(hmac(secret, canonical), parsed.signature)) {
    return { ok: false, reason: "Invalid request signature." };
  }

  if (replayCache) {
    if (replayCache.has(secret, parsed.nonce, now)) {
      return { ok: false, reason: "Replayed request nonce." };
    }
    replayCache.remember(secret, parsed.nonce, now);
  }

  return { ok: true, nonce: parsed.nonce, timestamp };
}

function verifyResponse({ secret, method, path, nonce, body, headers, now = Date.now() }) {
  const timestamp = headerValue(headers, HEADER_RTS);
  const signature = headerValue(headers, HEADER_RSIG);
  if (timestamp == null || signature == null) return { ok: false, reason: "Missing response signature." };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "Invalid response timestamp." };
  if (Math.abs(now - ts) > limits.signSkewMs()) {
    return { ok: false, reason: "Response timestamp is outside the allowed window." };
  }

  const canonical = responseCanonical({ method, path, nonce, body, timestamp: String(ts) });
  if (!constantEqual(hmac(secret, canonical), String(signature))) {
    return { ok: false, reason: "Invalid response signature." };
  }
  return { ok: true };
}

function requireSignature() {
  return process.env.LCR_ALLOW_UNSIGNED !== "1";
}

module.exports = {
  HEADER_NONCE,
  HEADER_RSIG,
  HEADER_RTS,
  HEADER_SIG,
  HEADER_TS,
  ReplayCache,
  buildRequestHeaders,
  buildResponseHeaders,
  headerValue,
  hmac,
  readSignatureHeaders,
  requireSignature,
  sha256,
  verifyRequest,
  verifyResponse,
};
