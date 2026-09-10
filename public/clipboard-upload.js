const IMAGE_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["image/svg+xml", ".svg"],
  ["image/tiff", ".tiff"],
  ["image/avif", ".avif"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
]);

function isImageFile(file, advertisedType = "") {
  const type = String(file?.type || advertisedType || "").toLowerCase();
  return type.startsWith("image/");
}

// Clipboard implementations differ: Chromium exposes pasted screenshots in
// DataTransfer.items, while some Safari/WebKit versions are more reliable via
// DataTransfer.files. Prefer items so the same File is not returned twice.
export function clipboardImageFiles(event) {
  const data = event?.clipboardData;
  if (!data) return [];

  const itemFiles = Array.from(data.items || [])
    .filter((item) => item?.kind === "file")
    .map((item) => ({ file: item.getAsFile?.(), type: item.type }))
    .filter(({ file, type }) => file && isImageFile(file, type))
    .map(({ file }) => file);
  if (itemFiles.length) return itemFiles;

  return Array.from(data.files || []).filter((file) => isImageFile(file));
}

export function uploadFilename(file) {
  const existing = String(file?.name || "").trim();
  if (existing) return existing;
  const type = String(file?.type || "").toLowerCase();
  return `pasted-image${IMAGE_EXTENSIONS.get(type) || ""}`;
}
