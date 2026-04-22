#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, numberOption } = require("../lib/args");
const { agent } = require("../lib/agent");
const { broker } = require("../lib/broker");
const { defaultUrl, health, runRemote } = require("../lib/client");
const { DEFAULT_PORT } = require("../lib/protocol");
const { generateToken, serve } = require("../lib/server");

function usage(exitCode = 0) {
  console.log(`
lan-command-runner

Usage:
  lcr token
  lcr broker --token <token> [--host 127.0.0.1] [--port ${DEFAULT_PORT}]
  lcr agent --url http://broker:${DEFAULT_PORT} --token <token> [--name <name>] [--id <agent-id>]
  lcr agents [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr exec <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] -- <cmd> [args...]
  lcr sh <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] "<command string>"
  lcr pwsh <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] "<PowerShell script>"
  lcr get <agent-id> <remote-path> <local-path> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr put <agent-id> <local-path> <remote-path> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr cat <agent-id> <remote-path> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr write <agent-id> <remote-path> --stdin [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr disconnect <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr update-agent <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>]

Direct mode:
  lcr serve --token <token> [--host 127.0.0.1] [--port ${DEFAULT_PORT}]
  lcr health [--url http://host:${DEFAULT_PORT}]
  lcr run [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] -- <cmd> [args...]
  lcr shell [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] "<command string>"
  lcr powershell [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] "<PowerShell script>"

Environment:
  LCR_TOKEN
  LCR_URL
  LCR_HOST
  LCR_PORT

Notes:
  - The server defaults to 127.0.0.1. Use --host 0.0.0.0 only on a trusted LAN.
  - Broker mode lets machines connect outbound and receive an agent id.
  - Token auth is mandatory for /run.
  - Use 'run' for argv-safe commands and 'shell' only when shell syntax is required.
`.trim());
  process.exit(exitCode);
}

function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.timedOut) {
    console.error(`[lcr] timed out after remote timeout`);
  }
  if (result.code !== 0) {
    console.error(`[lcr] remote exit code: ${result.code}${result.signal ? ` (${result.signal})` : ""}`);
  }
  process.exit(result.ok ? 0 : result.code || 1);
}

function authToken(options) {
  const token = options.token || process.env.LCR_TOKEN;
  if (!token) throw new Error("Missing token. Pass --token or set LCR_TOKEN.");
  return token;
}

