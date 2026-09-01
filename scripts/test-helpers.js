const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");

class AssertionError extends Error {}

function assert(condition, message) {
  if (!condition) throw new AssertionError(message || "Assertion failed.");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionError(`${message || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new AssertionError(`${message || "Assertion failed"}: expected ${b}, got ${a}`);
}

function assertThrows(fn, pattern, message) {
  let threw = null;
  try {
    fn();
  } catch (error) {
    threw = error;
  }
  assert(threw, `${message || "Expected a throw"} but nothing was thrown.`);
  if (pattern) {
    assert(
      pattern.test(threw.message),
      `${message || "Expected a throw"} matching ${pattern}, got: ${threw.message}`
    );
  }
  return threw;
}

async function assertRejects(promise, pattern, message) {
  let threw = null;
  try {
    await promise;
  } catch (error) {
    threw = error;
  }
  assert(threw, `${message || "Expected a rejection"} but the promise resolved.`);
  if (pattern) {
    assert(
      pattern.test(threw.message),
      `${message || "Expected a rejection"} matching ${pattern}, got: ${threw.message}`
    );
  }
  return threw;
}

// Guards the "no token may appear in test output" rule. Secrets are generated
// at runtime, so nothing sensitive is ever committed to this repo.
function assertNoSecrets(text, secrets, message) {
  const haystack = String(text || "");
  for (const secret of secrets) {
    const literal = String(secret || "");
    if (literal.length < 8) continue;
    assert(!haystack.includes(literal), `${message || "Secret leaked into output"} (a stored token appeared verbatim).`);
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lcr-${prefix}-`));
}

function removeTempDir(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    /* best effort; the OS temp dir is reclaimed anyway */
  }
}

async function waitFor(probe, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;
  const intervalMs = options.intervalMs || 150;
  const description = options.description || "condition";
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new AssertionError(`Timed out after ${timeoutMs}ms waiting for ${description}${lastError ? ` (last error: ${lastError.message})` : ""}.`);
}

function spawnNode(args, env = {}) {
  return spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// `timeoutMs` guards against commands that would otherwise block forever
// (streamed `exec` polls the broker indefinitely by design).
function runNode(args, env = {}, options = {}) {
  return new Promise((resolve) => {
    const child = spawnNode(args, env);
    let stdout = "";
    let stderr = "";
    let timer = null;
    let timedOut = false;

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? "timeout" : code, stdout, stderr, timedOut });
    });
  });
}

function killChild(child) {
  if (!child || child.killed || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.kill();
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 4000).unref();
  });
}

function createRunner(suiteName) {
  const failures = [];
  let passed = 0;

  return {
    async test(name, fn) {
      try {
        await fn();
        passed += 1;
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
      }
    },
    finish() {
      if (failures.length) {
        console.error(`${suiteName}: ${failures.length} failure(s)`);
        for (const failure of failures) console.error(`  - ${failure}`);
        process.exitCode = 1;
        return false;
      }
      console.log(`${suiteName} ok (${passed} checks)`);
      return true;
    },
  };
}

module.exports = {
  AssertionError,
  REPO_ROOT,
  assert,
  assertDeepEqual,
  assertEqual,
  assertNoSecrets,
  assertRejects,
  assertThrows,
  createRunner,
  killChild,
  makeTempDir,
  removeTempDir,
  runNode,
  spawnNode,
  waitFor,
};
