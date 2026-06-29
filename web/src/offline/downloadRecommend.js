/** Per-book "save .vaepack to device?" prompt — Skip remembers choice. */

const PREFIX = "vae-dl-skip-";

export function shouldRecommendDownload(bookId) {
  if (!bookId || typeof localStorage === "undefined") return false;
  return localStorage.getItem(`${PREFIX}${bookId}`) !== "1";
}

export function skipDownloadRecommend(bookId) {
  if (!bookId || typeof localStorage === "undefined") return;
  localStorage.setItem(`${PREFIX}${bookId}`, "1");
}

export function clearDownloadRecommendSkip(bookId) {
  if (!bookId || typeof localStorage === "undefined") return;
  localStorage.removeItem(`${PREFIX}${bookId}`);
}
