const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { defaultUrl } = require("./client");
const { runCommand } = require("./server");

const INSTALLER_URL = "https://github.com/gaston1799/lan-command-runner/releases/latest/download/install.ps1";

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
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteCommandPart(value) {
  const text = String(value);
  if (!text) return '""';
  return /\s|"/.test(text) ? `"${text.replace(/(["\\])/g, "\\$1")}"` : text;
}

function redactCommandParts(command) {
  const parts = Array.isArray(command) ? command.map(String) : [String(command || "")];
  return parts.map((part, index) => {
    const previous = parts[index - 1] || "";
    if (/^--?(token|password|secret|key)$/i.test(previous)) return "<redacted>";
    if (/^--?(token|password|secret|key)=/i.test(part)) return part.replace(/=.*/, "=<redacted>");
    if (/^(authorization:\s*bearer\s+).+/i.test(part)) return part.replace(/^(authorization:\s*bearer\s+).+/i, "$1<redacted>");
    return part;
  });
}

function describeJob(job) {
  if (job.type === "agent.exit") return "agent disconnect";
  if (job.type === "agent.update") return "agent self-update";
  if (job.type === "file.read") return `file read ${quoteCommandPart(job.path || "")}`;
  if (job.type === "file.write") return `file write ${quoteCommandPart(job.path || "")}`;
  const command = redactCommandParts(job.command);
  const prefix = job.shell ? "shell" : "exec";
  return `${prefix} ${command.map(quoteCommandPart).join(" ")}`.trim();
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

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function scheduleWindowsUpdate({ brokerUrl, enrollToken, name, agentId }) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      code: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Agent self-update currently supports Windows agents only.",
    };
  }

  const updateCommand = `
$ErrorActionPreference = 'Stop'
$logPath = Join-Path $env:TEMP 'lcr-agent-update.log'
"[$(Get-Date -Format o)] Starting LCR self-update for ${agentId}" | Add-Content -LiteralPath $logPath
Start-Sleep -Seconds 2
iwr -UseB ${psString(INSTALLER_URL)} | iex
"[$(Get-Date -Format o)] Installer completed" | Add-Content -LiteralPath $logPath
$env:LCR_TOKEN = ${psString(enrollToken)}
$env:LCR_URL = ${psString(brokerUrl)}
$env:LCR_AGENT_ID = ${psString(agentId)}
$env:LCR_AGENT_NAME = ${psString(name)}
& lcr agent --url ${psString(brokerUrl)} --token ${psString(enrollToken)} --name ${psString(name)} --id ${psString(agentId)}
`.trimStart();
  const encodedCommand = Buffer.from(updateCommand, "utf16le").toString("base64");

  const child = spawn("cmd.exe", ["/c", "start", "LCR Agent Update", "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  return {
    ok: true,
    code: 0,
    signal: null,
    timedOut: false,
    stdout: "Agent update scheduled. The current agent will exit, install the latest release, then reconnect with the same id.\n",
    stderr: "",
    exitAgent: true,
  };
}

async function runJob(job, context) {
  if (job.type === "agent.exit") {
    return {
      ok: true,
      code: 0,
      signal: null,
      timedOut: false,
      stdout: "Agent disconnect requested.\n",
      stderr: "",
      exitAgent: true,
    };
  }
  if (job.type === "agent.update") return scheduleWindowsUpdate(context);
  if (String(job.type || "").startsWith("file.")) return runFileJob(job);
  return runCommand(job);
}

async function agent(options) {
  const brokerUrl = options.url || defaultUrl();
  const enrollToken = options.token || process.env.LCR_TOKEN;
  if (!enrollToken) throw new Error("Missing broker token. Pass --token or set LCR_TOKEN.");

  const name = options.name || process.env.LCR_AGENT_NAME || os.hostname();
  let requestedAgentId = options.id || process.env.LCR_AGENT_ID || undefined;
  let agentId;
  let agentToken;

  async function register() {
    const registration = await postJson(new URL("/agent/register", brokerUrl).toString(), enrollToken, {
      id: requestedAgentId,
      name,
      info: {
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        userInfo: os.userInfo().username,
        cwd: process.cwd(),
      },
    });

    agentId = registration.agentId;
    agentToken = registration.agentToken;
    requestedAgentId = agentId;
    console.log(`[lcr] Agent registered: ${agentId} (${name})`);
  }

  function shouldReregister(error) {
    return error.status === 400 || error.status === 401 || /Unknown agent|Unauthorized/i.test(error.message);
  }

  await register();

  while (true) {
    try {
      const poll = await postJson(new URL(`/agent/${encodeURIComponent(agentId)}/poll?timeoutMs=25000`, brokerUrl).toString(), agentToken, {});
      if (!poll.job) continue;

      console.log(`[lcr] Running ${poll.job.id}: ${poll.job.type || "command"}`);
      console.log(`[lcr] Command: ${describeJob(poll.job)}`);
      const result = await runJob(poll.job, { brokerUrl, enrollToken, name, agentId });
      await postJson(new URL(`/agent/${encodeURIComponent(agentId)}/result`, brokerUrl).toString(), agentToken, {
        jobId: poll.job.id,
        result,
      });
      if (result.exitAgent) {
        console.log("[lcr] Disconnect requested; agent exiting.");
        process.exit(0);
      }
    } catch (error) {
      console.error(`[lcr] ${error.message}`);
      if (shouldReregister(error)) {
        await sleep(1000);
        try {
          await register();
        } catch (registrationError) {
          console.error(`[lcr] ${registrationError.message}`);
        }
      }
      await sleep(2000);
    }
  }
}

module.exports = {
  agent,
};