async function brokerPost(options, route, payload) {
  const result = await fetch(new URL(route, options.url || defaultUrl()).toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken(options)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const responsePayload = await result.json();
  if (!result.ok) throw new Error(responsePayload.error || `HTTP ${result.status}`);
  return responsePayload;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

function printFileWriteResult(result) {
  if (!result.ok) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.code || 1);
  }
  console.log(`[lcr] wrote ${result.file?.size ?? 0} byte(s) to ${result.file?.path || "remote file"}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv.shift();
  if (!command || command === "-h" || command === "--help") usage(0);

  const options = parseArgs(argv);

  if (command === "token") {
    console.log(generateToken());
    return;
  }

  if (command === "serve") {
    serve({
      host: options.host,
      port: options.port,
      token: options.token,
    });
    return;
  }

  if (command === "broker") {
    broker({
      host: options.host,
      port: options.port,
      token: options.token,
    });
    return;
  }

  if (command === "agent") {
    await agent({
      url: options.url || defaultUrl(),
      token: options.token,
      name: options.name,
      id: options.id,
    });
    return;
  }

  if (command === "health") {
    const result = await health({ url: options.url || defaultUrl() });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "run") {
    if (!options._.length) throw new Error("Missing command after --.");
    const result = await runRemote({
      url: options.url || defaultUrl(),
      token: options.token,
      command: options._,
      cwd: options.cwd,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
    });
    printResult(result);
    return;
  }

  if (command === "agents") {
    const result = await fetch(new URL("/agents", options.url || defaultUrl()).toString(), {
      headers: { authorization: `Bearer ${options.token || process.env.LCR_TOKEN || ""}` },
    });
    const payload = await result.json();
    if (!result.ok) throw new Error(payload.error || `HTTP ${result.status}`);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "exec") {
    const agentId = options._.shift();
    if (!agentId) throw new Error("Missing agent id.");
    if (!options._.length) throw new Error("Missing command after --.");
    const payload = await brokerPost(options, `/agents/${encodeURIComponent(agentId)}/run`, {
      command: options._,
      cwd: options.cwd,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    printResult(payload);
    return;
  }

  if (command === "sh") {
    const agentId = options._.shift();
    const source = options._.join(" ").trim();
    if (!agentId) throw new Error("Missing agent id.");
    if (!source) throw new Error("Missing shell command string.");
    const payload = await brokerPost(options, `/agents/${encodeURIComponent(agentId)}/run`, {
      command: source,
      shell: true,
      cwd: options.cwd,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    printResult(payload);
    return;
  }

  if (command === "pwsh") {
    const agentId = options._.shift();
    const source = options._.join(" ").trim();
    if (!agentId) throw new Error("Missing agent id.");
    if (!source) throw new Error("Missing PowerShell script.");
    const payload = await brokerPost(options, `/agents/${encodeURIComponent(agentId)}/run`, {
      command: ["powershell", "-NoProfile", "-Command", source],
      cwd: options.cwd,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    printResult(payload);
    return;
  }

  if (command === "get") {
    const [agentId, remotePath, localPath] = options._;
    if (!agentId || !remotePath || !localPath) throw new Error("Usage: lcr get <agent-id> <remote-path> <local-path>");
    const result = await brokerPost(options, `/agents/${encodeURIComponent(agentId)}/file/read`, {
      path: remotePath,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    if (!result.ok) {
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.code || 1);
    }
    fs.mkdirSync(path.dirname(path.resolve(localPath)), { recursive: true });
    fs.writeFileSync(localPath, Buffer.from(result.file.contentBase64, "base64"));
    console.log(`[lcr] saved ${result.file.size} byte(s) to ${localPath}`);
    return;
  }

  if (command === "put") {
    const [agentId, localPath, remotePath] = options._;
    if (!agentId || !localPath || !remotePath) throw new Error("Usage: lcr put <agent-id> <local-path> <remote-path>");
    const contentBase64 = fs.readFileSync(localPath).toString("base64");
    const result = await brokerPost(options, `/agents/${encodeURIComponent(agentId)}/file/write`, {
      path: remotePath,
      contentBase64,
      mkdirp: options.mkdirp !== false,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    printFileWriteResult(result);
    return;
  }

  if (command === "cat") {
    const [agentId, remotePath] = options._;
    if (!agentId || !remotePath) throw new Error("Usage: lcr cat <agent-id> <remote-path>");
    const result = await brokerPost(options, `/agents/${encodeURIComponent(agentId)}/file/read`, {
      path: remotePath,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    if (!result.ok) {
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.code || 1);
    }
    process.stdout.write(Buffer.from(result.file.contentBase64, "base64").toString("utf8"));
    return;
  }

  if (command === "write") {
    const [agentId, remotePath, ...contentParts] = options._;
    if (!agentId || !remotePath) throw new Error("Usage: lcr write <agent-id> <remote-path> --stdin");
    const content = options.stdin ? await readStdin() : Buffer.from(contentParts.join(" "), "utf8");
    const result = await brokerPost(options, `/agents/${encodeURIComponent(agentId)}/file/write`, {
      path: remotePath,
      contentBase64: content.toString("base64"),
      mkdirp: options.mkdirp !== false,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    printFileWriteResult(result);
    return;
  }

  if (command === "disconnect") {
    const [agentId] = options._;
    if (!agentId) throw new Error("Usage: lcr disconnect <agent-id>");
    const result = await brokerPost(options, `/agents/${encodeURIComponent(agentId)}/disconnect`, {
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    printResult(result);
    return;
  }

  if (command === "update-agent") {
    const [agentId] = options._;
    if (!agentId) throw new Error("Usage: lcr update-agent <agent-id>");
    const result = await brokerPost(options, `/agents/${encodeURIComponent(agentId)}/update`, {
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    printResult(result);
    return;
  }

  if (command === "shell") {
    const source = options._.join(" ").trim();
    if (!source) throw new Error("Missing shell command string.");
    const result = await runRemote({
      url: options.url || defaultUrl(),
      token: options.token,
      command: source,
      shell: true,
      cwd: options.cwd,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
    });
    printResult(result);
    return;
  }

  if (command === "powershell") {
    const source = options._.join(" ").trim();
    if (!source) throw new Error("Missing PowerShell script.");
    const result = await runRemote({
      url: options.url || defaultUrl(),
      token: options.token,
      command: ["powershell", "-NoProfile", "-Command", source],
      cwd: options.cwd,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
    });
    printResult(result);
    return;
  }

  usage(1);
}

main().catch((error) => {
  console.error(`[lcr] ${error.message}`);
  process.exit(1);
});
