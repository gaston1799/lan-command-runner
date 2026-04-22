const { spawn } = require("node:child_process");
const { generateToken } = require("../lib/server");

const token = generateToken();
const port = 18765;
const env = { ...process.env, LCR_TOKEN: token, LCR_URL: `http://127.0.0.1:${port}` };

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      cwd: __dirname + "/..",
      windowsHide: true,
      ...options,
    });
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
  throw new Error("Server did not become healthy.");
}

async function main() {
  const server = spawn(process.execPath, ["bin/lcr.js", "serve", "--port", String(port), "--token", token], {
    cwd: __dirname + "/..",
    env,
    windowsHide: true,
  });

  try {
    await waitForHealth();
    const result = await run(process.execPath, ["bin/lcr.js", "run", process.execPath, "--version"]);
    if (result.code !== 0) throw new Error(result.stderr || `lcr run exited ${result.code}`);
    if (!/^v\d+\./.test(result.stdout.trim())) throw new Error(`Unexpected stdout: ${result.stdout}`);
    console.log("smoke ok");
  } finally {
    server.kill();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
