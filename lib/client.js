const { DEFAULT_PORT } = require("./protocol");

function defaultUrl() {
  return process.env.LCR_URL || `http://127.0.0.1:${process.env.LCR_PORT || DEFAULT_PORT}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { ok: false, error: text };
  }
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function health(options) {
  return requestJson(new URL("/health", options.url || defaultUrl()).toString());
}

async function runRemote(options) {
  const token = options.token || process.env.LCR_TOKEN;
  if (!token) throw new Error("Missing token. Pass --token or set LCR_TOKEN.");

  return requestJson(new URL("/run", options.url || defaultUrl()).toString(), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command: options.command,
      shell: Boolean(options.shell),
      cwd: options.cwd || undefined,
      timeoutMs: options.timeoutMs || undefined,
      env: options.env || undefined,
    }),
  });
}

module.exports = {
  defaultUrl,
  health,
  runRemote,
};
