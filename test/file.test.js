const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { createBroker } = require("../lib/broker");
const { createAgentConnection } = require("../lib/agent");
const { generateToken } = require("../lib/auth");

process.env.LCR_ALLOW_UNSIGNED = "1";
process.env.LCR_AUDIT_DISABLED = "1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(resolve);
  });
}

test("a streamed file.read assembles byte-for-byte with a verifiable sha256", async () => {
  const token = generateToken();
  const broker = createBroker({ token });
  const port = await listen(broker);

  const remoteFile = path.join(os.tmpdir(), `lcr-file-${process.pid}.bin`);
  const data = crypto.randomBytes(12 * 1024 * 1024);
  fs.writeFileSync(remoteFile, data);

  const connection = createAgentConnection({
    url: `http://127.0.0.1:${port}`,
    token,
    name: "file-agent",
    id: "file-agent-id",
  });

  try {
    let agentId;
    for (let i = 0; i < 100 && !agentId; i += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/agents`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const payload = await response.json();
      if (payload.agents.length) agentId = payload.agents[0].id;
      else await sleep(50);
    }
    assert.ok(agentId, "the agent registered");

    const start = await fetch(`http://127.0.0.1:${port}/agents/${agentId}/file/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: remoteFile, stream: true }),
    });
    const started = await start.json();
    assert.equal(started.stream, true, "the broker opened a stream");

    let after = 0;
    let finalResult = null;
    const chunks = [];
    for (let i = 0; i < 400 && !finalResult; i += 1) {
      const response = await fetch(
        `http://127.0.0.1:${port}/jobs/${started.jobId}/events?after=${after}&waitMs=5000`,
        { headers: { authorization: `Bearer ${token}` } }
      );
      const payload = await response.json();
      for (const event of payload.events || []) {
        after = Math.max(after, Number(event.seq || 0));
        if (event.type === "file-chunk") chunks.push(Buffer.from(event.dataBase64, "base64"));
        if (event.type === "result") finalResult = event.result;
      }
    }

    assert.ok(finalResult, "the job reached a result");
    assert.equal(finalResult.ok, true);
    const assembled = Buffer.concat(chunks);
    assert.equal(assembled.length, data.length, "all bytes arrived");
    assert.ok(assembled.equals(data), "bytes are identical");
    const digest = crypto.createHash("sha256").update(assembled).digest("hex");
    assert.equal(digest, finalResult.file.sha256, "the source hash matches the assembled bytes");
  } finally {
    connection.stop();
    fs.rmSync(remoteFile, { force: true });
    await close(broker);
  }
});
