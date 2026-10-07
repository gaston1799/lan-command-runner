const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAuditLogger, readAuditTail } = require("../lib/audit");
const { createBroker } = require("../lib/broker");
const { generateToken } = require("../lib/auth");

process.env.LCR_ALLOW_UNSIGNED = "1";

test("audit logger appends JSONL records and tails them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcr-audit-"));
  try {
    const logger = createAuditLogger({ dir });
    assert.equal(logger.write({ host: "broker", event: "job.queued", jobId: "j1" }), true);
    assert.equal(logger.write({ host: "agent", event: "job.done", jobId: "j1", ok: true }), true);

    const lines = readAuditTail(dir, 10);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, "job.queued");
    assert.equal(lines[1].host, "agent");
    assert.ok(lines[1].ts, "every record carries a timestamp");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("audit rotation keeps the current file bounded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcr-audit-"));
  try {
    const logger = createAuditLogger({ dir, maxBytes: 256 });
    for (let i = 0; i < 12; i += 1) {
      logger.write({ host: "broker", event: "job.queued", jobId: `j${i}`, pad: "x".repeat(60) });
    }
    const current = path.join(dir, "audit.log");
    assert.ok(fs.existsSync(current), "current audit.log exists");
    assert.ok(fs.statSync(current).size <= 256 + 128, "current file stays near the cap");
    const archives = fs.readdirSync(dir).filter((name) => name.startsWith("audit-"));
    assert.ok(archives.length >= 1, "at least one rotated archive exists");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditing can be disabled and degraded writes never throw", () => {
  process.env.LCR_AUDIT_DISABLED = "1";
  try {
    const logger = createAuditLogger();
    assert.equal(logger.write({ event: "x" }), undefined);
    assert.deepEqual(logger.tail(), []);
  } finally {
    delete process.env.LCR_AUDIT_DISABLED;
  }
});

test("the broker writes audit events on register, queue, result, and cancel", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcr-audit-"));
  const token = generateToken();
  const server = createBroker({ token, audit: createAuditLogger({ dir }) });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const register = await fetch(`http://127.0.0.1:${port}/agent/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "audit-agent" }),
    });
    const { agentId } = await register.json();

    const run = await fetch(`http://127.0.0.1:${port}/agents/${agentId}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ command: ["node", "-v"], stream: true }),
    });
    const { jobId } = await run.json();

    const events = readAuditTail(dir, 50).map((e) => e.event);
    assert.ok(events.includes("agent.register"), "register is audited");
    assert.ok(events.includes("job.queued"), "queue is audited");
  } finally {
    await new Promise((resolve) => {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      server.close(resolve);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
