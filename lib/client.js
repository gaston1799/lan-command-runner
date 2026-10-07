const { DEFAULT_PORT } = require("./protocol");
const { signedFetchJson } = require("./transport");

function defaultUrl() {
  return process.env.LCR_URL || `http://127.0.0.1:${process.env.LCR_PORT || DEFAULT_PORT}`;
}

async function health(options) {
  return signedFetchJson(new URL("/health", options.url || defaultUrl()).toString());
}

async function runRemote(options) {
  const token = options.token || process.env.LCR_TOKEN;
  if (!token) throw new Error("Missing token. Pass --token or set LCR_TOKEN.");

  return signedFetchJson(new URL("/run", options.url || defaultUrl()).toString(), {
    method: "POST",
    token,
    body: {
      command: options.command,
      shell: Boolean(options.shell),
      cwd: options.cwd || undefined,
      timeoutMs: options.timeoutMs || undefined,
      env: options.env || undefined,
    },
  });
}

module.exports = {
  defaultUrl,
  health,
  runRemote,
};
