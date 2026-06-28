const urlEl = document.getElementById("url");
const statusEl = document.getElementById("status");
const memoEl = document.getElementById("memo");
const saveButton = document.getElementById("save");
const removeButton = document.getElementById("remove");
const clearMemoButton = document.getElementById("clearMemo");
const copyMemoButton = document.getElementById("copyMemo");
const openOptionsButton = document.getElementById("openOptions");

let currentUrl = "";

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setDisabled(disabled) {
  memoEl.disabled = disabled;
  saveButton.disabled = disabled;
  removeButton.disabled = disabled || !currentUrl;
  clearMemoButton.disabled = disabled;
  copyMemoButton.disabled = disabled;
}

async function loadCurrentUrl() {
  const tab = await getActiveTab();
  currentUrl = UrlMemoStorage.normalizeUrl(tab?.url || "");
  urlEl.textContent = currentUrl || "このページでは利用できません";

  if (!UrlMemoStorage.isSupportedUrl(currentUrl)) {
    setStatus("http / https のページだけ登録できます。");
    setDisabled(true);
    return;
  }

  const entries = await UrlMemoStorage.getEntries();
  const entry = entries[currentUrl];
  memoEl.value = entry?.note || "";
  removeButton.disabled = !entry;
  setStatus(entry ? "このドメインは登録済みです。" : "このドメインは未登録です。");
}

saveButton.addEventListener("click", async () => {
  if (!currentUrl) return;
  await UrlMemoStorage.upsertEntry(currentUrl, memoEl.value);
  removeButton.disabled = false;
  setStatus("保存しました。");
});

memoEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveButton.click();
  }
});

removeButton.addEventListener("click", async () => {
  if (!currentUrl) return;
  await UrlMemoStorage.removeEntry(currentUrl);
  memoEl.value = "";
  removeButton.disabled = true;
  setStatus("登録を解除しました。");
});

clearMemoButton.addEventListener("click", () => {
  memoEl.value = "";
  memoEl.focus();
});

copyMemoButton.addEventListener("click", async () => {
  if (!memoEl.value) return;
  await navigator.clipboard.writeText(memoEl.value);
  setStatus("コピーしました。");
});

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

loadCurrentUrl();
