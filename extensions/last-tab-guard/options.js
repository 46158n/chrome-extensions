const DEFAULT_MODE = "last";

function selectedMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : DEFAULT_MODE;
}

async function restore() {
  const { guardMode } = await chrome.storage.sync.get("guardMode");
  const mode = guardMode === "all" ? "all" : "last";
  const input = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (input) input.checked = true;
}

function flashStatus(text) {
  const el = document.getElementById("status");
  el.textContent = text;
  setTimeout(() => {
    el.textContent = "";
  }, 1500);
}

document.addEventListener("DOMContentLoaded", restore);

document.addEventListener("change", async (event) => {
  if (event.target.name !== "mode") return;
  await chrome.storage.sync.set({ guardMode: selectedMode() });
  flashStatus("保存しました");
});
