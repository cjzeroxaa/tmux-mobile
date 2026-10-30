import { ASR_OPTIONS, readAsrMode, saveAsrMode } from "./asr-provider.js";
const root = document.querySelector("#providers"), current = readAsrMode();
for (const option of ASR_OPTIONS) {
  const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span"), title = document.createElement("strong"), description = document.createElement("small");
  input.type = "radio"; input.name = "asrProvider"; input.value = option.value; input.checked = current === option.value;
  title.textContent = option.label; description.textContent = option.description;
  text.append(title, description); label.append(input, text); root.append(label);
}
document.querySelector("#speech-settings").addEventListener("submit", event => {
  event.preventDefault();
  const status = document.querySelector("#status");
  try {
    const selected = document.querySelector('input[name="asrProvider"]:checked').value;
    saveAsrMode(selected);
    status.textContent = `Saved · ${ASR_OPTIONS.find(option => option.value === selected).label} · Applies to the next recording`;
  } catch { status.textContent = "Could not save. Browser storage may be unavailable. Please try again."; }
});
