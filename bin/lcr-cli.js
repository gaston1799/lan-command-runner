#!/usr/bin/env node
/* eslint-disable no-console */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs, numberOption } = require("../lib/args");
const { agent } = require("../lib/agent");
const { broker } = require("../lib/broker");
const { classifyUrlTarget, getLanAddresses, normalizeUrlKey, parsePort } = require("../lib/addr");
const { defaultUrl, health, runRemote } = require("../lib/client");
const {
  DEFAULT_DISCOVERY_PORT,
  defaultConfigPath,
  listPeers,
  loadConfig,
  meshView,
  saveConfig,
  sanitizeNodeId,
  withMeshDefaults,
} = require("../lib/config");
const { discover } = require("../lib/discovery");
const { scanBrokers } = require("../lib/scan");
const { formatReport, runDoctor } = require("../lib/doctor");
const { mesh } = require("../lib/mesh");
const { isInteractive, promptConfirm, promptSecret } = require("../lib/prompt");
const { DEFAULT_PORT } = require("../lib/protocol");
const { redactValue } = require("../lib/redact");
const { generateToken, serve } = require("../lib/server");
const { signedFetchJson } = require("../lib/transport");
const {
  TASK_NAME,
  formatStatus,
  installStartup,
  removeStartup,
  statusStartup,
} = require("../lib/startup");
const { runUpdate, updatePlan } = require("../lib/update");
const { defaultAuditDir, readAuditTail } = require("../lib/audit");

