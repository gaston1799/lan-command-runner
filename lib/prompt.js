const readline = require("node:readline");

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Reads a secret with the echo suppressed. Only ever called when stdin is a
// TTY: in a pipeline or a scheduled task there is nobody to answer, so callers
// must fail with instructions rather than block forever on a hidden prompt.
function promptSecret(question) {
  if (!isInteractive()) {
    return Promise.reject(new Error("Cannot prompt for a secret without an interactive terminal."));
  }

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    let muted = false;
    const originalWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = (chunk) => {
      if (muted) return;
      if (originalWrite) originalWrite(chunk);
      else process.stdout.write(chunk);
    };

    rl.on("error", (error) => {
      rl.close();
      reject(error);
    });

    rl.question(question, (answer) => {
      muted = false;
      process.stdout.write("\n");
      rl.close();
      resolve(String(answer || "").trim());
    });
    muted = true;
  });
}

function promptConfirm(question) {
  if (!isInteractive()) {
    return Promise.reject(new Error("Cannot prompt for confirmation without an interactive terminal."));
  }
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.on("error", (error) => {
      rl.close();
      reject(error);
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^(y|yes)$/i.test(String(answer || "").trim()));
    });
  });
}

module.exports = {
  isInteractive,
  promptConfirm,
  promptSecret,
};
