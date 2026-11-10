import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { SourceFileSchema } from "./agents/planner.js";
import { RepositorySchema } from "./project-context.js";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 100_000;
const MAX_TOTAL_BYTES = 200_000;
const SAFE_PATH = /\.(?:md|ts|tsx|js|mjs|cjs)$/;
const UNSAFE_PART =
  /^(?:\.env(?:\..*)?|.*(?:credential|secret|token|private.key|\.pem|\.p12|\.pfx).*)$/i;

function checkoutRepository(root: string): string {
  const remote = execFileSync(
    "git",
    ["-C", root, "config", "--get", "remote.origin.url"],
    { encoding: "utf8" },
  ).trim();
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      remote,
    );
  if (!match) throw new Error("Unsupported checkout origin");
  return match[1]!;
}

export function loadRepositoryContext(
  checkoutPath: string,
  repository: string,
  paths: readonly string[],
) {
  RepositorySchema.parse(repository);
  if (
    !paths.length ||
    paths.length > MAX_FILES ||
    new Set(paths).size !== paths.length
  )
    throw new Error("Invalid source file selection");
  const root = realpathSync(resolve(checkoutPath));
  const gitRoot = realpathSync(
    execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim(),
  );
  if (root !== gitRoot || checkoutRepository(root) !== repository)
    throw new Error("Selected checkout repository mismatch");

  let total = 0;
  return paths.map((path) => {
    const parts = path.split("/");
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      !SAFE_PATH.test(path) ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.startsWith(".") ||
          UNSAFE_PART.test(part),
      )
    )
      throw new Error("Unsafe or unsupported source path");
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink())
        throw new Error("Symlink source path rejected");
      if (index === parts.length - 1 && !stat.isFile())
        throw new Error("Unsupported source file type");
    }
    if (!current.startsWith(root + sep))
      throw new Error("Source path outside checkout");
    const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size < 1 ||
        stat.size > MAX_FILE_BYTES ||
        total + stat.size > MAX_TOTAL_BYTES
      )
        throw new Error("Unsupported or oversized source context");
      const bytes = Buffer.alloc(stat.size + 1);
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      total += length;
      if (
        length !== stat.size ||
        total > MAX_TOTAL_BYTES ||
        bytes.subarray(0, length).includes(0)
      )
        throw new Error("Unsupported or oversized source context");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      );
      return SourceFileSchema.parse({ path, content });
    } finally {
      closeSync(fd);
    }
  });
}
