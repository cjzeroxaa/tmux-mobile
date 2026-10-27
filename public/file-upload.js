// Only metadata goes through the Controller. File bytes go straight to storage.
export async function uploadComposerFile(file, { api, paneId, machineId, mux, fetchImpl = fetch }) {
  let plan;
  try {
    plan = await api("/api/uploads", {
      method: "POST",
      body: JSON.stringify({ name: file.name || "upload", size: file.size, contentType: file.type || "application/octet-stream" }),
    });
  } catch (error) {
    // Local-only/older Controllers retain their existing upload endpoint.
    if (![404, 501].includes(error.status)) throw error;
    return api(`/api/upload?${new URLSearchParams({ paneId, name: file.name || "upload" })}`, {
      method: "POST", machineId, mux,
      headers: { "content-type": file.type || "application/octet-stream" }, body: file,
    });
  }
  const response = await fetchImpl(plan.upload.url, {
    method: plan.upload.method, headers: plan.upload.headers, body: file, credentials: "omit",
  });
  if (!response.ok) throw new Error(response.status === 403
    ? "Upload authorization expired or was rejected. Select the file again."
    : `File upload failed (${response.status}). Try again.`);
  return api("/api/uploads/complete", { method: "POST", body: JSON.stringify({ ticket: plan.ticket }) });
}
