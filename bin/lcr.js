#!/usr/bin/env node
/* eslint-disable no-console */

const { parseArgs, numberOption } = require("../lib/args");
const { defaultUrl, health, runRemote } = require("../lib/client");
const { DEFAULT_PORT } = require("../lib/protocol");
const { generateToken, serve } = require("../lib/server");

function usage(exitCode = 0) {
  console.log(`
lan-command-runner

Usage:
  lcr token
  lcr serve --token <token> [--host 127.0.0.1] [--port ${DEFAULT_PORT}]
  lcr health [--url http://host:${DEFAULT_PORT}]
  lcr run [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] -- <cmd> [args...]
  lcr shell [--url http://host:${DEFAULT_PORT}] [--token <token>] [--cwd <path>] [--timeout-ms 60000] "<command string>"

Environment:
  LCR_TOKEN
  LCR_URL
  LCR_HOST
  LCR_PORT

Notes:
  - The server defaults to 127.0.0.1. Use --host 0.0.0.0 only on a trusted LAN.
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

  usage(1);
}

main().catch((error) => {
  console.error(`[lcr] ${error.message}`);
  process.exit(1);
});
