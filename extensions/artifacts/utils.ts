import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import { ARTIFACT_DIR, MAX_ARTIFACT_BYTES, MAX_INPUT_BYTES } from "./config.js";

const SAFE_SLUG = /^[a-z0-9-]+$/;
const PROTECTED_SEGMENTS = new Set([".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".terraform.d", ".env", "credentials", "secrets", "private"]);
const PROTECTED_NAMES = new Set([
  ".env", ".envrc", "auth.json", "credentials.json", "secrets.json", "token.json",
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", ".npmrc", ".netrc",
]);
const PROTECTED_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".tfstate", ".tfvars"];

function projectRoot(): string {
  return realpathSync(process.cwd());
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hasSymlinkBetween(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function readRegularFile(path: string, maxBytes: number): string {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("file is not a safe regular file");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function assertArtifactDir(create: boolean): string {
  const root = projectRoot();
  const dir = resolve(root, ARTIFACT_DIR);
  let existing = dir;
  while (!existsSync(existing)) {
    const parent = resolve(existing, "..");
    if (parent === existing) throw new Error("could not resolve artifact directory");
    existing = parent;
  }
  if (hasSymlinkBetween(root, dir)) throw new Error("artifact directory contains a symlink");
  const existingReal = realpathSync(existing);
  if (!isWithin(root, existingReal) || lstatSync(existing).isSymbolicLink()) {
    throw new Error("artifact directory would escape the project through a symlink");
  }
  if (create) mkdirSync(dir, { recursive: true });
  if (!existsSync(dir) || !lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
    throw new Error("artifact directory is not a regular directory");
  }
  const dirReal = realpathSync(dir);
  if (!isWithin(root, dirReal) || hasSymlinkBetween(root, dirReal)) {
    throw new Error("artifact directory would escape the project through a symlink");
  }
  return dirReal;
}

export function artifactDir(): string {
  return resolve(projectRoot(), ARTIFACT_DIR);
}

export function ensureArtifactDir(): string {
  return assertArtifactDir(true);
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[\u0027"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "artifact";
}

export function isSafeSlug(slug: string): boolean {
  return Boolean(slug) && SAFE_SLUG.test(slug) && !slug.includes("..");
}

export function artifactPath(slug: string): string {
  if (!isSafeSlug(slug)) throw new Error("invalid artifact slug");
  return join(artifactDir(), `${slug}.html`);
}

export function writeArtifact(slug: string, html: string): string {
  const dir = ensureArtifactDir();
  const path = join(dir, `${slug}.html`);
  if (existsSync(path)) {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
      throw new Error("refusing to overwrite a linked or non-regular artifact");
    }
  }
  const temporary = join(dir, `.${slug}.${randomBytes(12).toString("hex")}.tmp`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(temporary, flags, 0o600);
  try {
    writeFileSync(fd, html, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  return path;
}

export function artifactExists(slug: string): boolean {
  if (!isSafeSlug(slug)) return false;
  try {
    const path = join(assertArtifactDir(false), `${slug}.html`);
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_ARTIFACT_BYTES;
  } catch {
    return false;
  }
}

export interface ArtifactEntry {
  slug: string;
  title: string;
  kind: "markdown" | "html";
  mtime: number;
  absPath: string;
}

export function listArtifacts(): ArtifactEntry[] {
  let dir: string;
  try {
    dir = assertArtifactDir(false);
  } catch {
    return [];
  }
  const entries: ArtifactEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  for (const file of files) {
    if (!/^[-a-z0-9]+\.html$/i.test(file)) continue;
    const absPath = join(dir, file);
    try {
      const stat = lstatSync(absPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
      const content = readRegularFile(absPath, MAX_ARTIFACT_BYTES);
      const slug = file.slice(0, -5);
      const titleMatch = content.match(/<title>(.*?)<\/title>/s);
      const kindMatch = content.match(/<meta name="artifact-kind" content="(.*?)"/);
      const kind = kindMatch?.[1] === "html" ? "html" : "markdown";
      const generated = content.match(/<meta name="artifact-generated" content="(\d+)"/);
      entries.push({
        slug,
        title: titleMatch?.[1]?.trim() || slug,
        kind,
        mtime: generated ? Number(generated[1]) : stat.mtimeMs,
        absPath,
      });
    } catch {
      // Ignore files that disappear or become unreadable while listing.
    }
  }
  return entries.sort((a, b) => b.mtime - a.mtime);
}

export function safeArtifactPath(slug: string): string | null {
  if (!isSafeSlug(slug)) return null;
  try {
    const root = assertArtifactDir(false);
    const path = normalize(join(root, `${slug}.html`));
    if (!isWithin(root, path) || (existsSync(path) && lstatSync(path).isSymbolicLink())) return null;
    return path;
  } catch {
    return null;
  }
}

export function readStoredArtifact(path: string): string | null {
  try {
    return readRegularFile(path, MAX_ARTIFACT_BYTES);
  } catch {
    return null;
  }
}

export function resolveInputPath(rawPath: string, cwd: string): string | null {
  if (!rawPath || rawPath.includes("\0") || rawPath.startsWith("~") || isAbsolute(rawPath)) return null;
  const root = realpathSync(cwd);
  const candidate = resolve(root, rawPath);
  if (!existsSync(candidate)) return null;
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
  if (hasSymlinkBetween(root, candidate)) return null;
  const real = realpathSync(candidate);
  if (!isWithin(root, real)) return null;
  const segments = real.replaceAll(sep, "/").toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment) || segment.startsWith(".env."))) return null;
  const namedSecret = /^(?:credentials|secret|token|client_secret|service-account)(?:[.-]|$)|^firebase-adminsdk-/i.test(basename);
  if (PROTECTED_NAMES.has(basename) || basename.startsWith(".env.") || namedSecret || PROTECTED_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return null;
  if (stat.size > MAX_INPUT_BYTES) return null;
  return real;
}

export function readInputFile(rawPath: string, cwd: string): { content: string } | { error: string } {
  const path = resolveInputPath(rawPath, cwd);
  if (!path) return { error: "path must be a regular, non-sensitive file inside the project (symlinks, hardlinks, and absolute paths are not allowed)." };
  try {
    const content = readRegularFile(path, MAX_INPUT_BYTES);
    if (Buffer.byteLength(content, "utf8") > MAX_INPUT_BYTES) return { error: "file exceeds the 2 MB limit." };
    return { content };
  } catch {
    return { error: "could not read the requested project file as UTF-8." };
  }
}

export function openInBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" })
    .on("error", (err) => console.warn(`openInBrowser: ${cmd} failed: ${err.message}`))
    .unref();
}
