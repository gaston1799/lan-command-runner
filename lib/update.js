const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_REPO = "gaston1799/lan-command-runner";
const DEFAULT_INSTALLER_URL =
  "https://github.com/gaston1799/lan-command-runner/releases/latest/download/install.ps1";
const MANAGED_INSTALL_FILE = ".lcr-managed-install.json";

function defaultInstallRoot() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return "";
  return path.resolve(localAppData, "lan-command-runner");
}

function packageRoot() {
  return path.resolve(__dirname, "..");
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function readManagedInstall(root) {
  try {
    const source = fs.readFileSync(path.join(root, MANAGED_INSTALL_FILE), "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(source);
    if (parsed && parsed.managed === true && typeof parsed.repo === "string") return parsed;
  } catch {
    // A missing or malformed marker means this is not installer-managed.
  }
  return null;
}

function updatePlan(options = {}) {
  const root = path.resolve(options.packageRoot || packageRoot());
  const marker = readManagedInstall(root);
  const configuredRoot = options.installRoot || process.env.LCR_INSTALL_ROOT || defaultInstallRoot();
  if (!configuredRoot) {
    throw new Error("Could not determine the managed install root because LOCALAPPDATA is not set.");
  }
  const managedRoot = path.resolve(configuredRoot);
  const repo = options.repo || process.env.LCR_REPO || (marker && marker.repo) || DEFAULT_REPO;
  const installerUrl =
    options.installerUrl ||
    process.env.LCR_INSTALLER_URL ||
    (repo === DEFAULT_REPO
      ? DEFAULT_INSTALLER_URL
      : `https://github.com/${repo}/releases/latest/download/install.ps1`);

  return {
    packageRoot: root,
    installRoot: marker ? root : managedRoot,
    managed: Boolean(marker) || samePath(root, managedRoot),
    marker,
    repo,
    installerUrl,
    command: "lcr-cli update",
  };
}

function runUpdate(options = {}) {
  const plan = updatePlan(options);
  if (!plan.managed) {
    throw new Error(
      `Refusing to replace an unmanaged source checkout at ${plan.packageRoot}. ` +
        `The self-updater only operates on ${plan.installRoot}. ` +
        "Use git to update this checkout, or install the managed release first."
    );
  }
  if (options.dryRun) return { ...plan, updated: false, dryRun: true };
  if (process.platform !== "win32") {
    throw new Error("The managed LCR self-updater currently supports Windows only.");
  }

  // The URL is passed as an argument, not interpolated into the script body.
  // LCR_INSTALL_ROOT keeps custom installer defaults from redirecting an update
  // away from the package that issued this command.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$source = Invoke-RestMethod -Uri $args[0] -Headers @{ 'User-Agent' = 'lan-command-runner-updater' }",
    "& ([scriptblock]::Create([string]$source))",
  ].join("; ");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, plan.installerUrl],
    {
      cwd: path.dirname(plan.installRoot),
      env: {
        ...process.env,
        LCR_INSTALL_ROOT: plan.installRoot,
        LCR_REPO: plan.repo,
        LCR_VERSION: "latest",
      },
      stdio: "inherit",
      windowsHide: false,
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`LCR installer exited with code ${result.status}.`);
  }
  return { ...plan, updated: true, dryRun: false };
}

module.exports = {
  DEFAULT_INSTALLER_URL,
  DEFAULT_REPO,
  MANAGED_INSTALL_FILE,
  defaultInstallRoot,
  packageRoot,
  readManagedInstall,
  runUpdate,
  samePath,
  updatePlan,
};
