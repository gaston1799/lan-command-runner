const { spawn } = require("node:child_process");
const { generateToken } = require("../lib/server");

const token = generateToken();
const port = 18766;
const env = { ...process.env, LCR_TOKEN: token, LCR_URL: `http://127.0.0.1:${port}` };

function spawnNode(args) {
  return spawn(process.execPath, args, {
    cwd: __dirname + "/..",
    env,
    windowsHide: true,
  });
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawnNode(args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Broker did not become healthy.");
}

async function waitForAgent() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      const payload = await response.json();
      if (payload.agents.length) return payload.agents[0].id;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Agent did not register.");
}

async function main() {
  let broker = spawnNode(["bin/lcr.js", "broker", "--port", String(port), "--token", token]);
  let agent;

  try {
    await waitForHealth();
    agent = spawnNode(["bin/lcr.js", "agent", "--url", `http://127.0.0.1:${port}`, "--token", token, "--id", "local"]);
    const agentId = await waitForAgent();
    const result = await runNode(["bin/lcr.js", "exec", agentId, "--url", `http://127.0.0.1:${port}`, "--token", token, "--", process.execPath, "--version"]);
    if (result.code !== 0) throw new Error(result.stderr || `lcr exec exited ${result.code}`);
    if (!/^v\d+\./.test(result.stdout.trim())) throw new Error(`Unexpected stdout: ${result.stdout}`);

    if (process.platform === "win32") {
      const pwsh = await runNode(["bin/lcr.js", "pwsh", agentId, "--url", `http://127.0.0.1:${port}`, "--token", token, '"pwsh-ok"']);
      if (pwsh.code !== 0) throw new Error(pwsh.stderr || `lcr pwsh exited ${pwsh.code}`);
      if (pwsh.stdout.trim() !== "pwsh-ok") throw new Error(`Unexpected pwsh stdout: ${pwsh.stdout}`);
    }

    broker.kill();
    await new Promise((resolve) => broker.once("close", resolve));
    broker = spawnNode(["bin/lcr.js", "broker", "--port", String(port), "--token", token]);
    await waitForHealth();
    const reregisteredAgentId = await waitForAgent();
    if (reregisteredAgentId !== agentId) throw new Error(`Agent re-registered as ${reregisteredAgentId}, expected ${agentId}`);

    const remotePath = process.platform === "win32" ? `${process.env.TEMP}\\lcr-broker-smoke.txt` : "/tmp/lcr-broker-smoke.txt";
    const write = await runNode(["bin/lcr.js", "write", agentId, remotePath, "--url", `http://127.0.0.1:${port}`, "--token", token, "hello-file"]);
    if (write.code !== 0) throw new Error(write.stderr || `lcr write exited ${write.code}`);

    const cat = await runNode(["bin/lcr.js", "cat", agentId, remotePath, "--url", `http://127.0.0.1:${port}`, "--token", token]);
    if (cat.code !== 0) throw new Error(cat.stderr || `lcr cat exited ${cat.code}`);
    if (cat.stdout !== "hello-file") throw new Error(`Unexpected cat stdout: ${cat.stdout}`);

    const disconnect = await runNode(["bin/lcr.js", "disconnect", agentId, "--url", `http://127.0.0.1:${port}`, "--token", token]);
    if (disconnect.code !== 0) throw new Error(disconnect.stderr || `lcr disconnect exited ${disconnect.code}`);

    console.log("broker smoke ok");
  } finally {
    if (agent) agent.kill();
    broker.kill();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
