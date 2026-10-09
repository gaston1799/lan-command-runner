// Wire-protocol versioning and peer-compatibility decisions.
//
// protocolVersion is a plain integer, bumped once per release. A peer's version
// arrives via the `x-lcr-version` header (and is advertised on /broker, /health,
// and the discovery advertisement). It is a capability marker, never a secret.

const PROTOCOL_VERSION = 3; // next release (0.16)
const SIGNING_INTRODUCED_VERSION = 2; // 0.15 added HMAC request signing
const MIN_SUPPORTED_VERSION = 1; // 0.14 (grandfathered: unsigned + bearer)

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value == null ? undefined : value;
  }
  return headers[name] ?? headers[name.toLowerCase()];
}

// Returns the peer's advertised protocol version. A missing header means
// "pre-versioning" (0.14) and is reported as 0.
function parsePeerVersion(reqOrHeaders) {
  const headers =
    reqOrHeaders && reqOrHeaders.headers && typeof reqOrHeaders.headers === "object"
      ? reqOrHeaders.headers
      : reqOrHeaders || {};
  const raw = headerValue(headers, "x-lcr-version");
  if (raw == null || raw === "") return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

// A peer older than the supported window (and not simply "unversioned/0.14").
function peerTooOld(version) {
  return version !== 0 && version < MIN_SUPPORTED_VERSION;
}

// Versions at/after this one must HMAC-sign their requests in token mode.
function peerSupportsSigning(version) {
  return version >= SIGNING_INTRODUCED_VERSION;
}

module.exports = {
  MIN_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  SIGNING_INTRODUCED_VERSION,
  parsePeerVersion,
  peerSupportsSigning,
  peerTooOld,
};
