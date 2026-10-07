// Credentials and authentication throttling.
//
// Two problems this closes:
//   1. Agent credentials were 32 bits (`randomBytes(4)` hex) and compared with
//      `===`, which is both guessable and timing-sensitive.
//   2. Nothing limited repeated failures, so an on-LAN attacker could grind
//      against the token space forever.

const crypto = require("node:crypto");
const limits = require("./limits");

const ADMIN_TOKEN_BYTES = 24; // 192 bits
const AGENT_TOKEN_BYTES = 16; // 128 bits
const NODE_ID_BYTES = 8; // 64 bits, readable hex, not a secret

function generateSecret(bytes = ADMIN_TOKEN_BYTES) {
  const size = Number.isFinite(Number(bytes)) && Number(bytes) >= 16 ? Math.floor(Number(bytes)) : AGENT_TOKEN_BYTES;
  return crypto.randomBytes(size).toString("base64url");
}

function generateToken() {
  return generateSecret(ADMIN_TOKEN_BYTES);
}

function generateAgentToken() {
  return generateSecret(AGENT_TOKEN_BYTES);
}

// Readable, collision-resistant identifier (not a credential).
function generateNodeId(prefix) {
  return `${prefix}-${crypto.randomBytes(NODE_ID_BYTES).toString("hex")}`;
}

// Constant-time comparison that tolerates unequal lengths and empty inputs.
// `timingSafeEqual` throws on length mismatch, so the length check must come
// first — and it must not leak *which* side was wrong.
function tokensEqual(left, right) {
  const a = Buffer.from(String(left == null ? "" : left), "utf8");
  const b = Buffer.from(String(right == null ? "" : right), "utf8");
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req && req.headers ? req.headers.authorization : "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header || "").trim());
  return match ? match[1] : "";
}

function verifyBearer(req, expected) {
  if (!expected) return false;
  return tokensEqual(bearerToken(req), expected);
}

// Per-source-address failure tracker with a sliding window and a short lockout.
class AuthThrottle {
  constructor(options = {}) {
    this.limit = positive(options.limit, limits.authFailureLimit());
    this.windowMs = positive(options.windowMs, limits.authFailureWindowMs());
    this.lockoutMs = positive(options.lockoutMs, limits.authLockoutMs());
    this.maxEntries = positive(options.maxEntries, 4096);
    this.entries = new Map();
  }

  static key(address) {
    return String(address == null ? "" : address)
      .replace(/^::ffff:/i, "")
      .trim() || "unknown";
  }

  // Milliseconds remaining in an active lockout, or 0.
  lockedForMs(address, now = Date.now()) {
    const entry = this.entries.get(AuthThrottle.key(address));
    if (!entry || !entry.lockedUntil) return 0;
    return entry.lockedUntil > now ? entry.lockedUntil - now : 0;
  }

  recordFailure(address, now = Date.now()) {
    const key = AuthThrottle.key(address);
    const entry = this.entries.get(key) || { failures: [], lockedUntil: 0 };
    if (entry.lockedUntil > now) {
      this.entries.set(key, entry);
      return { locked: true, retryAfterMs: entry.lockedUntil - now };
    }
    entry.failures = entry.failures.filter((at) => now - at < this.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.limit) {
      entry.failures = [];
      entry.lockedUntil = now + this.lockoutMs;
      this.entries.set(key, entry);
      return { locked: true, retryAfterMs: this.lockoutMs };
    }
    this.entries.set(key, entry);
    this.sweep(now);
    return { locked: false, retryAfterMs: 0 };
  }

  recordSuccess(address) {
    this.entries.delete(AuthThrottle.key(address));
  }

  sweep(now = Date.now()) {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      const idle = now - (entry.failures[entry.failures.length - 1] || entry.lockedUntil || 0);
      if (entry.lockedUntil <= now && idle > this.windowMs) this.entries.delete(key);
      if (this.entries.size <= this.maxEntries) return;
    }
  }

  get size() {
    return this.entries.size;
  }
}

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

module.exports = {
  ADMIN_TOKEN_BYTES,
  AGENT_TOKEN_BYTES,
  AuthThrottle,
  bearerToken,
  generateAgentToken,
  generateNodeId,
  generateSecret,
  generateToken,
  tokensEqual,
  verifyBearer,
};
