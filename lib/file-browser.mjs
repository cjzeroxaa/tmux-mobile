import path from "node:path";

const EXCLUDED_NAMES = new Set([".git", "node_modules"]);
export const FILE_BROWSER_ENTRY_LIMIT = 500;

function browserPathError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireCleanPath(value, label) {
  const result = String(value || "").trim();
  if (!result || result.length > 4096 || /[\0\r\n]/.test(result)) {
    throw browserPathError(`${label} is invalid`);
  }
  return result;
}

export function resolveFileBrowserDirectory(rootValue, relativePathValue = "") {
  const rawRoot = requireCleanPath(rootValue, "File browser root");
  if (!path.isAbsolute(rawRoot)) {
    throw browserPathError("File browser root must be absolute");
  }
  const root = path.resolve(rawRoot);
  const rawRelativePath = String(relativePathValue || "").trim();
  if (rawRelativePath.length > 4096 || /[\0\r\n]/.test(rawRelativePath)) {
    throw browserPathError("File browser path is invalid");
  }
  if (path.isAbsolute(rawRelativePath)) {
    throw browserPathError("File browser path must be relative");
  }

  const directoryPath = path.resolve(root, rawRelativePath || ".");
  if (directoryPath !== root && !directoryPath.startsWith(`${root}${path.sep}`)) {
    throw browserPathError("File browser path is outside its root", 403);
  }

  return {
    root,
    directoryPath,
    relativePath: path.relative(root, directoryPath).split(path.sep).join("/"),
  };
}

export function projectFileBrowserEntries(directoryPath, entries, limit = FILE_BROWSER_ENTRY_LIMIT) {
  const visible = entries
    .filter((entry) => entry && !EXCLUDED_NAMES.has(String(entry.name || "")))
    .map((entry) => ({
      name: String(entry.name || ""),
      path: path.join(directoryPath, String(entry.name || "")),
      isDirectory: entry.isDirectory === true,
    }))
    .filter((entry) => entry.name && entry.name !== "." && entry.name !== "..")
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });

  return { entries: visible.slice(0, limit), truncated: visible.length > limit };
}
