const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { defaultUrl } = require("./client");
const { runCommand } = require("./server");

async function postJson(url, token, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFileJob(job) {
  const targetPath = String(job.path || "").trim();
  if (!targetPath) {
    return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: "Missing file path." };
  }

  if (job.type === "file.read") {
    try {
      const buffer = await fs.readFile(targetPath);
      const stat = await fs.stat(targetPath);
      return {
        ok: true,
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        file: {
          path: targetPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          contentBase64: buffer.toString("base64"),
        },
      };
    } catch (error) {
      return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: error.message };
    }
  }

  if (job.type === "file.write") {
    try {
      const buffer = Buffer.from(String(job.contentBase64 || ""), "base64");
      if (job.mkdirp !== false) await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const tempPath = `${targetPath}.lcr-${process.pid}-${Date.now()}.tmp`;
      await fs.writeFile(tempPath, buffer);
      await fs.rename(tempPath, targetPath);
      return {
        ok: true,
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        file: {
          path: targetPath,
          size: buffer.length,
        },
      };
    } catch (error) {
      return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: error.message };
    }
  }

  return { ok: false, code: 1, signal: null, timedOut: false, stdout: "", stderr: `Unknown file job type: ${job.type}` };
}

async function runJob(job) {
  if (String(job.type || "").startsWith("file.")) return runFileJob(job);
  return runCommand(job);
}

async function agent(options) {
  const brokerUrl = options.url || defaultUrl();
  const enrollToken = options.token || process.env.LCR_TOKEN;
  if (!enrollToken) throw new Error("Missing broker token. Pass --token or set LCR_TOKEN.");

  const name = options.name || process.env.LCR_AGENT_NAME || os.hostname();
  const registration = await postJson(new URL("/agent/register", brokerUrl).toString(), enrollToken, {
    id: options.id || process.env.LCR_AGENT_ID || undefined,
    name,
    info: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      userInfo: os.userInfo().username,
      cwd: process.cwd(),
    },
  });

  const agentId = registration.agentId;
  const agentToken = registration.agentToken;
  console.log(`[lcr] Agent registered: ${agentId} (${name})`);

  while (true) {
    try {
      const poll = await postJson(new URL(`/agent/${encodeURIComponent(agentId)}/poll?timeoutMs=25000`, brokerUrl).toString(), agentToken, {});
      if (!poll.job) continue;

      console.log(`[lcr] Running ${poll.job.id}: ${poll.job.type || "command"}`);
      const result = await runJob(poll.job);
      await postJson(new URL(`/agent/${encodeURIComponent(agentId)}/result`, brokerUrl).toString(), agentToken, {
        jobId: poll.job.id,
        result,
      });
    } catch (error) {
      console.error(`[lcr] ${error.message}`);
      await sleep(2000);
    }
  }
}

module.exports = {
  agent,
};
