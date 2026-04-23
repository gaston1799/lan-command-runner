#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, numberOption } = require("../lib/args");
const { agent } = require("../lib/agent");
const { broker } = require("../lib/broker");
const { defaultUrl, health, runRemote } = require("../lib/client");
const { defaultConfigPath, loadConfig, saveConfig } = require("../lib/config");
const { DEFAULT_PORT } = require("../lib/protocol");
const { generateToken, serve } = require("../lib/server");

function usage(exitCode = 0) {
  console.log(`
lan-command-runner

Usage:
  lcr-cli token
  lcr-cli setup [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--agent-name <name>] [--agent-id <agent-id>] [--host 127.0.0.1] [--port ${DEFAULT_PORT}]
  lcr-cli show-config
  lcr-cli broker [--token <token>] [--host 127.0.0.1] [--port ${DEFAULT_PORT}]
  lcr-cli agent [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--name <name>] [--id <agent-id>]
  lcr-cli agents [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli exec <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] [--no-stream] -- <cmd> [args...]
  lcr-cli sh <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] [--no-stream] "<command string>"
  lcr-cli pwsh <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] [--no-stream] "<PowerShell script>"
  lcr-cli get <agent-id> <remote-path> <local-path> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli put <agent-id> <local-path> <remote-path> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli cat <agent-id> <remote-path> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli write <agent-id> <remote-path> --stdin [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli disconnect <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli update-agent <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli tray [--host 0.0.0.0] [--port ${DEFAULT_PORT}] [--token <token>] [--debug] [--attach]

Direct mode:
  lcr-cli serve [--token <token>] [--host 127.0.0.1] [--port ${DEFAULT_PORT}]
  lcr-cli health [--url http://host:${DEFAULT_PORT}]
  lcr-cli run [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] -- <cmd> [args...]
  lcr-cli shell [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] "<command string>"
  lcr-cli powershell [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] "<PowerShell script>"

Environment:
  LCR_TOKEN
  LCR_URL
  LCR_HOST
  LCR_PORT
  LCR_CONFIG

Notes:
  - Running \`lcr\` with no arguments opens the tray UI.
  - Use \`lcr-cli\` for terminal-first command usage.
  - \`lcr-cli setup\` saves defaults so \`lcr-cli agent\` can run with no extra flags.
`.trim());
  process.exit(exitCode);
}

function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.timedOut) {
    console.error("[lcr] timed out after remote timeout");
  }
  if (result.code !== 0) {
    console.error(`[lcr] remote exit code: ${result.code}${result.signal ? ` (${result.signal})` : ""}`);
  }
  process.exitCode = result.ok ? 0 : result.code || 1;
}

function resolvedUrl(options, config) {
  return options.url || process.env.LCR_URL || config.url || defaultUrl();
}

function resolvedHost(options, config) {
  return options.host || process.env.LCR_HOST || config.host;
}

function resolvedPort(options, config) {
  return options.port || process.env.LCR_PORT || config.port;
}

function resolvedAgentName(options, config) {
  return options.name || process.env.LCR_AGENT_NAME || config.agentName;
}

function resolvedAgentId(options, config) {
  return options.id || process.env.LCR_AGENT_ID || config.agentId;
}

function authToken(options, config) {
  const token = options.token || process.env.LCR_TOKEN || config.token;
  if (!token) throw new Error("Missing token. Pass --token, run lcr-cli setup, or set LCR_TOKEN.");
  return token;
}