function usage(exitCode = 0) {
  console.log(`
lan-command-runner

Usage:
  lcr-cli token
  lcr-cli setup [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--agent-name <name>] [--agent-id <agent-id>] [--host 127.0.0.1] [--port ${DEFAULT_PORT}]
  lcr-cli show-config [--reveal]
  lcr-cli broker [--token <token> | --trust-lan] [--host 127.0.0.1] [--port <port>]
  lcr-cli agent [--url http://broker:${DEFAULT_PORT} | --discover] [--token <token>] [--name <name>] [--id <agent-id>]
  lcr-cli agents [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli nodes [--wait-ms 3000] [--json]
  lcr-cli scan [--json]
  lcr-cli exec <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] [--no-stream] -- <cmd> [args...]
  lcr-cli sh <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] [--no-stream] "<command string>"
  lcr-cli pwsh <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] [--no-stream] "<PowerShell script>"
  lcr-cli get <agent-id> <remote-path> <local-path> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli put <agent-id> <local-path> <remote-path> [--chunk-size <bytes>] [--force=false] [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli cat <agent-id> <remote-path> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli write <agent-id> <remote-path> --stdin [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli disconnect <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli update-agent <agent-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli jobs [--agent <agent-id>] [--json] [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli cancel <agent-id> <job-id> [--url http://broker:${DEFAULT_PORT}] [--token <token>]
  lcr-cli log [--tail 50] [--json] [--dir <path>]
  lcr-cli ui [--host 0.0.0.0] [--port ${DEFAULT_PORT}] [--token <token>]
  lcr-cli tray [--host 0.0.0.0] [--port ${DEFAULT_PORT}] [--token <token>] [--debug] [--attach]

Mesh mode (every machine runs one broker and one supervisor):
  lcr-cli mesh init [--node-id <id>] [--name <name>] [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--token <token>]
  lcr-cli mesh
  lcr-cli peer add <name> --url http://peer:${DEFAULT_PORT} [--token <token>] [--enabled] [--allow-public-http]
  lcr-cli peer remove <name>
  lcr-cli peer list [--json]
  lcr-cli discover [--wait-ms 3000] [--json]
  lcr-cli doctor [--url <url> | --peer <name>] [--callback-peer <name>] [--json] [--allow-public-http]
  lcr-cli update [--yes] [--dry-run]

Windows logon startup (current user only, no elevation, no stored password):
  lcr-cli startup install [--dry-run]
  lcr-cli startup remove [--dry-run]
  lcr-cli startup status [--json]

Direct mode:
  lcr-cli serve [--token <token> | --trust-lan] [--host 127.0.0.1] [--port <port>]
  lcr-cli health [--url http://host:${DEFAULT_PORT}]
  lcr-cli run [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] -- <cmd> [args...]
  lcr-cli shell [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] "<command string>"
  lcr-cli powershell [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] "<PowerShell script>"

Environment:
  LCR_TOKEN
  LCR_PEER_TOKEN
  LCR_URL
  LCR_HOST
  LCR_PORT
  LCR_CONFIG
  LCR_GITHUB_API_URL

Notes:
  - Running \`lcr\` with no arguments opens the control panel UI.
  - Use \`lcr-cli\` for terminal-first command usage.
  - \`lcr-cli setup\` saves defaults so \`lcr-cli agent\` can run with no extra flags.
  - Broker and direct-server ports are selected from 8765-9999 when --port and LCR_PORT are omitted.
  - \`--trust-lan\` disables authentication and is only for private, trusted LANs or VPNs.
  - Tokens are redacted from show-config, setup, peer list, doctor, and startup output.
  - \`startup install\` registers a current-user logon task only. It never elevates,
    never asks for a password, and never puts a token on a command line.
  - Plain HTTP over a public network exposes tokens and remote commands to
    interception. Keep LCR on a LAN or a private VPN.
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

// Mesh fields are appended *after* the legacy keys everywhere, so existing
// single-broker configs keep their exact precedence.
function meshBroker(config) {
  return config && typeof config.broker === "object" && config.broker ? config.broker : {};
}

function localBrokerUrl(config) {
  const broker = meshBroker(config);
  const port = parsePort(broker.port);
  if (!port) return "";
  const host = !broker.host || broker.host === "0.0.0.0" || broker.host === "::" ? "127.0.0.1" : broker.host;
  return `http://${host}:${port}`;
}

function resolvedUrl(options, config) {
  return options.url || process.env.LCR_URL || config.url || localBrokerUrl(config) || defaultUrl();
}

function resolvedHost(options, config) {
  return options.host || process.env.LCR_HOST || config.host || meshBroker(config).host;
}

function resolvedPort(options, config) {
  return options.port || process.env.LCR_PORT || config.port || meshBroker(config).port;
}

function resolvedAgentName(options, config) {
  return options.name || process.env.LCR_AGENT_NAME || config.agentName || (config.node || {}).name;
}

function resolvedAgentId(options, config) {
  return options.id || process.env.LCR_AGENT_ID || config.agentId || (config.node || {}).id;
}

function authToken(options, config) {
  const token = options.token || process.env.LCR_TOKEN || config.token || meshBroker(config).token;
  if (!token) throw new Error("Missing token. Pass --token, run lcr-cli setup, or set LCR_TOKEN.");
  return token;
}

function optionalAuthToken(options, config) {
  return options.token || process.env.LCR_TOKEN || config.token || meshBroker(config).token || "";
}

const PUBLIC_HTTP_WARNING = [
  "!! Plain HTTP over a public network enables credential interception and",
  "!! remote-command interception: anyone on the path can read the broker token",
  "!! and every command and file that crosses it, and can inject their own.",
  "!! Only do this if you understand and accept that. A LAN or a private VPN",
  "!! (WireGuard, Tailscale) is the supported way to link nodes across sites.",
].join("\n");

// Peer tokens are collected interactively so they never land in shell history
// or a scheduled-task command line. There is no hidden prompt to answer in a
// pipeline, so noninteractive callers must fail fast instead of hanging.
async function resolvePeerToken(options, peerName) {
  if (typeof options.token === "string" && options.token.trim()) return options.token.trim();
  if (process.env.LCR_PEER_TOKEN) return process.env.LCR_PEER_TOKEN;
  if (!isInteractive()) {
    throw new Error(
      `Missing token for peer "${peerName}". Pass --token <token> or set LCR_PEER_TOKEN; there is no terminal to prompt on.`
    );
  }
  const token = await promptSecret(`Broker token for peer "${peerName}" (input hidden): `);
  if (!token) throw new Error(`No token entered for peer "${peerName}".`);
  return token;
}

function reciprocalSetupHint(view, peerName) {
  const addresses = getLanAddresses();
  const candidate = addresses.length ? addresses[0] : "<this-node-lan-ip>";
  return [
    `[lcr] The mesh is one-way until "${peerName}" trusts this node back.`,
    `[lcr] On "${peerName}", run:`,
    `[lcr]   lcr-cli peer add ${view.node.id} --url http://${candidate}:${view.broker.port}`,
    "[lcr] It will prompt for this node's broker token. Never paste a token into",
    "[lcr] a shared command line; read it with: lcr-cli show-config --reveal",
  ].join("\n");
}

async function brokerPost(options, config, route, payload) {
  const token = await brokerAuthToken(options, config);
  return signedFetchJson(new URL(route, resolvedUrl(options, config)).toString(), {
    method: "POST",
    token,
    body: payload,
  });
}

async function brokerGet(options, config, route) {
  const token = await brokerAuthToken(options, config);
  return signedFetchJson(new URL(route, resolvedUrl(options, config)).toString(), {
    method: "GET",
    token,
  });
}

async function brokerAuthToken(options, config) {
  const token = optionalAuthToken(options, config);
  const url = resolvedUrl(options, config);
  const probe = await signedFetchJson(new URL("/broker", url).toString(), { timeoutMs: 1500 });
  if (probe.authMode === "none") return "";
  if (token) return token;
  throw new Error("Missing token. Pass --token, run lcr-cli setup, or set LCR_TOKEN.");
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
      if (event.type === "progress") {
        const total = Number(event.total || 0);
        const current = Number(event.current || 0);
        const percent = total > 0 ? ` ${Math.floor((current / total) * 100)}%` : "";
        const message = event.message || event.phase || "progress";
        process.stderr.write(`[lcr] ${message}${percent}\n`);
      }
      if (event.type === "result") return event.result;
    }
  }
}

