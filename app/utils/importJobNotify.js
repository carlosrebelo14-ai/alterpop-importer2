const STORAGE_PREFIX = "alterpop_toast_";

export function markImportJobNotified(jobId) {
  if (typeof sessionStorage === "undefined" || !jobId) return;
  sessionStorage.setItem(`${STORAGE_PREFIX}${jobId}`, "1");
}

export function wasImportJobNotified(jobId) {
  if (typeof sessionStorage === "undefined" || !jobId) return false;
  return sessionStorage.getItem(`${STORAGE_PREFIX}${jobId}`) === "1";
}
