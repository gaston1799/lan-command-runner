// Startup smoke: covers the pure task builders, quoting, redaction, status
// normalization, the Windows-only guard, and both dry runs.
//
// Nothing in this file registers, replaces, or removes a real scheduled task.
// Every effectful path is exercised through an injected `runPowerShell` mock,
// and the two dry-run paths assert the mock is never reached at all.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseArgs, BOOLEAN_FLAGS } = require("../lib/args");
const { saveConfig } = require("../lib/config");
const { generateToken } = require("../lib/server");
const {
  LOGON_TYPE,
  RUN_LEVEL,
  TASK_NAME,
  TASK_PATH,
  buildRegisterScript,
  buildRemoveScript,
  buildStatusScript,
  buildTaskSpec,
  describeInstall,
  describeRemove,
  formatStatus,
  installStartup,
  normalizeStatus,
  parseActionArguments,
  psQuote,
  removeStartup,
  requireWindows,
  statusStartup,
} = require("../lib/startup");
const {
  REPO_ROOT,
  assert,
  assertEqual,
  assertNoSecrets,
  assertThrows,
  createRunner,
  makeTempDir,
  removeTempDir,
  runNode,
} = require("./test-helpers");

const runner = createRunner("startup smoke");

const RUNTIME_SCRIPT = path.join(REPO_ROOT, "scripts", "start-mesh.ps1");
const INSTALLER = path.join(REPO_ROOT, "install.ps1");

// A spec that never touches this machine's real paths, so the pure assertions
// hold identically on Windows and on POSIX.
function fixtureSpec(overrides = {}) {
  return buildTaskSpec({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\o'brien\\lan command runner\\bin\\lcr-cli.js",
    scriptPath: "C:\\Users\\o'brien\\lan command runner\\scripts\\start-mesh.ps1",
    configPath: "C:\\Users\\o'brien\\AppData\\Local\\lan-command-runner\\config.json",
    logDirectory: "C:\\Users\\o'brien\\AppData\\Local\\lan-command-runner\\logs",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    userId: "WORKGROUP\\o'brien",
    ...overrides,
  });
}

function mockPowerShell(response = { ok: true, status: 0, stdout: "registered", stderr: "", error: null }) {
  const calls = [];
  const run = (script) => {
    calls.push(script);
    return response;
  };
  run.calls = calls;
  return run;
}

