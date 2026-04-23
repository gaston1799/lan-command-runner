const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function defaultConfigPath() {
  if (process.env.LCR_CONFIG) return process.env.LCR_CONFIG;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "lan-command-runner", "config.json");
}

function loadConfig(configPath = defaultConfigPath()) {
  try {
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(config, configPath = defaultConfigPath()) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
}

module.exports = {
  defaultConfigPath,
  loadConfig,
  saveConfig,
};