async function streamFileDownloadJob(options, config, jobId, localPath) {
  const targetPath = path.resolve(localPath);
  const tempPath = `${targetPath}.lcr-download`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const writer = fs.createWriteStream(tempPath);
  const hash = crypto.createHash("sha256");
  let after = 0;
  let nextChunkIndex = 0;
  let finalResult = null;

  try {
    while (true) {
      const payload = await brokerGet(
        options,
        config,
        `/jobs/${encodeURIComponent(jobId)}/events?after=${after}&waitMs=25000`
      );
      for (const event of payload.events || []) {
        after = Math.max(after, Number(event.seq || 0));
        if (event.type === "output") {
          if (event.stream === "stderr") process.stderr.write(event.data || "");
          else process.stdout.write(event.data || "");
          continue;
        }
        if (event.type === "progress") {
          const total = Number(event.total || 0);
          const current = Number(event.current || 0);
          const percent = total > 0 ? ` ${Math.floor((current / total) * 100)}%` : "";
          const message = event.message || event.phase || "progress";
          process.stderr.write(`[lcr] ${message}${percent}\n`);
          continue;
        }
        if (event.type === "file-chunk") {
          const index = Number(event.index || 0);
          if (index !== nextChunkIndex) {
            throw new Error(
              `Unexpected file chunk index ${index}; expected ${nextChunkIndex}.`
            );
          }
          const chunk = Buffer.from(String(event.dataBase64 || ""), "base64");
          hash.update(chunk);
          await new Promise((resolve, reject) => {
            writer.write(chunk, (error) => (error ? reject(error) : resolve()));
          });
          nextChunkIndex += 1;
          continue;
        }
        if (event.type === "result") {
          finalResult = event.result;
          break;
        }
      }
      if (finalResult) break;
    }
  } catch (error) {
    writer.destroy();
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }

  await new Promise((resolve, reject) => writer.end((error) => (error ? reject(error) : resolve())));
  const digest = hash.digest("hex");
  if (finalResult.file && finalResult.file.sha256 && digest !== finalResult.file.sha256) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw new Error("File integrity check failed: downloaded bytes do not match the source hash.");
  }
  if (!finalResult.ok) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    return finalResult;
  }

  fs.renameSync(tempPath, targetPath);
  return finalResult;
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

function formatJobs(jobs) {
  if (!jobs || !jobs.length) {
    console.log("[lcr] no jobs.");
    return;
  }
  for (const job of jobs) {
    const createdAt = job.createdAt ? new Date(job.createdAt).toISOString() : "";
    console.log(`${job.id}\t${job.agentId}\t${job.status}\t${job.type}\t${createdAt}`);
  }
}

// Broadcast-first, scan-fallback broker discovery. Returns { url, name, authMode }
// or null.
async function findBroker(options, config) {
  const view = meshView(config);
  const udp = await discover({
    port: view.discovery.port,
    waitMs: numberOption(options["wait-ms"], 3000),
    selfNodeId: view.node.id,
  });
  const candidates = [];
  for (const node of udp.nodes || []) {
    candidates.push({ url: node.brokerUrl, name: node.nodeName, authMode: node.authMode });
  }
  if (!candidates.length) {
    const scanned = await scanBrokers({});
    for (const entry of scanned) {
      candidates.push({ url: `http://${entry.host}:${entry.port}`, name: entry.host, authMode: entry.authMode });
    }
  }
  return candidates[0] || null;
}

const DEFAULT_FILE_TRANSFER_CHUNK_SIZE = 1024 * 1024;
const MIN_FILE_TRANSFER_CHUNK_SIZE = 64 * 1024;
const MAX_FILE_TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