async function main() {
  const directory = makeTempDir("startup");
  const configPath = path.join(directory, "config.json");
  const brokerToken = generateToken();
  const peerToken = generateToken();
  const secrets = [brokerToken, peerToken];

  saveConfig(
    {
      version: 2,
      node: { id: "startup-node", name: "Startup Node" },
      broker: { host: "127.0.0.1", port: 18801, token: brokerToken },
      peers: { alpha: { url: "http://127.0.0.1:18802", token: peerToken, enabled: true } },
      discovery: { enabled: true, port: 18803 },
    },
    configPath
  );

  try {
    // ---------------------------------------------------------------- spec ---
    await runner.test("the task specification is exact and unprivileged", async () => {
      const spec = fixtureSpec();
      assertEqual(spec.taskName, "LAN Command Runner Mesh", "the documented task name");
      assertEqual(spec.taskName, TASK_NAME, "the exported constant matches");
      assertEqual(spec.taskPath, TASK_PATH, "registered in the root task folder");
      assertEqual(spec.runLevel, "Limited", "run level is Limited, never Highest");
      assertEqual(spec.runLevel, RUN_LEVEL, "the exported run level matches");
      assertEqual(spec.logonType, "Interactive", "interactive logon needs no stored password");
      assertEqual(spec.logonType, LOGON_TYPE, "the exported logon type matches");
      assertEqual(spec.trigger, "AtLogOn", "triggered at logon");
      assertEqual(spec.userId, "WORKGROUP\\o'brien", "registered for the current user only");
      assert(/powershell\.exe$/i.test(spec.powershellPath), "the action executes PowerShell");
    });

    await runner.test("the action runs PowerShell hidden and hands the repo script every path", async () => {
      const spec = fixtureSpec();
      const argv = spec.argumentArray;
      assertEqual(argv[argv.indexOf("-WindowStyle") + 1], "Hidden", "PowerShell runs hidden");
      assert(argv.includes("-NoProfile"), "no profile is loaded");
      assert(argv.includes("-NonInteractive"), "the task never expects a console");
      assertEqual(argv[argv.indexOf("-File") + 1], spec.scriptPath, "-File targets the installed repo script");
      assert(/scripts[\\/]start-mesh\.ps1$/.test(spec.scriptPath), "the repo script is scripts/start-mesh.ps1");
      assertEqual(argv[argv.indexOf("-ConfigPath") + 1], spec.configPath, "the config path is passed explicitly");
      assertEqual(argv[argv.indexOf("-NodePath") + 1], spec.nodePath, "the absolute node path is passed explicitly");
      assertEqual(argv[argv.indexOf("-CliPath") + 1], spec.cliPath, "the absolute cli path is passed explicitly");
      assertEqual(argv[argv.indexOf("-LogPath") + 1], spec.logPath, "the append log path is passed explicitly");
      assert(spec.logPath.startsWith(spec.logDirectory), "the log lives in the normal LCR logs directory");
      assert(/[\\/]logs[\\/]mesh\.log$/.test(spec.logPath), "the log file is logs/mesh.log");
    });

    await runner.test("the default spec uses this machine's absolute node and cli paths", async () => {
      const spec = buildTaskSpec({ configPath, userId: "TESTHOST\\tester" });
      assertEqual(spec.nodePath, process.execPath, "the current node executable, absolute");
      assertEqual(spec.cliPath, path.join(REPO_ROOT, "bin", "lcr-cli.js"), "bin/lcr-cli.js, absolute");
      assertEqual(spec.scriptPath, RUNTIME_SCRIPT, "scripts/start-mesh.ps1, absolute");
      assertEqual(spec.configPath, path.resolve(configPath), "the selected config path, absolute");
      assert(path.isAbsolute(spec.logPath), "the log path is absolute");
    });

    // ------------------------------------------------------------ quoting ---
    await runner.test("every path in the argument string is quoted and round-trips", async () => {
      const spec = fixtureSpec();
      for (const value of [spec.scriptPath, spec.configPath, spec.nodePath, spec.cliPath, spec.logPath]) {
        assert(spec.argumentString.includes(`"${value}"`), `${value} is double-quoted in the argument string`);
      }
      assert(spec.argumentString.includes("-WindowStyle"), "switch names stay bare");

      const parsed = parseActionArguments(spec.argumentString);
      assertEqual(parsed.file, spec.scriptPath, "the script path survives quoting");
      assertEqual(parsed.configPath, spec.configPath, "the config path survives quoting");
      assertEqual(parsed.nodePath, spec.nodePath, "the node path survives quoting");
      assertEqual(parsed.cliPath, spec.cliPath, "the cli path survives quoting");
      assertEqual(parsed.logPath, spec.logPath, "the log path survives quoting");
    });

    await runner.test("PowerShell single-quote escaping is robust", async () => {
      assertEqual(psQuote("plain"), "'plain'", "a plain value is single quoted");
      assertEqual(psQuote("o'brien"), "'o''brien'", "an embedded single quote is doubled");
      assertEqual(psQuote("$env:LCR_TOKEN`x"), "'$env:LCR_TOKEN`x'", "no expansion inside a single-quoted literal");

      // A path containing a single quote must survive into the generated script
      // as a doubled-quote literal, not as a string terminator.
      const script = buildRegisterScript(fixtureSpec());
      assert(script.includes("C:\\Users\\o''brien"), "paths with a quote are escaped by doubling");
      assert(!/'C:\\Users\\o'brien/.test(script), "the raw single quote never terminates the literal early");
    });

    await runner.test("a path that cannot be quoted unambiguously is refused", async () => {
      assertThrows(
        () => fixtureSpec({ configPath: 'C:\\bad"path\\config.json' }),
        /double quote/i,
        "a double quote in a path is rejected"
      );
      assertThrows(
        () => fixtureSpec({ logDirectory: "C:\\bad\nlogs" }),
        /line break/i,
        "a line break in a path is rejected"
      );
      assertThrows(() => fixtureSpec({ userId: "" }), /current user id is empty/i, "an unknown user is rejected");
    });

    // ------------------------------------------------------------ scoping ---
    await runner.test("install replaces only this exact task and is idempotent", async () => {
      const script = buildRegisterScript(fixtureSpec());
      assert(script.includes(`$taskName = ${psQuote(TASK_NAME)}`), "the exact task name is pinned");
      assert(script.includes(`$taskPath = ${psQuote(TASK_PATH)}`), "the exact task path is pinned");
      assert(
        /Register-ScheduledTask -TaskName \$taskName -TaskPath \$taskPath\b/.test(script),
        "registration is scoped by name and path"
      );
      assert(/-Force\b/.test(script), "-Force makes a repeat install idempotent rather than an error");
      assert(/-RunLevel Limited\b/.test(script), "run level is Limited");
      assert(!/-RunLevel Highest/i.test(script), "run level is never Highest");
      assert(!/\bSYSTEM\b/.test(script), "SYSTEM is never named");
      assert(!/-LogonType (S4U|Password|ServiceAccount)/i.test(script), "no password-bearing logon type is used");
      assert(!/-Password\b/i.test(script), "no password is supplied");
      assert(!/\*/.test(script), "no wildcard can widen the scope");
    });

    await runner.test("remove deletes only this exact task and no configuration", async () => {
      const spec = fixtureSpec();
      const script = buildRemoveScript(spec);
      assert(script.includes("$_.TaskName -eq $taskName"), "the match is an exact name equality, not a prefix");
      assert(
        /Unregister-ScheduledTask -TaskName \$taskName -TaskPath \$taskPath -Confirm:\$false/.test(script),
        "unregistration is scoped by name and path"
      );
      assert(!/\*/.test(script), "no wildcard can widen the scope");
      assert(!/Remove-Item/i.test(script), "no file is deleted");
      assert(!script.includes(spec.configPath), "the config path is never touched by remove");
      assert(!script.includes(spec.logPath), "the log path is never touched by remove");
      assert(/if \(-not \$task\) \{ Write-Output 'missing'/.test(script), "an absent task is reported, not an error");
    });

    await runner.test("status queries only this exact task", async () => {
      const script = buildStatusScript(fixtureSpec());
      assert(script.includes("$_.TaskName -eq $taskName"), "the query is scoped by exact name");
      assert(/Get-ScheduledTaskInfo -TaskName \$taskName -TaskPath \$taskPath/.test(script), "task info is scoped too");
      assert(/ConvertTo-Json/.test(script), "status is emitted as JSON for stable parsing");
      assert(!/Register-ScheduledTask|Unregister-ScheduledTask|Remove-Item|Set-Content/i.test(script), "status is read-only");
    });

    // ---------------------------------------------------------- redaction ---
    await runner.test("no token appears in the task, the generated scripts, or the plan", async () => {
      const spec = buildTaskSpec({ configPath, userId: "TESTHOST\\tester" });
      const surfaces = [
        spec.argumentString,
        spec.argumentArray.join(" "),
        buildRegisterScript(spec),
        buildRemoveScript(spec),
        buildStatusScript(spec),
        describeInstall(spec, { dryRun: true }).join("\n"),
        describeRemove(spec, { dryRun: true }).join("\n"),
        fs.readFileSync(RUNTIME_SCRIPT, "utf8"),
      ].join("\n");

      assertNoSecrets(surfaces, secrets, "startup task surface");
      assert(!/--token|-Token\b|LCR_TOKEN/.test(surfaces), "no token flag or token env var is referenced anywhere");
      assert(/LCR_CONFIG/.test(buildRegisterScript(spec)) === false, "the task command line sets nothing itself");
      assert(fs.readFileSync(RUNTIME_SCRIPT, "utf8").includes("$env:LCR_CONFIG = $ConfigPath"), "only LCR_CONFIG is set");
    });

    await runner.test("status output is redacted even if a task argument carries a secret", async () => {
      const spec = fixtureSpec();
      const status = normalizeStatus(
        {
          supported: true,
          exists: true,
          taskName: TASK_NAME,
          taskPath: TASK_PATH,
          state: "Ready",
          userId: spec.userId,
          logonType: "Interactive",
          runLevel: "Limited",
          execute: spec.powershellPath,
          arguments: `${spec.argumentString} -Token ${brokerToken}`,
          lastRunTime: "2026-07-29T09:00:00.0000000+00:00",
          lastTaskResult: "0",
          nextRunTime: "",
        },
        spec,
        { exists: () => true }
      );
      assertNoSecrets(JSON.stringify(status), secrets, "startup status payload");
      assertNoSecrets(formatStatus(status), secrets, "formatted startup status");
      assert(/<redacted>/.test(status.action.arguments), "the secret-shaped argument is replaced");
    });

    // -------------------------------------------------- status normalizing ---
    await runner.test("an unregistered task normalizes to a complete, honest report", async () => {
      const spec = fixtureSpec();
      const status = normalizeStatus('{"supported":true,"exists":false}', spec, { exists: () => false });
      assertEqual(status.exists, false, "absence is reported");
      assertEqual(status.supported, true, "Task Scheduler was available");
      assertEqual(status.state, "not-registered", "state is explicit rather than blank");
      assertEqual(status.taskName, TASK_NAME, "the task name we would use is still reported");
      assertEqual(status.principal.runLevel, "Limited", "the run level we would use is reported");
      assertEqual(status.action.execute, spec.powershellPath, "the action target we would use is reported");
      assertEqual(status.configPath, spec.configPath, "the config path we would use is reported");
      assertEqual(status.logPath, spec.logPath, "the log path we would use is reported");
      assertEqual(status.files.config, false, "a missing referenced file is reported as missing");
      assertEqual(status.lastRunTime, null, "no last run time is invented");
      assert(/Missing:/.test(formatStatus(status)), "the human output names what is missing");
    });

    await runner.test("a registered task reports state, timing, principal, and file existence", async () => {
      const spec = fixtureSpec();
      const status = normalizeStatus(
        JSON.stringify({
          supported: true,
          exists: true,
          taskName: TASK_NAME,
          taskPath: TASK_PATH,
          state: "Running",
          userId: spec.userId,
          logonType: "Interactive",
          runLevel: "Limited",
          execute: spec.powershellPath,
          arguments: spec.argumentString,
          lastRunTime: "2026-07-29T09:00:00.0000000+00:00",
          lastTaskResult: "267009",
          nextRunTime: "2026-07-30T09:00:00.0000000+00:00",
        }),
        spec,
        { exists: (target) => target !== spec.logPath }
      );
      assertEqual(status.exists, true, "presence is reported");
      assertEqual(status.state, "Running", "the live state is passed through");
      assertEqual(status.lastRunTime, "2026-07-29T09:00:00.0000000+00:00", "last run time is reported");
      assertEqual(status.lastTaskResult, "267009", "last result is reported");
      assertEqual(status.nextRunTime, "2026-07-30T09:00:00.0000000+00:00", "next run time is reported");
      assertEqual(status.principal.logonType, "Interactive", "principal logon type is reported");
      assertEqual(status.principal.runLevel, "Limited", "principal run level is reported");
      assertEqual(status.action.scriptPath, spec.scriptPath, "the action target is parsed out of the registration");
      assertEqual(status.files.log, false, "the not-yet-created log is reported as missing");
      assertEqual(status.files.config, true, "an existing referenced file is reported as present");
    });

    await runner.test("status reports the config actually registered, not the current default", async () => {
      const spec = fixtureSpec();
      const stale = fixtureSpec({ configPath: "D:\\old location\\config.json" });
      const status = normalizeStatus(
        JSON.stringify({ supported: true, exists: true, arguments: stale.argumentString, state: "Ready" }),
        spec,
        { exists: () => true }
      );
      assertEqual(status.configPath, "D:\\old location\\config.json", "the registered config path wins");
    });

    await runner.test("unavailable or unparsable status degrades instead of throwing", async () => {
      const spec = fixtureSpec();
      const unsupported = normalizeStatus(
        '{"supported":false,"exists":false,"error":"The ScheduledTasks PowerShell module is unavailable on this system."}',
        spec,
        { exists: () => false }
      );
      assertEqual(unsupported.supported, false, "lack of Task Scheduler is reported");
      assert(/unsupported/.test(formatStatus(unsupported)), "the human output says so");

      const garbage = normalizeStatus("not json at all", spec, { exists: () => false });
      assertEqual(garbage.exists, false, "unparsable output is not read as a registered task");
      assert(/not valid JSON/.test(garbage.error), "the parse failure is surfaced");

      const empty = normalizeStatus("", spec, { exists: () => false });
      assertEqual(empty.exists, false, "empty output is not read as a registered task");
    });

    // ------------------------------------------------------ windows guard ---
    await runner.test("every startup command is refused off Windows with a clear message", async () => {
      const notWindows = { platform: "linux", configPath, userId: "TESTHOST\\tester" };
      assertThrows(() => requireWindows("linux"), /Windows-only/, "the guard names the constraint");
      assertThrows(() => requireWindows("darwin"), /Windows-only/, "macOS is refused too");
      requireWindows("win32");

      for (const [name, fn] of [
        ["install", installStartup],
        ["remove", removeStartup],
        ["status", statusStartup],
      ]) {
        const error = assertThrows(() => fn(notWindows), /Windows-only/, `${name} is refused off Windows`);
        assert(/systemd|launchd/.test(error.message), `${name} suggests the platform-native alternative`);
      }

      // The guard runs before anything else, including the dry-run short circuit.
      assertThrows(() => installStartup({ ...notWindows, dryRun: true }), /Windows-only/, "even a dry run is refused");
    });

    // ----------------------------------------------------------- dry runs ---
    await runner.test("install --dry-run registers nothing and writes nothing", async () => {
      const run = mockPowerShell();
      const logDirectory = path.join(directory, "dry-run-logs");
      const result = installStartup({
        platform: "win32",
        dryRun: true,
        runPowerShell: run,
        configPath,
        logDirectory,
        userId: "TESTHOST\\tester",
      });

      assertEqual(run.calls.length, 0, "PowerShell is never invoked");
      assertEqual(result.dryRun, true, "the result is marked as a dry run");
      assertEqual(result.changed, false, "nothing changed");
      assertEqual(fs.existsSync(logDirectory), false, "the log directory is not created");

      const plan = result.plan.join("\n");
      assert(plan.includes(TASK_NAME), "the plan names the exact task");
      assert(plan.includes(result.spec.powershellPath), "the plan names the action executable");
      assert(plan.includes(result.spec.scriptPath), "the plan names the runtime script");
      assert(plan.includes(path.resolve(configPath)), "the plan names the config path");
      assert(plan.includes(result.spec.logPath), "the plan names the append log path");
      assert(/would be created at run time/.test(plan), "the plan says the log directory is not created yet");
      assert(/would be replaced/.test(plan), "the plan says the task would be replaced");
      assert(/run level Limited/.test(plan), "the plan states the run level");
      assert(/No token/.test(plan) && /No password/.test(plan), "the plan states the safety properties");
      assertNoSecrets(plan, secrets, "install dry-run plan");
    });

    await runner.test("remove --dry-run unregisters nothing and touches no configuration", async () => {
      const run = mockPowerShell({ ok: true, status: 0, stdout: "removed", stderr: "", error: null });
      const result = removeStartup({
        platform: "win32",
        dryRun: true,
        runPowerShell: run,
        configPath,
        userId: "TESTHOST\\tester",
      });

      assertEqual(run.calls.length, 0, "PowerShell is never invoked");
      assertEqual(result.changed, false, "nothing changed");
      assertEqual(fs.existsSync(configPath), true, "the config file is still there");

      const plan = result.plan.join("\n");
      assert(plan.includes(TASK_NAME), "the plan names the exact task");
      assert(/exact name match only/.test(plan), "the plan states the scoping");
      assert(/NOT be read, modified, or deleted/.test(plan), "the plan states the config is untouched");
      assert(/NOT be deleted/.test(plan), "the plan states the log is untouched");
      assertNoSecrets(plan, secrets, "remove dry-run plan");
    });

    // -------------------------------------------------- mocked effectful ---
    await runner.test("a non-dry install hands exactly one register script to PowerShell", async () => {
      const run = mockPowerShell();
      const result = installStartup({
        platform: "win32",
        runPowerShell: run,
        configPath,
        userId: "TESTHOST\\tester",
      });
      assertEqual(run.calls.length, 1, "one PowerShell invocation");
      assertEqual(run.calls[0], buildRegisterScript(result.spec), "the exact register script is what runs");
      assertEqual(result.changed, true, "the result reports the change");
      assertNoSecrets(run.calls[0], secrets, "register script");
    });

    await runner.test("a non-dry remove distinguishes removed from never-registered", async () => {
      const removed = removeStartup({
        platform: "win32",
        runPowerShell: mockPowerShell({ ok: true, status: 0, stdout: "removed\r\n", stderr: "", error: null }),
        configPath,
        userId: "TESTHOST\\tester",
      });
      assertEqual(removed.existed, true, "an existing task is reported as removed");

      const missing = removeStartup({
        platform: "win32",
        runPowerShell: mockPowerShell({ ok: true, status: 0, stdout: "missing\r\n", stderr: "", error: null }),
        configPath,
        userId: "TESTHOST\\tester",
      });
      assertEqual(missing.existed, false, "an absent task is reported as absent");
      assertEqual(missing.changed, false, "nothing changed");
    });

    await runner.test("a PowerShell failure surfaces as a clear, redacted error", async () => {
      const failing = mockPowerShell({
        ok: false,
        status: 1,
        stdout: "",
        stderr: "",
        error: `Access is denied. token=${brokerToken}`,
      });
      const error = assertThrows(
        () => installStartup({ platform: "win32", runPowerShell: failing, configPath, userId: "TESTHOST\\tester" }),
        /Could not register/,
        "a registration failure is reported"
      );
      assert(error.message.includes(TASK_NAME), "the error names the task");
      assertNoSecrets(error.message, secrets, "install failure message");

      assertThrows(
        () => removeStartup({ platform: "win32", runPowerShell: failing, configPath, userId: "TESTHOST\\tester" }),
        /Could not remove/,
        "a removal failure is reported"
      );

      // A failed query must degrade to an "unsupported" report, not an exception.
      const status = statusStartup({
        platform: "win32",
        runPowerShell: failing,
        configPath,
        userId: "TESTHOST\\tester",
        exists: () => false,
      });
      assertEqual(status.supported, false, "a failed query is reported as unsupported");
      assertNoSecrets(JSON.stringify(status), secrets, "failed status payload");
    });

    await runner.test("statusStartup normalizes real PowerShell JSON through the mock", async () => {
      const spec = buildTaskSpec({ configPath, userId: "TESTHOST\\tester" });
      const status = statusStartup({
        platform: "win32",
        configPath,
        userId: "TESTHOST\\tester",
        exists: () => true,
        runPowerShell: mockPowerShell({
          ok: true,
          status: 0,
          stdout: `${JSON.stringify({
            supported: true,
            exists: true,
            taskName: TASK_NAME,
            taskPath: TASK_PATH,
            state: "Ready",
            userId: "TESTHOST\\tester",
            logonType: "Interactive",
            runLevel: "Limited",
            execute: spec.powershellPath,
            arguments: spec.argumentString,
            lastRunTime: "2026-07-29T09:00:00.0000000+00:00",
            lastTaskResult: "0",
            nextRunTime: "",
          })}\r\n`,
          stderr: "",
          error: null,
        }),
      });
      assertEqual(status.exists, true, "the registered task is detected");
      assertEqual(status.state, "Ready", "state passes through");
      assertEqual(status.configPath, path.resolve(configPath), "the registered config path is reported");
      assertEqual(status.nextRunTime, null, "an empty next run time is null, not an empty string");
    });

    // ---------------------------------------------------------------- args ---
    await runner.test("--dry-run is a known boolean flag", async () => {
      assert(BOOLEAN_FLAGS.has("dry-run"), "dry-run is registered as a boolean flag");
      assertEqual(parseArgs(["install", "--dry-run"])["dry-run"], true, "a bare --dry-run is true");
      assertEqual(parseArgs(["install", "--dry-run"])._[0], "install", "the subcommand is not swallowed");
      assertEqual(parseArgs(["--dry-run", "install"])._[0], "install", "a trailing subcommand is not swallowed");
      assertEqual(parseArgs(["--dry-run=false"])["dry-run"], false, "--dry-run=false is honoured");
      assertThrows(() => parseArgs(["--dry-run=maybe"]), /boolean flag/, "a non-boolean value is refused");
    });

    // ---------------------------------------------------- runtime script ---
    await runner.test("the runtime script takes explicit paths and validates them", async () => {
      const source = fs.readFileSync(RUNTIME_SCRIPT, "utf8");
      for (const parameter of ["$ConfigPath", "$NodePath", "$CliPath", "$LogPath"]) {
        assert(new RegExp(`Mandatory = \\$true\\)\\]\\[string\\]\\${parameter}`).test(source), `${parameter} is a mandatory parameter`);
      }
      assert(/Assert-MeshPath "Node executable" \$NodePath/.test(source), "NodePath is validated");
      assert(/Assert-MeshPath "lcr-cli entry point" \$CliPath/.test(source), "CliPath is validated");
      assert(/Assert-MeshPath "LCR config" \$ConfigPath/.test(source), "ConfigPath is validated");
      assert(/New-Item -ItemType Directory -Force -Path \$logDirectory/.test(source), "the log directory is created");
      assert(/\$env:LCR_CONFIG = \$ConfigPath/.test(source), "LCR_CONFIG is set from the parameter");
      assert(source.match(/\$env:[A-Za-z_]+\s*=/g).length === 1, "LCR_CONFIG is the only env var set");
      assert(/& \$NodePath \$CliPath mesh/.test(source), "node runs the cli with `mesh`");
      assert(/Add-Content -LiteralPath \$LogPath/.test(source), "logging is append-only");
      assert(!/Set-Content -LiteralPath \$LogPath|Out-File/.test(source), "the log is never truncated");
      assert(!/Get-Content[^\n]*ConfigPath/.test(source), "the config contents are never read or printed");
      assert(/contents not logged/.test(source), "the script states it does not log config contents");
    });

    await runner.test("the runtime script parses as PowerShell", async () => {
      if (process.platform !== "win32") return;
      const probe = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `try { [scriptblock]::Create((Get-Content -LiteralPath ${psQuote(RUNTIME_SCRIPT)} -Raw)) | Out-Null; 'OK' } catch { "FAIL: $($_.Exception.Message)" }`,
        ],
        { encoding: "utf8", windowsHide: true }
      );
      assert(/OK/.test(String(probe.stdout || "")), `start-mesh.ps1 parses: ${probe.stdout} ${probe.stderr}`);
    });

    // ------------------------------------------------------------ installer ---
    await runner.test("the installer preserves known runtime state across an upgrade", async () => {
      const source = fs.readFileSync(INSTALLER, "utf8");
      const fileList = /\$PreservedFiles = @\((.*)\)/.exec(source);
      const directoryList = /\$PreservedDirectories = @\((.*)\)/.exec(source);
      assert(fileList, "the installer declares an explicit preserved-file list");
      assert(directoryList, "the installer declares an explicit preserved-directory list");

      for (const name of ["config.json", "tray-settings.json", ".lcr-token"]) {
        assert(fileList[1].includes(`"${name}"`), `${name} is preserved`);
      }
      assert(directoryList[1].includes('"logs"'), "logs/ is preserved");
      assert(!/[*?]/.test(fileList[1] + directoryList[1]), "the preserve lists contain no wildcard");
      assert(!/\.js"|\.json"\s*,\s*"package/.test(fileList[1].replace('"config.json"', "")), "no source file is preserved");
      for (const name of ["package.json", "package-lock.json", "bin", "lib", "scripts"]) {
        assert(!fileList[1].includes(`"${name}"`), `${name} is never preserved`);
      }

      const backup = source.indexOf("Backup-LcrRuntimeState $InstallRoot $preserveRoot");
      const deletion = source.indexOf("Remove-Item -LiteralPath $InstallRoot -Recurse -Force");
      const move = source.indexOf("Move-Item -LiteralPath $sourceDir -Destination $InstallRoot");
      const restore = source.indexOf("Restore-LcrRuntimeState $InstallRoot $preserveRoot");
      assert(backup > -1 && deletion > -1 && move > -1 && restore > -1, "backup, delete, move, and restore all exist");
      assert(backup < deletion, "state is backed up before InstallRoot is deleted");
      assert(move < restore, "state is restored after the new source is moved in");
      assert(/git clone/.test(source), "the installer retains Git metadata by cloning the release tag");
      assert(/Test-Path.+["']\.git/.test(source), "the installer verifies that Git metadata was created");
      assert(/\.lcr-managed-install\.json/.test(source), "the installer marks managed custom roots for safe self-update");
    });

    await runner.test("the installer backup is unique, outside InstallRoot, and retained if rollback fails", async () => {
      const source = fs.readFileSync(INSTALLER, "utf8");
      assert(
        /\$preserveRoot = Join-Path \(\[System\.IO\.Path\]::GetTempPath\(\)\) \("lan-command-runner-preserve-" \+ \[guid\]::NewGuid\(\)/.test(
          source
        ),
        "the backup directory is a unique temp path outside InstallRoot"
      );
      const finallyIndex = source.lastIndexOf("} finally {");
      assert(finallyIndex > -1, "the installer still has a finally block");
      const finallyBlock = source.slice(finallyIndex);
      assert(
        /if \(!\$preserved -or \$stateRestored\)/.test(finallyBlock) &&
          /Remove-Item -LiteralPath \$preserveRoot -Recurse -Force -ErrorAction SilentlyContinue/.test(finallyBlock),
        "the backup is removed only when no state was preserved or restoration succeeded"
      );
      assert(
        /Recovery backup retained at \$preserveRoot/.test(finallyBlock),
        "the recovery path is reported when the backup cannot safely be deleted"
      );
      const restore = source.indexOf("Restore-LcrRuntimeState $InstallRoot $preserveRoot");
      const catchIndex = source.indexOf("} catch {\n  $installError = $_");
      assert(catchIndex > restore, "the installer has a rollback catch after the normal restore");
      const rollbackBlock = source.slice(catchIndex, finallyIndex);
      assert(
        /Restore-LcrRuntimeState \$InstallRoot \$preserveRoot \$preservedConfigAcl/.test(rollbackBlock),
        "an install failure attempts to restore the allowlisted runtime state"
      );
      assert(
        /automatic state restore both failed/.test(rollbackBlock) &&
          /previous config, tokens, settings, and logs remain at/.test(rollbackBlock),
        "a failed rollback retains and reports the only recovery copy"
      );
    });

    await runner.test("the installer never copies arbitrary source out of InstallRoot", async () => {
      const source = fs.readFileSync(INSTALLER, "utf8");
      assert(!/Copy-Item -LiteralPath \$InstallRoot\b/.test(source), "InstallRoot itself is never copied");
      assert(!/Copy-Item[^\n]*\*/.test(source), "no copy uses a wildcard source");
      assert(!/Get-ChildItem -LiteralPath \$InstallRoot/.test(source), "InstallRoot is never enumerated for preservation");
      assert(!/\*\.js|\*\.json/.test(source), "no source-file glob appears anywhere");
      // Copies are driven only by the two explicit allowlists.
      const copies = source.match(/Copy-Item[^\n]*/g) || [];
      assertEqual(copies.length, 4, "exactly four copies: two backups and two restores");
      for (const copy of copies) {
        assert(/\$source/.test(copy), "every copy reads from an allowlisted $source");
      }
      assert(!/Get-Content[^\n]*(config\.json|\$source|\$destination)/.test(source), "preserved contents are never printed");
    });

    await runner.test("the installer secures the temporary credential backup before deleting InstallRoot", async () => {
      const source = fs.readFileSync(INSTALLER, "utf8");
      assert(/function Protect-LcrRuntimeBackup\(\$Backup\)/.test(source), "a dedicated backup ACL helper exists");
      assert(/\/inheritance:r/.test(source) && /\/grant:r/.test(source), "Windows inheritance is removed and access is replaced");
      assert(/\(OI\)\(CI\)F/.test(source), "the current-user grant covers files and directories");
      const firstProtect = source.indexOf("Protect-LcrRuntimeBackup $Backup");
      const firstCopy = source.indexOf("Copy-Item -LiteralPath $source");
      const lastProtect = source.lastIndexOf("Protect-LcrRuntimeBackup $Backup");
      const deletion = source.indexOf("Remove-Item -LiteralPath $InstallRoot -Recurse -Force");
      assert(firstProtect > -1 && firstProtect < firstCopy, "the empty backup directory is secured before secrets are copied");
      assert(lastProtect > firstCopy && lastProtect < deletion, "copied children are secured before InstallRoot is removed");
    });

    await runner.test("a custom InstallRoot still works and still gets preservation", async () => {
      const source = fs.readFileSync(INSTALLER, "utf8");
      assert(/\[string\]\$InstallRoot = \$env:LCR_INSTALL_ROOT/.test(source), "LCR_INSTALL_ROOT still overrides the root");
      assert(
        /\$InstallRoot = Join-Path \$env:LOCALAPPDATA "lan-command-runner"/.test(source),
        "the default root is unchanged"
      );
      // Preservation is keyed off $InstallRoot, so a custom root is covered by
      // the same code path with no special case.
      assert(
        /function Backup-LcrRuntimeState\(\$Root, \$Backup\)/.test(source),
        "the backup helper takes the root as a parameter"
      );
      assert(!/LOCALAPPDATA[^\n]*Backup|Backup[^\n]*LOCALAPPDATA/.test(source), "preservation is not hardcoded to LOCALAPPDATA");
    });

    await runner.test("the installer guidance points at the mesh workflow without configuring it", async () => {
      const source = fs.readFileSync(INSTALLER, "utf8");
      for (const hint of ["lcr-cli mesh init", "lcr-cli mesh", "lcr-cli peer add", "lcr-cli doctor", "lcr-cli startup install"]) {
        assert(source.includes(hint), `the guidance mentions ${hint}`);
      }
      assert(/does not configure the mesh or register startup/.test(source), "the installer disclaims auto-configuration");
      // Guidance only: the installer must never actually run these.
      assert(!/^\s*(lcr-cli|lcr)\s/m.test(source.replace(/Write-Host[^\n]*/g, "")), "no lcr command is executed");
      assert(!/Register-ScheduledTask|schtasks/i.test(source), "the installer never registers a task");
    });

    // ----------------------------------------------------------------- cli ---
    await runner.test("the CLI exposes startup install, remove, and status", async () => {
      const help = await runNode(["bin/lcr-cli.js", "--help"]);
      assert(/lcr-cli startup install \[--dry-run\]/.test(help.stdout), "install is documented");
      assert(/lcr-cli startup remove \[--dry-run\]/.test(help.stdout), "remove is documented");
      assert(/lcr-cli startup status \[--json\]/.test(help.stdout), "status is documented");
      assert(/current user only/.test(help.stdout), "the help states the privilege model");
    });

    await runner.test("the CLI dry runs are safe on any platform", async () => {
      const env = { LCR_CONFIG: configPath, LCR_TOKEN: "" };
      const install = await runNode(["bin/lcr-cli.js", "startup", "install", "--dry-run"], env);
      const remove = await runNode(["bin/lcr-cli.js", "startup", "remove", "--dry-run"], env);
      const combined = install.stdout + install.stderr + remove.stdout + remove.stderr;
      assertNoSecrets(combined, secrets, "startup CLI dry-run output");

      if (process.platform !== "win32") {
        assertEqual(install.code, 1, "install is refused off Windows");
        assert(/Windows-only/.test(install.stderr), "the refusal explains why");
        assertEqual(remove.code, 1, "remove is refused off Windows");
        return;
      }

      assertEqual(install.code, 0, `install --dry-run succeeds: ${install.stderr}`);
      assert(/dry run: nothing was written/.test(install.stdout), "the dry run says it changed nothing");
      assert(install.stdout.includes(TASK_NAME), "the dry run names the exact task");
      assert(/run level Limited/.test(install.stdout), "the dry run states the run level");
      assertEqual(remove.code, 0, `remove --dry-run succeeds: ${remove.stderr}`);
      assert(/dry run: no scheduled task was removed/.test(remove.stdout), "the remove dry run changed nothing");

      const bad = await runNode(["bin/lcr-cli.js", "startup", "explode"], env);
      assertEqual(bad.code, 1, "an unknown subcommand fails");
      assert(/Unknown startup subcommand/.test(bad.stderr), "the error names the problem");
    });
  } finally {
    removeTempDir(directory);
  }

  runner.finish();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
