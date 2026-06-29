/** Ephemeral UI banners (merged with server ingest banners in the player). */

let _seq = 0;

export function createClientBanner(level, code, message) {
  _seq += 1;
  return {
    id: `client-${code}-${Date.now()}-${_seq}`,
    level,
    code,
    message,
  };
}

/** Turn a failed regen POST / network error into a user-facing banner message. */
export function formatRegenRequestError(err) {
  const msg = err?.message || "";
  if (err?.name === "TimeoutError" || /signal timed out/i.test(msg)) {
    return "Regen request timed out — the API may be reloading or unreachable.";
  }
  if (/HTTP 404/i.test(msg)) {
    return "Book not found on the server — regen was not started.";
  }
  if (/HTTP 5\d\d/i.test(msg)) {
    return `Server error starting regen (${msg}).`;
  }
  if (/no job id/i.test(msg)) {
    return "Server accepted the request but did not return a job id.";
  }
  return msg || "Could not start image regen.";
}