function fileTransferChunkSize(value) {
  const parsed = numberOption(value, DEFAULT_FILE_TRANSFER_CHUNK_SIZE);
  if (!Number.isFinite(parsed)) return DEFAULT_FILE_TRANSFER_CHUNK_SIZE;
  return Math.max(
    MIN_FILE_TRANSFER_CHUNK_SIZE,
    Math.min(MAX_FILE_TRANSFER_CHUNK_SIZE, Math.floor(parsed))
  );
}

async function uploadFileInChunks(options, config, agentId, localPath, remotePath) {
  const sourcePath = path.resolve(localPath);
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new Error(`Local upload source is not a file: ${localPath}`);

  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const temporaryRemotePath = `${remotePath}.lcr-upload-${suffix}.tmp`;
  const chunkSize = fileTransferChunkSize(options["chunk-size"]);
  let sent = 0;
  const hash = crypto.createHash("sha256");

  try {
    const prepared = await brokerPost(
      options,
      config,
      `/agents/${encodeURIComponent(agentId)}/file/write`,
      {
        type: "file.write",
        path: temporaryRemotePath,
        contentBase64: "",
        mkdirp: options.mkdirp !== false,
        overwrite: true,
        timeoutMs: numberOption(options["timeout-ms"], undefined),
        waitMs: numberOption(options["wait-ms"], undefined),
        stream: false,
      }
    );
    if (!prepared.ok) throw new Error(prepared.stderr || "Could not prepare remote upload.");

    const stream = fs.createReadStream(sourcePath, { highWaterMark: chunkSize });
    const inflight = [];
    const settle = async () => {
      const results = await Promise.all(inflight);
      inflight.length = 0;
      for (const result of results) {
        if (!result.ok) throw new Error(result.stderr || "Remote upload chunk failed.");
      }
    };
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const offset = sent;
      sent += buffer.length;
      hash.update(buffer);
      inflight.push(
        brokerPost(
          options,
          config,
          `/agents/${encodeURIComponent(agentId)}/file/write`,
          {
            type: "file.append",
            path: temporaryRemotePath,
            offset,
            contentBase64: buffer.toString("base64"),
            timeoutMs: numberOption(options["timeout-ms"], undefined),
            waitMs: numberOption(options["wait-ms"], undefined),
            stream: false,
          }
        )
      );
      if (inflight.length >= UPLOAD_CONCURRENCY) await settle();
      process.stderr.write(`[lcr] uploaded ${sent}/${stat.size} byte(s)\n`);
    }
    await settle();

    const committed = await brokerPost(
      options,
      config,
      `/agents/${encodeURIComponent(agentId)}/file/write`,
      {
        type: "file.commit",
        sourcePath: temporaryRemotePath,
        targetPath: remotePath,
        expectedSize: stat.size,
        sha256: hash.digest("hex"),
        mkdirp: options.mkdirp !== false,
        overwrite: options.force !== false,
        timeoutMs: numberOption(options["timeout-ms"], undefined),
        waitMs: numberOption(options["wait-ms"], undefined),
        stream: false,
      }
    );
    if (!committed.ok) throw new Error(committed.stderr || "Remote upload commit failed.");
    return committed;
  } catch (error) {
    throw new Error(`${error.message} Temporary remote upload: ${temporaryRemotePath}`);
  }
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
    // Reload rather than spreading over the snapshot taken above, so a
    // concurrent `peer add` is not silently rolled back.
    const nextConfig = {
      ...loadConfig(),
      ...(options.url ? { url: options.url } : {}),
      ...(options.token ? { token: options.token } : {}),
      ...(options["agent-name"] ? { agentName: options["agent-name"] } : {}),
      ...(options["agent-id"] ? { agentId: options["agent-id"] } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.port ? { port: String(options.port) } : {}),
    };
    const configPath = saveConfig(nextConfig);
    console.log(`[lcr] saved config to ${configPath}`);
    console.log(JSON.stringify(redactValue(nextConfig), null, 2));
    return;
  }

  if (command === "show-config") {
    // Redacted by default; --reveal is the explicit escape hatch for the
    // workflows (tray, start-broker.ps1) that genuinely need the raw value.
    console.log(JSON.stringify({
      path: defaultConfigPath(),
      config: options.reveal === true ? config : redactValue(config),
      ...(options.reveal === true ? {} : { note: "Tokens are redacted. Use --reveal to print them." }),
    }, null, 2));
    return;
  }

  if (command === "mesh") {
    const subcommand = options._[0];

    if (subcommand === "init") {
      // Reload immediately before writing: a concurrent `peer add` must not be
      // clobbered by the snapshot loaded at the top of main().
      const current = loadConfig();
      const currentNode = current.node && typeof current.node === "object" ? current.node : {};
      const currentBroker = meshBroker(current);

      const nodeId = sanitizeNodeId(options["node-id"] || currentNode.id || current.agentId || os.hostname());
      if (!nodeId) throw new Error("Could not derive a node id. Pass --node-id <id>.");
      const nodeName = String(options.name || currentNode.name || os.hostname());
      const brokerToken = options.token || currentBroker.token || current.token || generateToken();
      const generated = !options.token && !currentBroker.token && !current.token;

      const nextConfig = withMeshDefaults(current, {
        nodeId,
        nodeName,
        brokerHost: options.host || currentBroker.host || current.host || "127.0.0.1",
        brokerPort: options.port || currentBroker.port || current.port || DEFAULT_PORT,
        brokerToken,
      });

      const configPath = saveConfig(nextConfig);
      console.log(`[lcr] mesh node initialized in ${configPath}`);
      console.log(JSON.stringify(redactValue({
        version: nextConfig.version,
        node: nextConfig.node,
        broker: nextConfig.broker,
        discovery: nextConfig.discovery,
        peers: Object.keys(nextConfig.peers || {}),
      }), null, 2));
      if (generated) console.log("[lcr] a new broker token was generated. Read it with: lcr-cli show-config --reveal");
      if (current.url) {
        // A legacy url is where this machine used to *connect*, which says
        // nothing about whether that broker should now be a mesh peer.
        console.log(`[lcr] note: legacy url ${current.url} was left as-is and was NOT added as a peer.`);
      }
      console.log("[lcr] next: start this node with `lcr-cli mesh`, then add peers with `lcr-cli peer add`.");
      return;
    }

    if (subcommand && subcommand !== "run") {
      throw new Error(`Unknown mesh subcommand: ${subcommand}. Use \`lcr-cli mesh init\` or \`lcr-cli mesh\`.`);
    }

    await mesh({ configPath: defaultConfigPath() });
    return;
  }

  if (command === "peer") {
    const subcommand = options._[0];

    if (subcommand === "add") {
      const peerName = options._[1];
      if (!peerName) throw new Error("Usage: lcr-cli peer add <name> --url <url> [--token <token>]");
      if (typeof options.url !== "string" || !options.url.trim()) {
        throw new Error(`Missing --url for peer "${peerName}".`);
      }

      const target = classifyUrlTarget(options.url.trim());
      const allowPublicHttp = options["allow-public-http"] === true;
      if (target.requiresPublicHttpOptIn && !allowPublicHttp) {
        const reason =
          target.scope === "unknown"
            ? `"${target.host}" is a name this command cannot prove is private`
            : `${target.host} is a public address`;
        throw new Error(
          `Refusing to add peer "${peerName}": ${reason} and the url is plain HTTP.\n${PUBLIC_HTTP_WARNING}\n` +
            "Use https, move the peer onto your LAN or VPN, or re-run with --allow-public-http if you accept the risk."
        );
      }

      const token = await resolvePeerToken(options, peerName);

      const current = loadConfig();
      const view = meshView(current);
      const targetKey = normalizeUrlKey(target.url);
      if (normalizeUrlKey(localBrokerUrl(current) || "") === targetKey) {
        throw new Error(`Refusing to add peer "${peerName}": that url is this node's own broker.`);
      }
      for (const existing of listPeers(current)) {
        if (existing.name !== peerName && normalizeUrlKey(existing.url) === targetKey) {
          throw new Error(
            `Refusing to add peer "${peerName}": peer "${existing.name}" already points at that broker. ` +
              "Two records on one broker fight over the same registration."
          );
        }
      }

      const nextConfig = withMeshDefaults(current, {});
      nextConfig.peers = {
        ...nextConfig.peers,
        [peerName]: {
          ...(nextConfig.peers[peerName] || {}),
          url: target.url,
          token,
          enabled: options.enabled !== false,
          allowPublicHttp,
        },
      };

      const configPath = saveConfig(nextConfig);
      console.log(`[lcr] peer "${peerName}" saved to ${configPath} (token stored, not shown).`);
      if (allowPublicHttp && target.requiresPublicHttpOptIn) {
        console.log(PUBLIC_HTTP_WARNING);
        console.log(`[lcr] peer "${peerName}" is explicitly opted into plain-HTTP public transport.`);
      }
      console.log(reciprocalSetupHint(view, peerName));
      return;
    }

    if (subcommand === "remove") {
      const peerName = options._[1];
      if (!peerName) throw new Error("Usage: lcr-cli peer remove <name>");
      const current = loadConfig();
      const peers = current.peers && typeof current.peers === "object" ? { ...current.peers } : {};
      if (!(peerName in peers)) throw new Error(`Unknown peer: ${peerName}`);
      delete peers[peerName];
      const configPath = saveConfig({ ...current, peers });
      console.log(`[lcr] peer "${peerName}" removed from ${configPath}.`);
      return;
    }

    if (subcommand === "list" || !subcommand) {
      const peers = listPeers(config).map((peer) => ({
        name: peer.name,
        url: peer.url,
        enabled: peer.enabled,
        allowPublicHttp: peer.allowPublicHttp,
        tokenConfigured: Boolean(peer.token),
      }));
      if (options.json === true) {
        console.log(JSON.stringify(redactValue({ peers }), null, 2));
        return;
      }
      if (!peers.length) {
        console.log("[lcr] no peers configured. Add one with: lcr-cli peer add <name> --url <url>");
        return;
      }
      for (const peer of peers) {
        const flags = [
          peer.enabled ? "enabled" : "disabled",
          peer.tokenConfigured ? "token stored" : "NO TOKEN",
          ...(peer.allowPublicHttp ? ["public-http opt-in"] : []),
        ];
        console.log(`${peer.name}\t${peer.url}\t[${flags.join(", ")}]`);
      }
      return;
    }

    throw new Error(`Unknown peer subcommand: ${subcommand}. Use add, remove, or list.`);
  }

  if (command === "discover") {
    const view = meshView(config);
    const result = await discover({
      port: view.discovery.port,
      waitMs: numberOption(options["wait-ms"], 3000),
      selfNodeId: view.node.id,
    });

    if (options.json === true) {
      console.log(JSON.stringify(redactValue(result), null, 2));
      return;
    }

    if (!result.ok) {
      console.error(`[lcr] discovery could not start: ${result.errors.join("; ")}`);
      process.exitCode = 1;
      return;
    }
    for (const error of result.errors) console.error(`[lcr] discovery warning: ${error}`);
    if (!result.nodes.length) {
      console.log(`[lcr] no nodes answered on ${result.port}/udp within ${result.waitMs}ms.`);
      console.log("[lcr] Discovery only advertises identity; it never establishes trust or shares tokens.");
      return;
    }
    for (const node of result.nodes) {
      console.log(`${node.nodeId}\t${node.nodeName}\t${node.brokerUrl}${node.self ? "\t(this node)" : ""}`);
    }
    console.log("[lcr] Discovery establishes no trust. Add a peer explicitly with: lcr-cli peer add <name> --url <url>");
    return;
  }

  if (command === "doctor") {
    const report = await runDoctor({
      configPath: defaultConfigPath(),
      url: typeof options.url === "string" ? options.url : undefined,
      peer: typeof options.peer === "string" ? options.peer : undefined,
      callbackPeer: typeof options["callback-peer"] === "string" ? options["callback-peer"] : undefined,
      allowPublicHttp: options["allow-public-http"] === true,
    });
    console.log(options.json === true ? JSON.stringify(report, null, 2) : formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "update") {
    const plan = updatePlan();
    if (!plan.managed) {
      throw new Error(
        `This LCR command is running from the unmanaged source checkout at ${plan.packageRoot}. ` +
          `The self-updater only replaces the managed installation at ${plan.installRoot}.`
      );
    }
    if (options["dry-run"] === true) {
      console.log(`[lcr] dry run: would update ${plan.installRoot} from the latest ${plan.repo} release.`);
      console.log("[lcr] no files were changed.");
      return;
    }
    if (options.yes !== true) {
      if (!isInteractive()) {
        throw new Error("Update confirmation requires an interactive terminal. Re-run with: lcr-cli update --yes");
      }
      const accepted = await promptConfirm(
        `[lcr] Replace ${plan.installRoot} with the latest release while preserving config and logs? [y/N] `
      );
      if (!accepted) {
        console.log("[lcr] update cancelled; no files were changed.");
        return;
      }
    }
    console.log(`[lcr] updating ${plan.installRoot} from the latest ${plan.repo} release...`);
    runUpdate({ packageRoot: plan.packageRoot, installRoot: plan.installRoot });
    console.log("[lcr] update complete. Run: lcr-cli doctor");
    return;
  }

  if (command === "startup") {
    const subcommand = options._[0] || "status";
    const dryRun = options["dry-run"] === true;

    if (subcommand === "install") {
      const result = installStartup({ dryRun, configPath: defaultConfigPath() });
      console.log(
        dryRun
          ? `[lcr] dry run: nothing was written and no scheduled task was created or replaced.`
          : `[lcr] registered the "${TASK_NAME}" logon task for the current user.`
      );
      for (const line of result.plan) console.log(`  ${line}`);
      if (!dryRun) {
        console.log("[lcr] verify with: lcr-cli startup status");
        console.log("[lcr] it starts at your next interactive logon; start it now with: lcr-cli mesh");
      }
      return;
    }

    if (subcommand === "remove") {
      const result = removeStartup({ dryRun, configPath: defaultConfigPath() });
      if (dryRun) {
        console.log("[lcr] dry run: no scheduled task was removed.");
        for (const line of result.plan) console.log(`  ${line}`);
        return;
      }
      console.log(
        result.existed
          ? `[lcr] removed the "${TASK_NAME}" logon task. Your configuration and logs were left in place.`
          : `[lcr] no "${TASK_NAME}" logon task was registered; nothing to remove.`
      );
      return;
    }

    if (subcommand === "status") {
      const status = statusStartup({ configPath: defaultConfigPath() });
      console.log(options.json === true ? JSON.stringify(status, null, 2) : formatStatus(status));
      return;
    }

    throw new Error(`Unknown startup subcommand: ${subcommand}. Use install, remove, or status.`);
  }

  if (command === "tray" || command === "ui") {
    if (process.platform !== "win32") {
      throw new Error("Tray/UI mode currently supports Windows only.");
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
    const token = options.token || process.env.LCR_TOKEN || config.token || meshBroker(config).token;
    if (host) args.push("-HostAddress", String(host));
    if (port) args.push("-Port", String(port));
    if (options.debug) args.push("-DebugConsole");
    const trayEnv = token ? { ...process.env, LCR_TOKEN: String(token) } : process.env;

    const { spawn, spawnSync } = require("node:child_process");
    if (options.debug || command === "ui") {
      if (command === "ui") console.log("[lcr] opening control panel. Close the window to keep it in the tray.");
      else console.log("[lcr] tray debug mode. This terminal will stay attached until the tray exits.");
      const result = spawnSync("powershell", args, {
        stdio: "inherit",
        windowsHide: false,
        env: trayEnv,
      });
      if (result.error) throw result.error;
      process.exitCode = result.status || 0;
      return;
    }

    const child = spawn("powershell", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: trayEnv,
    });
    child.unref();
    console.log("[lcr] tray launched. Check the Windows notification area.");
    return;
  }

  if (command === "serve") {
    const authMode = options["trust-lan"] ? "none" : "token";
    await serve({
      host: resolvedHost(options, config),
      port: options.port || process.env.LCR_PORT,
      token: authMode === "none" ? options.token || process.env.LCR_TOKEN || "" : authToken(options, config),
      authMode,
    });
    return;
  }

  if (command === "broker") {
    const authMode = options["trust-lan"] ? "none" : "token";
    await broker({
      host: resolvedHost(options, config),
      port: options.port || process.env.LCR_PORT,
      token: authMode === "none" ? options.token || process.env.LCR_TOKEN || "" : authToken(options, config),
      authMode,
    });
    return;
  }

  if (command === "agent") {
    let url = resolvedUrl(options, config);
    let token;
    if (options.discover === true) {
      const found = await findBroker(options, config);
      if (!found) throw new Error("No broker found on the LAN. Start one with: lcr-cli broker --trust-lan");
      url = found.url;
      token = found.authMode === "none" ? "" : authToken(options, config);
      console.log(`[lcr] discovered broker at ${url} (authMode ${found.authMode})`);
    } else {
      token = authToken(options, config);
    }
    await agent({
      url,
      token: token || "",
      name: resolvedAgentName(options, config),
      id: resolvedAgentId(options, config),
      allowUnauthenticated: !token,
    });
    return;
  }

  if (command === "scan") {
    const results = await scanBrokers({});
    if (options.json === true) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (!results.length) {
      console.log("[lcr] no brokers found via TCP scan.");
      return;
    }
    for (const entry of results) {
      console.log(`${entry.host}:${entry.port}\tv${entry.protocolVersion}\t${entry.authMode}`);
    }
    return;
  }

  if (command === "nodes") {
    const view = meshView(config);
    const udp = await discover({
      port: view.discovery.port,
      waitMs: numberOption(options["wait-ms"], 3000),
      selfNodeId: view.node.id,
    });
    const scanned = await scanBrokers({});
    const rows = [];
    const seen = new Set();
    for (const node of udp.nodes || []) {
      if (seen.has(node.brokerUrl)) continue;
      seen.add(node.brokerUrl);
      rows.push({ name: node.nodeName, url: node.brokerUrl, version: node.protocolVersion, authMode: node.authMode, self: node.self });
    }
    for (const entry of scanned) {
      const url = `http://${entry.host}:${entry.port}`;
      if (seen.has(url)) continue;
      seen.add(url);
      rows.push({ name: entry.host, url, version: entry.protocolVersion, authMode: entry.authMode, self: false });
    }
    if (options.json === true) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (!rows.length) {
      console.log("[lcr] no nodes found on the LAN.");
      return;
    }
    for (const row of rows) {
      console.log(`${row.name}\t${row.url}\tv${row.version}\t${row.authMode}${row.self ? "\t(this node)" : ""}`);
    }
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
    const payload = await brokerGet(options, config, "/agents");
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
      stream: true,
    });
    const finalResult = result.stream
      ? await streamFileDownloadJob(options, config, result.jobId, localPath)
      : result;
    if (!finalResult.ok) {
      if (finalResult.stderr) process.stderr.write(finalResult.stderr);
      process.exit(finalResult.code || 1);
    }
    console.log(`[lcr] saved ${finalResult.file.size} byte(s) to ${localPath}`);
    return;
  }

  if (command === "put") {
    const [agentId, localPath, remotePath] = options._;
    if (!agentId || !localPath || !remotePath) throw new Error("Usage: lcr-cli put <agent-id> <local-path> <remote-path>");
    const result = await uploadFileInChunks(options, config, agentId, localPath, remotePath);
    console.log(`[lcr] uploaded ${result.file?.size ?? 0} byte(s) to ${result.file?.path || remotePath}`);
    return;
  }

  if (command === "cat") {
    const [agentId, remotePath] = options._;
    if (!agentId || !remotePath) throw new Error("Usage: lcr-cli cat <agent-id> <remote-path>");
    const result = await brokerPost(options, config, `/agents/${encodeURIComponent(agentId)}/file/read`, {
      path: remotePath,
      timeoutMs: numberOption(options["timeout-ms"], undefined),
      waitMs: numberOption(options["wait-ms"], undefined),
      stream: false,
    });
    const finalResult = result.stream ? await streamBrokerJob(options, config, result.jobId) : result;
    if (!finalResult.ok) {
      if (finalResult.stderr) process.stderr.write(finalResult.stderr);
      process.exit(finalResult.code || 1);
    }
    const content = Buffer.from(finalResult.file.contentBase64, "base64");
    if (finalResult.file.sha256) {
      const actual = crypto.createHash("sha256").update(content).digest("hex");
      if (actual !== finalResult.file.sha256) {
        throw new Error("File integrity check failed: downloaded bytes do not match the source hash.");
      }
    }
    process.stdout.write(content.toString("utf8"));
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
      stream: true,
    });
    printFileWriteResult(result.stream ? await streamBrokerJob(options, config, result.jobId) : result);
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

  if (command === "jobs") {
    const query = options.agent ? `?agent=${encodeURIComponent(options.agent)}` : "";
    const payload = await brokerGet(options, config, `/jobs${query}`);
    if (options.json === true) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      formatJobs(payload.jobs);
    }
    return;
  }

  if (command === "cancel") {
    const [agentId, jobId] = options._;
    if (!agentId || !jobId) throw new Error("Usage: lcr-cli cancel <agent-id> <job-id>");
    const result = await brokerPost(
      options,
      config,
      `/agents/${encodeURIComponent(agentId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
      {}
    );
    if (!result.ok) {
      console.error(`[lcr] ${result.error || "could not cancel job"}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[lcr] cancelled job ${jobId} (${result.status})`);
    return;
  }

  if (command === "log") {
    const dir = typeof options.dir === "string" && options.dir.trim() ? options.dir : defaultAuditDir();
    const count = numberOption(options.tail, 50);
    const lines = readAuditTail(dir, count);
    if (options.json === true) {
      console.log(JSON.stringify(lines, null, 2));
      return;
    }
    if (!lines.length) {
      console.log(`[lcr] no audit entries in ${dir}`);
      return;
    }
    for (const line of lines) {
      const { ts, host, event, ...rest } = line;
      const restText = rest.raw ? rest.raw : JSON.stringify(rest);
      console.log(`${ts || ""}  ${host || "-"} ${event || "-"} ${restText}`);
    }
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
