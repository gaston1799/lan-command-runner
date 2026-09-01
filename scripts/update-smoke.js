const fs = require("node:fs");
const path = require("node:path");
const {
  assert,
  assertEqual,
  createRunner,
  makeTempDir,
  removeTempDir,
  REPO_ROOT,
  runNode,
} = require("./test-helpers");
const { MANAGED_INSTALL_FILE, runUpdate, samePath, updatePlan } = require("../lib/update");

const runner = createRunner("update smoke");

async function main() {
  await runner.test("the managed install path comparison is case-insensitive on Windows", async () => {
    assert(samePath(REPO_ROOT, REPO_ROOT.toUpperCase()), "equivalent Windows paths match");
  });

  await runner.test("dry-run plans an update without starting the installer", async () => {
    const result = runUpdate({
      packageRoot: REPO_ROOT,
      installRoot: REPO_ROOT,
      dryRun: true,
    });
    assertEqual(result.managed, true, "the test root is recognized as managed");
    assertEqual(result.updated, false, "no update ran");
    assertEqual(result.dryRun, true, "the result identifies the dry run");
  });

  await runner.test("an unmanaged source checkout is never replaced", async () => {
    const plan = updatePlan({
      packageRoot: REPO_ROOT,
      installRoot: path.join(REPO_ROOT, "different-managed-root"),
    });
    assertEqual(plan.managed, false, "different roots are unmanaged");
    let message = "";
    try {
      runUpdate({
        packageRoot: REPO_ROOT,
        installRoot: path.join(REPO_ROOT, "different-managed-root"),
        dryRun: true,
      });
    } catch (error) {
      message = error.message;
    }
    assert(/Refusing to replace an unmanaged source checkout/.test(message), "the refusal explains the safety boundary");
  });

  await runner.test("an installer marker recognizes a managed custom root", async () => {
    const root = makeTempDir("managed-update");
    try {
      fs.writeFileSync(
        path.join(root, MANAGED_INSTALL_FILE),
        JSON.stringify({ managed: true, repo: "example/lcr", release: "v1.0.0", commit: "abc" })
      );
      const plan = updatePlan({
        packageRoot: root,
        installRoot: path.join(root, "unrelated-default"),
      });
      assertEqual(plan.managed, true, "the custom root is managed");
      assertEqual(plan.installRoot, root, "the marker keeps updates in the current custom root");
      assertEqual(plan.repo, "example/lcr", "the original repository is retained");
    } finally {
      removeTempDir(root);
    }
  });

  await runner.test("the CLI exposes a non-destructive managed dry run", async () => {
    const result = await runNode(["bin/lcr-cli.js", "update", "--dry-run"], {
      LOCALAPPDATA: path.dirname(REPO_ROOT),
    });
    assertEqual(result.code, 0, `dry run exits successfully: ${result.stderr}`);
    assert(/would update/.test(result.stdout), "the plan is printed");
    assert(/no files were changed/.test(result.stdout), "the no-write guarantee is printed");
  });

  await runner.test("non-interactive updates require explicit confirmation", async () => {
    const result = await runNode(["bin/lcr-cli.js", "update"], {
      LOCALAPPDATA: path.dirname(REPO_ROOT),
    });
    assertEqual(result.code, 1, "an unconfirmed non-interactive update fails");
    assert(/update --yes/.test(result.stderr), "the explicit automation command is provided");
  });

  runner.finish();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
