// Random free-port selection with bind-retry (no scan-then-bind race).
//
// A broker binds a random port in [LCR_PORT_MIN, LCR_PORT_MAX] unless an
// explicit --port is given. Binding IS the collision test, so two brokers can
// never both win the same port.

const DEFAULT_PORT_MIN = 8765;
const DEFAULT_PORT_MAX = 9999;

function parsePortBound(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function portRange() {
  let min = parsePortBound(process.env.LCR_PORT_MIN, DEFAULT_PORT_MIN);
  let max = parsePortBound(process.env.LCR_PORT_MAX, DEFAULT_PORT_MAX);
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

function randomPortIn(range) {
  return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
}

// Binds `server` to `host` on a random free port in `range`, retrying on
// EADDRINUSE. Resolves with the port. Uses the bind itself as the test.
async function listenOnFreePort(server, host, range = portRange(), attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = randomPortIn(range);
    const outcome = await new Promise((resolve) => {
      const onError = (error) => {
        cleanup();
        resolve(error && error.code === "EADDRINUSE" ? "retry" : error);
      };
      const onListening = () => {
        cleanup();
        resolve("ok");
      };
      const cleanup = () => {
        server.removeListener("error", onError);
        server.removeListener("listening", onListening);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(port, host);
      } catch (error) {
        cleanup();
        resolve(error);
      }
    });
    if (outcome === "ok") return port;
    if (outcome !== "retry") {
      throw outcome instanceof Error ? outcome : new Error(String(outcome));
    }
  }
  throw new Error(`Could not bind a free port in ${range.min}-${range.max} after ${attempts} attempts.`);
}

module.exports = {
  DEFAULT_PORT_MAX,
  DEFAULT_PORT_MIN,
  listenOnFreePort,
  portRange,
  randomPortIn,
};
