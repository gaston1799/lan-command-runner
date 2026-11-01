const test = require("node:test");
const assert = require("node:assert/strict");

const { isLocalBrokerUrl, isPrivateBrokerUrl, mergeBrokerCandidates } = require("../lib/auto-agent");

test("automatic broker connections reject public and unresolved hosts", () => {
  assert.equal(isPrivateBrokerUrl("http://192.168.7.93:9000"), true);
  assert.equal(isPrivateBrokerUrl("http://10.20.30.40:9000"), true);
  assert.equal(isPrivateBrokerUrl("http://100.97.103.41:9000"), true);
  assert.equal(isPrivateBrokerUrl("http://127.0.0.1:9000"), true);
  assert.equal(isPrivateBrokerUrl("http://8.8.8.8:9000"), false);
  assert.equal(isPrivateBrokerUrl("http://broker.example.com:9000"), false);
});

test("automatic discovery keeps one private address per broker", () => {
  const selected = mergeBrokerCandidates([
    { key: "node-a", url: "http://100.97.103.41:9000", authMode: "none" },
    { key: "node-a", url: "http://192.168.7.93:9000", authMode: "none" },
    { key: "node-b", url: "http://8.8.8.8:9000", authMode: "none" },
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, "http://192.168.7.93:9000");
});

test("automatic discovery resolves a broker's interfaces the same way every round", () => {
  // Regression: the same broker answering through two LAN addresses used to
  // win by UDP reply order, so the watcher stopped and re-registered the agent
  // on every discovery round.
  const left = { key: "node-a", url: "http://10.223.163.110:8765", authMode: "none" };
  const right = { key: "node-a", url: "http://192.168.7.93:8765", authMode: "none" };
  const first = mergeBrokerCandidates([left, right]);
  const second = mergeBrokerCandidates([right, left]);
  assert.equal(first.length, 1);
  assert.equal(first[0].url, second[0].url, "reply order must not change the chosen address");
});

test("automatic discovery prefers the broker address on the agent's own subnet", () => {
  const selected = mergeBrokerCandidates(
    [
      { key: "node-a", url: "http://192.168.7.93:8765", authMode: "none" },
      { key: "node-a", url: "http://10.223.163.110:8765", authMode: "none" },
    ],
    ["10.223.163.29"]
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, "http://10.223.163.110:8765");
});

test("discovery recognizes the current machine's brokers", () => {
  const local = ["192.168.7.94", "100.102.147.44"];
  assert.equal(isLocalBrokerUrl("http://192.168.7.94:9540", local), true);
  assert.equal(isLocalBrokerUrl("http://127.0.0.1:9540", local), true);
  assert.equal(isLocalBrokerUrl("http://192.168.7.93:9566", local), false);
});
