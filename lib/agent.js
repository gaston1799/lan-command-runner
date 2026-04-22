const os = require("node:os");
const { defaultUrl } = require("./client");
const { runCommand } = require("./server");

async function postJson(url, token, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function agent(options) {
  const brokerUrl = options.url || defaultUrl();
  const enrollToken = options.token || process.env.LCR_TOKEN;
  if (!enrollToken) throw new Error("Missing broker token. Pass --token or set LCR_TOKEN.");

  const name = options.name || process.env.LCR_AGENT_NAME || os.hostname();
  const registration = await postJson(new URL("/agent/register", brokerUrl).toString(), enrollToken, {
    id: options.id || process.env.LCR_AGENT_ID || undefined,
    name,
    info: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      userInfo: os.userInfo().username,
      cwd: process.cwd(),
    },
  });

  const agentId = registration.agentId;
  const agentToken = registration.agentToken;
  console.log(`[lcr] Agent registered: ${agentId} (${name})`);

  while (true) {
    try {
      const poll = await postJson(new URL(`/agent/${encodeURIComponent(agentId)}/poll?timeoutMs=25000`, brokerUrl).toString(), agentToken, {});
      if (!poll.job) continue;

      console.log(`[lcr] Running ${poll.job.id}: ${poll.job.shell ? poll.job.command : poll.job.command.join(" ")}`);
      const result = await runCommand(poll.job);
      await postJson(new URL(`/agent/${encodeURIComponent(agentId)}/result`, brokerUrl).toString(), agentToken, {
        jobId: poll.job.id,
        result,
      });
    } catch (error) {
      console.error(`[lcr] ${error.message}`);
      await sleep(2000);
    }
  }
}

module.exports = {
  agent,
};
