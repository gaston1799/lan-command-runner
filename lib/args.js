// Flags that never take a value. Without this set, `--allow-public-http tower`
// silently swallows the peer name AND sets the safety gate to a truthy string.
const BOOLEAN_FLAGS = new Set([
  "allow-public-http",
  "attach",
  "debug",
  "discover",
  // Without this, `startup install --dry-run` would consume the next token and
  // a bare `--dry-run` at the end of the line would still be truthy — but
  // `--dry-run=false` would silently register a real task.
  "dry-run",
  "enabled",
  "force",
  "help",
  "json",
  "no-stream",
  "reveal",
  "stdin",
  "trust-lan",
]);

// Flags where an accidental bare `--token` would otherwise become the literal
// value `true` and be sent on the wire (e.g. `Authorization: Bearer true`).
const VALUE_FLAGS = new Set([
  "agent-id",
  "agent-name",
  "callback-peer",
  "host",
  "id",
  "name",
  "node-id",
  "peer",
  "port",
  "token",
  "url",
]);

function parseBooleanValue(key, raw) {
  const text = String(raw).trim().toLowerCase();
  if (text === "" || text === "true") return true;
  if (text === "false") return false;
  throw new Error(`--${key} is a boolean flag. Use --${key} or --${key}=false, not --${key}=${raw}.`);
}

function parseArgs(argv) {
  const options = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--") {
      options._.push(...argv.slice(index + 1));
      break;
    }

    if (!value.startsWith("--")) {
      options._.push(value);
      continue;
    }

    const eq = value.indexOf("=");
    if (eq !== -1) {
      const key = value.slice(2, eq);
      const raw = value.slice(eq + 1);
      options[key] = BOOLEAN_FLAGS.has(key) ? parseBooleanValue(key, raw) : raw;
      continue;
    }

    const key = value.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      options[key] = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      if (VALUE_FLAGS.has(key)) throw new Error(`Missing value for --${key}.`);
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return options;
}

function numberOption(value, fallback) {
  if (value == null || value === true) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanOption(value, fallback = false) {
  if (value == null) return fallback;
  return value === true;
}

module.exports = {
  BOOLEAN_FLAGS,
  VALUE_FLAGS,
  booleanOption,
  numberOption,
  parseArgs,
};
