// Current-user Windows logon startup for the mesh supervisor.
//
// Everything that decides *what* gets registered is a pure builder, so the
// quoting, scoping, and redaction rules can be tested without ever touching the
// real Task Scheduler. The only impure functions are runPowerShell() and the
// three thin install/remove/status wrappers around it.
//
// Deliberate constraints:
//   - The task runs as the interactive current user at RunLevel Limited. It
//     never asks for SYSTEM, never asks for "highest privileges", and never
//     self-elevates.
//   - No Windows password is requested or stored: an interactive-logon
//     principal needs none.
//   - No token ever reaches the task command line, the task XML, the generated
//     runtime script, the log file, or status output. The child process reads
//     the broker and peer tokens from the config file at runtime, and the only
//     thing we hand it is that file's *path*.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { defaultConfigPath } = require("./config");
const { redactText, redactValue } = require("./redact");

const TASK_NAME = "LAN Command Runner Mesh";
const TASK_PATH = "\\";
const RUN_LEVEL = "Limited";
const LOGON_TYPE = "Interactive";
const TRIGGER = "AtLogOn";
const LOG_FILE_NAME = "mesh.log";
const RUNTIME_SCRIPT_NAME = "start-mesh.ps1";

const REPO_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

// PowerShell single-quoted literal: the only metacharacter inside one is the
// single quote itself, which is escaped by doubling it. Nothing in the string
// is expanded, so `$`, backtick, and `"` are all inert.
function psQuote(value) {
  return `'${String(value == null ? "" : value).replace(/'/g, "''")}'`;
}

// A path that carries a double quote or a newline cannot be embedded in a
// scheduled-task argument string without ambiguity, so refuse it outright
// rather than registering a task that silently runs the wrong thing.
function assertQuotablePath(label, value) {
  const text = String(value == null ? "" : value);
  if (!text) throw new Error(`Cannot build the startup task: ${label} is empty.`);
  if (text.includes('"')) {
    throw new Error(`Cannot build the startup task: ${label} contains a double quote (${text}).`);
  }
  if (/[\r\n]/.test(text)) {
    throw new Error(`Cannot build the startup task: ${label} contains a line break.`);
  }
  return text;
}

// Switch names stay bare; every value — and therefore every path — is quoted.
function quoteArgumentToken(token) {
  const text = String(token == null ? "" : token);
  if (/^-[A-Za-z]/.test(text)) return text;
  return `"${text}"`;
}

function buildActionArgumentString(argv) {
  return argv.map(quoteArgumentToken).join(" ");
}

