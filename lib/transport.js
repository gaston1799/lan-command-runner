// Client-side signed JSON transport shared by the direct client, the agent, and
// the CLI. Signs requests with the shared secret and verifies the response
// signature, so a substituted or replayed response is rejected.

const { buildRequestHeaders, requireSignature, verifyResponse } = require("./sign");

function requestPath(url) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

async function signedFetchJson(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    secret,
    token,
    signal,
    timeoutMs,
  } = options;

  const signingSecret = secret || token || "";
  const rawBody = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const sendsBody = method !== "GET" && method !== "HEAD" && body != null;

  const requestHeaders = { ...headers };
  if (signingSecret) {
    Object.assign(
      requestHeaders,
      buildRequestHeaders({
        secret: signingSecret,
        method,
        path: requestPath(url),
        body: rawBody,
      })
    );
  }
  if (
    signingSecret &&
    !Object.keys(requestHeaders).some((name) => name.toLowerCase() === "authorization")
  ) {
    requestHeaders.authorization = `Bearer ${signingSecret}`;
  }
  if (sendsBody && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === "content-type")) {
    requestHeaders["content-type"] = "application/json";
  }

  const controller = new AbortController();
  let timer = null;
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  if (timeoutMs) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer.unref) timer.unref();
  }

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      ...(sendsBody ? { body: rawBody } : {}),
      signal: controller.signal,
    });
    const text = await response.text();

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { ok: false, error: text };
    }

    // Verify response integrity on success when we signed and verification is
    // enabled. Error responses are trusted as "the request was rejected".
    if (signingSecret && response.ok && requireSignature()) {
      const verification = verifyResponse({
        secret: signingSecret,
        method,
        path: requestPath(url),
        nonce: requestHeaders["x-lcr-nonce"],
        body: text,
        headers: response.headers,
      });
      if (!verification.ok) {
        throw new Error(`Response signature verification failed: ${verification.reason}`);
      }
    }

    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  requestPath,
  signedFetchJson,
};
