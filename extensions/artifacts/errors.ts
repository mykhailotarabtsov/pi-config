const FILESYSTEM_ERROR_CODES = new Set([
  "EACCES", "EEXIST", "EISDIR", "EINVAL", "ELOOP", "EMFILE", "ENAMETOOLONG",
  "ENOENT", "ENOSPC", "ENOTDIR", "EPERM", "EROFS",
]);

export function artifactErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code && FILESYSTEM_ERROR_CODES.has(code)) return fallback;
  return error instanceof Error && error.message ? error.message : fallback;
}
