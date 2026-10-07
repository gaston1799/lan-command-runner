// Append-only JSONL audit log with size-based rotation.
//
// One line per significant event (job queued/started/finished/cancelled, agent
// register/disconnect/prune). Command arguments are redacted before they touch
// the file. Writes are low-frequency and per-process, so appendFileSync is fine.

const fs = require("node:fs");
const path = require("node:path");
const { defaultConfigPath } = require("./config");

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const AUDIT_BASENAME = "audit.log";

function defaultAuditDir() {
  if (process.env.LCR_AUDIT_DIR) return process.env.LCR_AUDIT_DIR;
  return path.join(path.dirname(defaultConfigPath()), "logs");
}

function noopLogger() {
  return {
    write() {},
    dir: "",
    currentFile: "",
    tail() {
      return [];
    },
  };
}

function createAuditLogger(options = {}) {
  if (process.env.LCR_AUDIT_DISABLED === "1") return noopLogger();

  const dir = options.dir || defaultAuditDir();
  const maxBytes =
    Number.isFinite(Number(options.maxBytes)) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;

  let currentFile = "";
  let currentSize = 0;

  function ensureDir() {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best effort; write() will surface the error if it matters */
    }
  }

  function init() {
    ensureDir();
    currentFile = path.join(dir, AUDIT_BASENAME);
    try {
      currentSize = fs.existsSync(currentFile) ? fs.statSync(currentFile).size : 0;
    } catch {
      currentSize = 0;
    }
  }

  function rotate() {
    if (!currentFile) return init();
    const archive = path.join(dir, `audit-${Date.now()}.log`);
    try {
      fs.renameSync(currentFile, archive);
    } catch {
      /* could not rotate (e.g. first write, no file yet); continue */
    }
    currentFile = path.join(dir, AUDIT_BASENAME);
    currentSize = 0;
  }

  function write(record) {
    try {
      const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
      if (!currentFile) init();
      if (currentSize + line.length > maxBytes) rotate();
      fs.appendFileSync(currentFile, line, { encoding: "utf8" });
      currentSize += line.length;
      return true;
    } catch (error) {
      // Auditing must never take the broker or agent down.
      if (process.env.LCR_DEBUG === "1") console.error(`[lcr] audit write failed: ${error.message}`);
      return false;
    }
  }

  function tail(count = 50) {
    return readTail(dir, count);
  }

  return { write, dir, get currentFile() { return currentFile; }, tail };
}

function readTail(dir, count = 50) {
  try {
    const file = path.join(dir, AUDIT_BASENAME);
    if (!fs.existsSync(file)) return [];
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim());
    return lines.slice(-Math.max(1, Number(count) || 50)).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

module.exports = {
  AUDIT_BASENAME,
  DEFAULT_MAX_BYTES,
  createAuditLogger,
  defaultAuditDir,
  noopLogger,
  readAuditTail: readTail,
};
