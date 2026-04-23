#!/usr/bin/env node
/* eslint-disable no-console */

const path = require("node:path");
const { spawn } = require("node:child_process");

const cliPath = path.join(__dirname, "lcr-cli.js");
const args = process.argv.slice(2);
const forwardedArgs = args.length ? args : ["tray"];

const child = spawn(process.execPath, [cliPath, ...forwardedArgs], {
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error(`[lcr] ${error.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
