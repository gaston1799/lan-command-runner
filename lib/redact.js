const REDACTED = "<redacted>";
const SENSITIVE_KEY_PATTERN = /(token|secret|authorization|password|passwd|credential)/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactLeaf(value) {
  if (value == null) return value;
  if (typeof value === "string") return value ? REDACTED : value;
  if (typeof value === "number") return REDACTED;
  return value;
}

// Recursively copies `value`, replacing anything stored under a key that looks
// secret-bearing. Never mutates the input, and tolerates cycles.
function redactValue(value, options = {}) {
  const pattern = options.pattern || SENSITIVE_KEY_PATTERN;
  const seen = new WeakSet();

  function walk(node, forced) {
    if (Array.isArray(node)) {
      if (seen.has(node)) return "<circular>";
      seen.add(node);
      return node.map((entry) => walk(entry, forced));
    }
    if (isPlainObject(node)) {
      if (seen.has(node)) return "<circular>";
      seen.add(node);
      const output = {};
      for (const [key, child] of Object.entries(node)) {
        const sensitive = forced || pattern.test(key);
        if (sensitive && (isPlainObject(child) || Array.isArray(child))) output[key] = walk(child, true);
        else if (sensitive) output[key] = redactLeaf(child);
        else output[key] = walk(child, false);
      }
      return output;
    }
    return forced ? redactLeaf(node) : node;
  }

  return walk(value, false);
}

// Best-effort scrubbing for free-form text (errors, logs, generated commands).
function redactText(value) {
  return String(value == null ? "" : value)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(
      /(--?(?:peer-token|agent-token|enroll-token|token|password|secret|key)[=\s]+)\S+/gi,
      `$1${REDACTED}`
    )
    .replace(
      /((?:"|')?(?:token|secret|password|authorization|credential)(?:"|')?\s*[:=]\s*(?:"|')?)[^\s"',}\])&]+/gi,
      `$1${REDACTED}`
    );
}

// Removes literal secret values we already know about (e.g. the local broker
// token) from text that may otherwise echo them back.
function redactKnownSecrets(value, secrets = []) {
  let text = String(value == null ? "" : value);
  for (const secret of secrets) {
    const literal = String(secret || "");
    if (literal.length < 8) continue;
    text = text.split(literal).join(REDACTED);
  }
  return text;
}

function sanitizeError(error, options = {}) {
  const raw = error && error.message ? error.message : String(error || "Unknown error.");
  const limit = options.limit || 300;
  const scrubbed = redactKnownSecrets(redactText(raw), options.secrets || []);
  return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}

module.exports = {
  REDACTED,
  SENSITIVE_KEY_PATTERN,
  redactKnownSecrets,
  redactText,
  redactValue,
  sanitizeError,
};