// Splits a registered task's argument string back into tokens so `startup
// status` can report what is *actually* registered instead of what we would
// register now. Only double-quote grouping matters here; Windows argument
// parsing has no other quoting form in the strings we generate.
function tokenizeArgumentString(value) {
  const text = String(value == null ? "" : value);
  const tokens = [];
  let current = "";
  let quoted = false;
  let started = false;

  for (const character of text) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function parseActionArguments(value) {
  const tokens = tokenizeArgumentString(value);
  const named = { file: "", configPath: "", nodePath: "", cliPath: "", logPath: "" };
  const keys = {
    "-file": "file",
    "-configpath": "configPath",
    "-nodepath": "nodePath",
    "-clipath": "cliPath",
    "-logpath": "logPath",
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const key = keys[tokens[index].toLowerCase()];
    if (!key) continue;
    const next = tokens[index + 1];
    if (next == null || /^-[A-Za-z]/.test(next)) continue;
    named[key] = next;
    index += 1;
  }
  return { tokens, ...named };
}

// ---------------------------------------------------------------------------
// Platform guard
// ---------------------------------------------------------------------------

function requireWindows(platform = process.platform) {
  if (platform === "win32") return;
  throw new Error(
    "`lcr-cli startup` registers a Windows Scheduled Task and is Windows-only. " +
      `This machine reports platform "${platform}". On Linux or macOS, supervise \`lcr-cli mesh\` ` +
      "with systemd, launchd, or your own process manager instead."
  );
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function localAppData(env = process.env) {
  return env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function defaultLogDirectory(env = process.env) {
  return path.join(localAppData(env), "lan-command-runner", "logs");
}

function defaultPowerShellPath(env = process.env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function currentUserId(env = process.env) {
  const username = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return env.USERNAME || "";
    }
  })();
  if (!username) return "";
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${username}` : username;
}

// ---------------------------------------------------------------------------
// Task specification (pure)
// ---------------------------------------------------------------------------

function buildTaskSpec(options = {}) {
  const env = options.env || process.env;
  const nodePath = assertQuotablePath("the Node executable path", options.nodePath || process.execPath);
  const cliPath = assertQuotablePath(
    "the lcr-cli path",
    options.cliPath || path.join(REPO_ROOT, "bin", "lcr-cli.js")
  );
  const scriptPath = assertQuotablePath(
    "the startup script path",
    options.scriptPath || path.join(REPO_ROOT, "scripts", RUNTIME_SCRIPT_NAME)
  );
  const configPath = assertQuotablePath(
    "the config path",
    path.resolve(options.configPath || defaultConfigPath())
  );
  const logDirectory = assertQuotablePath(
    "the log directory",
    options.logDirectory || defaultLogDirectory(env)
  );
  const logPath = assertQuotablePath("the log path", options.logPath || path.join(logDirectory, LOG_FILE_NAME));
  const powershellPath = assertQuotablePath(
    "the PowerShell path",
    options.powershellPath || defaultPowerShellPath(env)
  );
  // `!= null` rather than `||`: an explicitly empty user id means "could not
  // determine the current user", which must fail loudly rather than silently
  // falling back to whoever is running the command.
  const userId = assertQuotablePath(
    "the current user id",
    options.userId != null ? options.userId : currentUserId(env)
  );

  const argumentArray = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    scriptPath,
    "-ConfigPath",
    configPath,
    "-NodePath",
    nodePath,
    "-CliPath",
    cliPath,
    "-LogPath",
    logPath,
  ];

  return {
    taskName: TASK_NAME,
    taskPath: TASK_PATH,
    trigger: TRIGGER,
    logonType: LOGON_TYPE,
    runLevel: RUN_LEVEL,
    userId,
    powershellPath,
    scriptPath,
    nodePath,
    cliPath,
    configPath,
    logDirectory,
    logPath,
    argumentArray,
    argumentString: buildActionArgumentString(argumentArray),
  };
}

// ---------------------------------------------------------------------------
// Generated PowerShell (pure)
// ---------------------------------------------------------------------------

const SCHEDULED_TASKS_GUARD = [
  "if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {",
  "  throw 'The ScheduledTasks PowerShell module is unavailable on this system.'",
  "}",
].join("\n");

function buildRegisterScript(spec) {
  return [
    "$ErrorActionPreference = 'Stop'",
    SCHEDULED_TASKS_GUARD,
    `$taskName = ${psQuote(spec.taskName)}`,
    `$taskPath = ${psQuote(spec.taskPath)}`,
    `$userId = ${psQuote(spec.userId)}`,
    `$action = New-ScheduledTaskAction -Execute ${psQuote(spec.powershellPath)} -Argument ${psQuote(spec.argumentString)}`,
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId",
    // Interactive + Limited: the task inherits the logged-on user's normal
    // token. No password, no elevation, no SYSTEM.
    "$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries" +
      " -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)",
    // -Force replaces exactly this task name at exactly this path and leaves
    // every other scheduled task, and all user configuration, untouched.
    "Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Action $action -Trigger $trigger" +
      " -Principal $principal -Settings $settings -Force | Out-Null",
    "Write-Output 'registered'",
  ].join("\n");
}

function buildRemoveScript(spec) {
  return [
    "$ErrorActionPreference = 'Stop'",
    SCHEDULED_TASKS_GUARD,
    `$taskName = ${psQuote(spec.taskName)}`,
    `$taskPath = ${psQuote(spec.taskPath)}`,
    // Exact-name match only. No wildcard, no prefix match, and nothing outside
    // the root task folder is ever considered.
    "$task = Get-ScheduledTask -TaskPath $taskPath -ErrorAction SilentlyContinue |" +
      " Where-Object { $_.TaskName -eq $taskName } | Select-Object -First 1",
    "if (-not $task) { Write-Output 'missing'; exit 0 }",
    "Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false",
    "Write-Output 'removed'",
  ].join("\n");
}

function buildStatusScript(spec) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$taskName = ${psQuote(spec.taskName)}`,
    `$taskPath = ${psQuote(spec.taskPath)}`,
    "if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {",
    "  [pscustomobject]@{ supported = $false; exists = $false;" +
      " error = 'The ScheduledTasks PowerShell module is unavailable on this system.' } |" +
      " ConvertTo-Json -Compress",
    "  exit 0",
    "}",
    "$task = $null",
    "try {",
    "  $task = Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop |" +
      " Where-Object { $_.TaskName -eq $taskName } | Select-Object -First 1",
    "} catch { $task = $null }",
    "if (-not $task) {",
    "  [pscustomobject]@{ supported = $true; exists = $false } | ConvertTo-Json -Compress",
    "  exit 0",
    "}",
    "$info = $null",
    "try { $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop } catch { $info = $null }",
    "$lastRunTime = ''",
    "$lastTaskResult = ''",
    "$nextRunTime = ''",
    "if ($info) {",
    "  if ($info.LastRunTime) { $lastRunTime = $info.LastRunTime.ToString('o') }",
    "  if ($null -ne $info.LastTaskResult) { $lastTaskResult = [string]$info.LastTaskResult }",
    "  if ($info.NextRunTime) { $nextRunTime = $info.NextRunTime.ToString('o') }",
    "}",
    "$action = $task.Actions | Select-Object -First 1",
    "[pscustomobject]@{",
    "  supported = $true",
    "  exists = $true",
    "  taskName = [string]$task.TaskName",
    "  taskPath = [string]$task.TaskPath",
    "  state = [string]$task.State",
    "  userId = [string]$task.Principal.UserId",
    "  logonType = [string]$task.Principal.LogonType",
    "  runLevel = [string]$task.Principal.RunLevel",
    "  execute = [string]$action.Execute",
    "  arguments = [string]$action.Arguments",
    "  lastRunTime = $lastRunTime",
    "  lastTaskResult = $lastTaskResult",
    "  nextRunTime = $nextRunTime",
    "} | ConvertTo-Json -Depth 3 -Compress",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Dry-run description (pure)
// ---------------------------------------------------------------------------

function describeInstall(spec, { dryRun = false } = {}) {
  const verb = dryRun ? "would" : "will";
  return [
    `Task name:       ${spec.taskName} (at ${spec.taskPath})`,
    `Trigger:         ${spec.trigger} for ${spec.userId}`,
    `Principal:       ${spec.userId}, logon type ${spec.logonType}, run level ${spec.runLevel} (never Highest, never SYSTEM)`,
    `Action execute:  ${spec.powershellPath}`,
    `Action argument: ${redactText(spec.argumentString)}`,
    `Runtime script:  ${spec.scriptPath}`,
    `Node:            ${spec.nodePath}`,
    `CLI:             ${spec.cliPath} mesh`,
    `Config:          ${spec.configPath} (passed as LCR_CONFIG; contents are never printed)`,
    `Log (append):    ${spec.logPath}`,
    `Log directory:   ${spec.logDirectory} (${verb} be created at run time if missing)`,
    "No token is placed on the command line, in the task definition, or in the log.",
    "No password is requested or stored, and no elevation is requested.",
    `Existing "${spec.taskName}" ${verb} be replaced; no other scheduled task and no configuration ${verb} change.`,
  ];
}

function describeRemove(spec, { dryRun = false } = {}) {
  const verb = dryRun ? "would" : "will";
  return [
    `Task name:       ${spec.taskName} (at ${spec.taskPath}) — exact name match only`,
    `Scope:           only this task ${verb} be unregistered.`,
    `Config:          ${spec.configPath} ${verb} NOT be read, modified, or deleted.`,
    `Log:             ${spec.logPath} ${verb} NOT be deleted.`,
  ];
}

// ---------------------------------------------------------------------------
// Status normalization (pure apart from the injected `exists` probe)
// ---------------------------------------------------------------------------

function coerceString(value) {
  if (value == null) return "";
  return String(value);
}

function normalizeStatus(raw, spec, options = {}) {
  const exists = options.exists || ((target) => fs.existsSync(target));
  const parsed = (() => {
    if (raw == null) return {};
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return {};
      try {
        return JSON.parse(trimmed);
      } catch {
        return { parseError: "Scheduled task status was not valid JSON." };
      }
    }
    if (typeof raw === "object" && !Array.isArray(raw)) return raw;
    return {};
  })();

  const registered = parsed.exists === true;
  const action = parseActionArguments(registered ? parsed.arguments : spec.argumentString);
  const configPath = action.configPath || spec.configPath;
  const scriptPath = action.file || spec.scriptPath;
  const nodePath = action.nodePath || spec.nodePath;
  const cliPath = action.cliPath || spec.cliPath;
  const logPath = action.logPath || spec.logPath;

  const status = {
    taskName: registered ? coerceString(parsed.taskName) || spec.taskName : spec.taskName,
    taskPath: registered ? coerceString(parsed.taskPath) || spec.taskPath : spec.taskPath,
    supported: parsed.supported !== false,
    exists: registered,
    state: registered ? coerceString(parsed.state) || "unknown" : "not-registered",
    lastRunTime: coerceString(parsed.lastRunTime) || null,
    lastTaskResult: coerceString(parsed.lastTaskResult) || null,
    nextRunTime: coerceString(parsed.nextRunTime) || null,
    principal: {
      userId: registered ? coerceString(parsed.userId) || spec.userId : spec.userId,
      logonType: registered ? coerceString(parsed.logonType) || "unknown" : spec.logonType,
      runLevel: registered ? coerceString(parsed.runLevel) || "unknown" : spec.runLevel,
    },
    action: {
      execute: registered ? coerceString(parsed.execute) || spec.powershellPath : spec.powershellPath,
      arguments: redactText(registered ? coerceString(parsed.arguments) : spec.argumentString),
      scriptPath,
      nodePath,
      cliPath,
    },
    configPath,
    logPath,
    files: {
      script: Boolean(exists(scriptPath)),
      node: Boolean(exists(nodePath)),
      cli: Boolean(exists(cliPath)),
      config: Boolean(exists(configPath)),
      logDirectory: Boolean(exists(path.dirname(logPath))),
      log: Boolean(exists(logPath)),
    },
    error: redactText(coerceString(parsed.error) || coerceString(parsed.parseError)) || null,
  };

  // Defence in depth: nothing token-shaped may reach stdout or a log file, even
  // though nothing we register carries a secret in the first place.
  return redactValue(status);
}

const STATUS_LABEL = {
  script: "startup script",
  node: "node executable",
  cli: "lcr-cli entry point",
  config: "config file",
  logDirectory: "log directory",
  log: "log file",
};

function formatStatus(status) {
  const lines = [];
  lines.push(`Task:      ${status.taskName} (at ${status.taskPath})`);
  if (!status.supported) {
    lines.push(`State:     unsupported — ${status.error || "Task Scheduler is unavailable."}`);
    return lines.join("\n");
  }
  lines.push(`Exists:    ${status.exists ? "yes" : "no"}`);
  lines.push(`State:     ${status.state}`);
  if (status.exists) {
    lines.push(`Last run:  ${status.lastRunTime || "never recorded"}`);
    lines.push(`Last code: ${status.lastTaskResult == null ? "unknown" : status.lastTaskResult}`);
    lines.push(`Next run:  ${status.nextRunTime || "not scheduled"}`);
  }
  lines.push(
    `Principal: ${status.principal.userId} (logon ${status.principal.logonType}, run level ${status.principal.runLevel})`
  );
  lines.push(`Execute:   ${status.action.execute}`);
  lines.push(`Arguments: ${status.action.arguments}`);
  lines.push(`Config:    ${status.configPath}`);
  lines.push(`Log:       ${status.logPath}`);
  const missing = Object.entries(status.files)
    .filter(([, present]) => !present)
    .map(([key]) => STATUS_LABEL[key] || key);
  lines.push(missing.length ? `Missing:   ${missing.join(", ")}` : "Files:     all referenced paths exist");
  if (status.error) lines.push(`Error:     ${status.error}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// PowerShell execution
// ---------------------------------------------------------------------------

// -EncodedCommand carries the multi-line script as UTF-16LE base64, so no shell
// on the way there can reinterpret a quote, a newline, or a path separator.
function runPowerShell(script, options = {}) {
  const executable = options.powershellPath || defaultPowerShellPath();
  const encoded = Buffer.from(String(script), "utf16le").toString("base64");
  const result = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true, encoding: "utf8" }
  );
  if (result.error) {
    return { ok: false, status: null, stdout: "", stderr: "", error: redactText(result.error.message) };
  }
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  return {
    ok: result.status === 0,
    status: result.status,
    stdout,
    stderr,
    error: result.status === 0 ? null : redactText(stderr.trim() || `PowerShell exited with code ${result.status}.`),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function installStartup(options = {}) {
  requireWindows(options.platform);
  const spec = buildTaskSpec(options);
  const dryRun = options.dryRun === true;
  const plan = describeInstall(spec, { dryRun });
  const script = buildRegisterScript(spec);

  if (dryRun) return { action: "install", dryRun: true, changed: false, spec, plan, script };

  const result = (options.runPowerShell || runPowerShell)(script);
  // Redacted again here: runPowerShell already scrubs, but an injected runner
  // must not be able to route a secret into an exception message.
  if (!result.ok) throw new Error(`Could not register the "${spec.taskName}" task: ${redactText(result.error)}`);
  return { action: "install", dryRun: false, changed: true, spec, plan, script };
}

function removeStartup(options = {}) {
  requireWindows(options.platform);
  const spec = buildTaskSpec(options);
  const dryRun = options.dryRun === true;
  const plan = describeRemove(spec, { dryRun });
  const script = buildRemoveScript(spec);

  if (dryRun) return { action: "remove", dryRun: true, changed: false, existed: null, spec, plan, script };

  const result = (options.runPowerShell || runPowerShell)(script);
  if (!result.ok) throw new Error(`Could not remove the "${spec.taskName}" task: ${redactText(result.error)}`);
  const existed = /removed/.test(result.stdout);
  return { action: "remove", dryRun: false, changed: existed, existed, spec, plan, script };
}

function statusStartup(options = {}) {
  requireWindows(options.platform);
  const spec = buildTaskSpec(options);
  const script = buildStatusScript(spec);
  const result = (options.runPowerShell || runPowerShell)(script);
  if (!result.ok) {
    return normalizeStatus(
      { supported: false, exists: false, error: result.error || "Task Scheduler query failed." },
      spec,
      options
    );
  }
  return normalizeStatus(result.stdout, spec, options);
}

module.exports = {
  LOGON_TYPE,
  LOG_FILE_NAME,
  RUNTIME_SCRIPT_NAME,
  RUN_LEVEL,
  TASK_NAME,
  TASK_PATH,
  TRIGGER,
  buildActionArgumentString,
  buildRegisterScript,
  buildRemoveScript,
  buildStatusScript,
  buildTaskSpec,
  defaultLogDirectory,
  defaultPowerShellPath,
  describeInstall,
  describeRemove,
  formatStatus,
  installStartup,
  normalizeStatus,
  parseActionArguments,
  psQuote,
  removeStartup,
  requireWindows,
  runPowerShell,
  statusStartup,
  tokenizeArgumentString,
};