async function brokerPost(options, config, route, payload) {
  const result = await fetch(new URL(route, resolvedUrl(options, config)).toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken(options, config)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const responsePayload = await result.json();
  if (!result.ok) throw new Error(responsePayload.error || `HTTP ${result.status}`);
  return responsePayload;
}

async function brokerGet(options, config, route) {
  const result = await fetch(new URL(route, resolvedUrl(options, config)).toString(), {
    headers: {
      authorization: `Bearer ${authToken(options, config)}`,
    },
  });
  const responsePayload = await result.json();
  if (!result.ok) throw new Error(responsePayload.error || `HTTP ${result.status}`);
  return responsePayload;
}

async function streamBrokerJob(options, config, jobId) {
  let after = 0;
  while (true) {
    const payload = await brokerGet(options, config, `/jobs/${encodeURIComponent(jobId)}/events?after=${after}&waitMs=25000`);
    for (const event of payload.events || []) {
      after = Math.max(after, Number(event.seq || 0));
      if (event.type === "output") {
        if (event.stream === "stderr") process.stderr.write(event.data || "");
        else process.stdout.write(event.data || "");
      }
      if (event.type === "result") return event.result;
    }
  }
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

const REMOTE_COMMAND_OPTIONS = new Set(["url", "token", "cwd", "timeout-ms", "wait-ms", "no-stream"]);

function parseRemoteCommandArgs(argv, { agentId = false } = {}) {
  const parsed = { _: [] };
  let sawAgentId = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--") {
      parsed._.push(...argv.slice(index + 1));
      break;
    }

    if (value.startsWith("--")) {
      const eq = value.indexOf("=");
      const key = eq === -1 ? value.slice(2) : value.slice(2, eq);

      if (REMOTE_COMMAND_OPTIONS.has(key)) {
        if (key === "no-stream") {
          parsed[key] = true;
          continue;
        }
        if (eq !== -1) {
          parsed[key] = value.slice(eq + 1);
          continue;
        }
        const next = argv[index + 1];
        if (!next) throw new Error(`Missing value for --${key}.`);
        parsed[key] = next;
        index += 1;
        continue;
      }
    }

    if (agentId && !sawAgentId) {
      parsed._.push(value);
      sawAgentId = true;
      continue;
    }

    parsed._.push(value, ...argv.slice(index + 1));
    break;
  }

  return parsed;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv.shift();
  if (!command || command === "-h" || command === "--help") usage(0);

  const options = parseArgs(argv);
  const config = loadConfig();

  if (command === "token") {
    console.log(generateToken());
    return;
  }

  if (command === "setup") {
    const nextConfig = {
      ...config,
      ...(options.url ? { url: options.url } : {}),
      ...(options.token ? { token: options.token } : {}),
      ...(options["agent-name"] ? { agentName: options["agent-name"] } : {}),
      ...(options["agent-id"] ? { agentId: options["agent-id"] } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.port ? { port: String(options.port) } : {}),
    };
    const configPath = saveConfig(nextConfig);
    console.log(`[lcr] saved config to ${configPath}`);
    console.log(JSON.stringify(nextConfig, null, 2));
    return;
  }

  if (command === "show-config") {
    console.log(JSON.stringify({
      path: defaultConfigPath(),
      config,
    }, null, 2));
    return;
  }

  if (command === "tray") {
    if (process.platform !== "win32") {
      throw new Error("Tray mode currently supports Windows only.");
    }

    const trayLog = path.join(process.env.LOCALAPPDATA || "", "lan-command-runner", "logs", "tray.log");
    if (options.attach) {
      console.log(`[lcr] attaching to tray log: ${trayLog}`);
      const { spawnSync } = require("node:child_process");
      const result = spawnSync("powershell", [
        "-NoProfile",
        "-Command",
        `if (!(Test-Path -LiteralPath '${trayLog.replace(/'/g, "''")}')) { New-Item -ItemType File -Force -Path '${trayLog.replace(/'/g, "''")}' | Out-Null }; Get-Content -LiteralPath '${trayLog.replace(/'/g, "''")}' -Wait -Tail 50`,
      ], {
        stdio: "inherit",
        windowsHide: false,
      });
      if (result.error) throw result.error;
      process.exitCode = result.status || 0;
      return;
    }

    const trayScript = path.join(__dirname, "..", "scripts", "lcr-tray.ps1");
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-STA",
      "-File",
      trayScript,
    ];

    const host = resolvedHost(options, config);
    const port = resolvedPort(options, config);
    const token = options.token || process.env.LCR_TOKEN || config.token;
    if (host) args.push("-HostAddress", String(host));
    if (port) args.push("-Port", String(port));
    if (token) args.push("-Token", String(token));
    if (options.debug) args.push("-DebugConsole");

    const { spawn, spawnSync } = require("node:child_process");
    if (options.debug) {
      console.log("[lcr] tray debug mode. This terminal will stay attached until the tray exits.");
      const result = spawnSync("powershell", args, {
        stdio: "inherit",
        windowsHide: false,
      });
      if (result.error) throw result.error;
      process.exitCode = result.status || 0;
      return;
    }

    const child = spawn("powershell", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    console.log("[lcr] tray launched. Check the Windows notification area.");
    return;
  }

  if (command === "serve") {
    serve({
      host: resolvedHost(options, config),
      port: resolvedPort(options, config),
      token: authToken(options, config),
    });
    return;
  }

  if (command === "broker") {
    broker({
      host: resolvedHost(options, config),
      port: resolvedPort(options, config),
      token: authToken(options, config),
    });
    return;
  }

  if (command === "agent") {
    await agent({
      url: resolvedUrl(options, config),
      token: authToken(options, config),
      name: resolvedAgentName(options, config),
      id: resolvedAgentId(options, config),
    });
    return;
  }

  if (command === "health") {
    const result = await health({ url: resolvedUrl(options, config) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "run") {
    const commandOptions = parseRemoteCommandArgs(argv);
    if (!commandOptions._.length) throw new Error("Missing command after --.");
    const result = await runRemote({
      url: resolvedUrl(commandOptions, config),
      token: authToken(commandOptions, config),
      command: commandOptions._,
      cwd: commandOptions.cwd,
      timeoutMs: numberOption(commandOptions["timeout-ms"], undefined),
    });
    printResult(result);
    return;
  }

  if (command === "agents") {
    const result = await fetch(new URL("/agents", resolvedUrl(options, config)).toString(), {
      headers: { authorization: `Bearer ${authToken(options, config)}` },
    });
    const payload = await result.json();
    if (!result.ok) throw new Error(payload.error || `HTTP ${result.status}`);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "exec") {
    const commandOptions = parseRemoteCommandArgs(argv, { agentId: true });
    const agentId = commandOptions._.shift();
    if (!agentId) throw new Error("Missing agent id.");
    if (!commandOptions._.length) throw new Error("Missing command after --.");
    const payload = await brokerPost(commandOptions, config, `/agents/${encodeURIComponent(agentId)}/run`, {
      command: commandOptions._,
      cwd: commandOptions.cwd,
      timeoutMs: numberOption(commandOptions["timeout-ms"], undefined),
      waitMs: numberOption(commandOptions["wait-ms"], undefined),
      stream: !commandOptions["no-stream"],
    });
    printResult(payload.stream ? await streamBrokerJob(commandOptions, config, payload.jobId) : payload);
    return;
  }

  if (command === "sh") {
    const agentId = options._.shift();
    const source = options._.join(" ").trim();
    if (!agentId) throw new Error("Missing agent id.");
    if (!source) throw new Error("Missing shell command string.");
    const payload = await brokerPost(options, config, `/agents/${encodeURIComponent(agentId)}/run`, {
      command: source,
      shell: true,
      cwd: options.cwd,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
      waitMs: numberOption(options["wait-ms"], undefined),
      stream: !options["no-stream"],
    });
    printResult(payload.stream ? await streamBrokerJob(options, config, payload.jobId) : payload);
    return;
  }

  if (command === "pwsh") {
    const agentId = options._.shift();
    const source = options._.join(" ").trim();
    if (!agentId) throw new Error("Missing agent id.");
    if (!source) throw new Error("Missing PowerShell script.");
    const payload = await brokerPost(options, config, `/agents/${encodeURIComponent(agentId)}/run`, {
      command: ["powershell", "-NoProfile", "-Command", source],
      cwd: options.cwd,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
      waitMs: numberOption(options["wait-ms"], undefined),
      stream: !options["no-stream"],
    });
    printResult(payload.stream ? await streamBrokerJob(options, config, payload.jobId) : payload);
    return;
  }

  if (command === "get") {
    const [agentId, remotePath, localPath] = options._;
    if (!agentId || !remotePath || !localPath) throw new Error("Usage: lcr-cli get <agent-id> <remote-path> <local-path>");
    const result = await brokerPost(options, config, `/agents/${encodeURIComponent(agentId)}/file/read`, {
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
    if (!agentId || !localPath || !remotePath) throw new Error("Usage: lcr-cli put <agent-id> <local-path> <remote-path>");
    const contentBase64 = fs.readFileSync(localPath).toString("base64");
    const result = await brokerPost(options, config, `/agents/${encodeURIComponent(agentId)}/file/write`, {
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
    if (!agentId || !remotePath) throw new Error("Usage: lcr-cli cat <agent-id> <remote-path>");
    const result = await brokerPost(options, config, `/agents/${encodeURIComponent(agentId)}/file/read`, {
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
    if (!agentId || !remotePath) throw new Error("Usage: lcr-cli write <agent-id> <remote-path> --stdin");
    const content = options.stdin ? await readStdin() : Buffer.from(contentParts.join(" "), "utf8");
    const result = await brokerPost(options, config, `/agents/${encodeURIComponent(agentId)}/file/write`, {
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
    if (!agentId) throw new Error("Usage: lcr-cli disconnect <agent-id>");
    const result = await brokerPost(options, config, `/agents/${encodeURIComponent(agentId)}/disconnect`, {
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    printResult(result);
    return;
  }

  if (command === "update-agent") {
    const [agentId] = options._;
    if (!agentId) throw new Error("Usage: lcr-cli update-agent <agent-id>");
    const result = await brokerPost(options, config, `/agents/${encodeURIComponent(agentId)}/update`, {
      waitMs: numberOption(options["wait-ms"], undefined),
    });
    printResult(result);
    return;
  }

  if (command === "shell") {
    const source = options._.join(" ").trim();
    if (!source) throw new Error("Missing shell command string.");
    const result = await runRemote({
      url: resolvedUrl(options, config),
      token: authToken(options, config),
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
      url: resolvedUrl(options, config),
      token: authToken(options, config),
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
