const STORE_KEY = "urlMemoLine.entries";
const ROOT_ID = "url-memo-line-root";

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function currentEntry(entries) {
  return entries[normalizeUrl(location.href)];
}

async function getEntries() {
  const result = await chrome.storage.local.get(STORE_KEY);
  return result[STORE_KEY] || {};
}

async function saveNote(note) {
  const entries = await getEntries();
  const url = normalizeUrl(location.href);
  const now = new Date().toISOString();
  entries[url] = {
    note: note.trim(),
    createdAt: entries[url]?.createdAt || now,
    updatedAt: now
  };
  await chrome.storage.local.set({ [STORE_KEY]: entries });
}

function removeRoot() {
  document.getElementById(ROOT_ID)?.remove();
}

function render(entry) {
  if (!entry) {
    removeRoot();
    return;
  }

  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="url-memo-line-panel">
        <input type="text" maxlength="160" aria-label="URL memo">
        <button type="button" title="メモを隠す" aria-label="メモを隠す">×</button>
      </div>
    `;
    document.documentElement.append(root);

    const input = root.querySelector("input");
    input.addEventListener("change", () => saveNote(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
        saveNote(input.value);
      }
    });
    root.querySelector("button").addEventListener("click", removeRoot);
  }

  const input = root.querySelector("input");
  if (document.activeElement !== input) {
    input.value = entry.note || "";
  }
}

async function refresh() {
  const entries = await getEntries();
  render(currentEntry(entries));
}

function watchLocationChanges() {
  const refreshSoon = () => setTimeout(refresh, 0);
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    refreshSoon();
    return result;
  };

  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    refreshSoon();
    return result;
  };

  window.addEventListener("popstate", refreshSoon);
  window.addEventListener("hashchange", refreshSoon);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORE_KEY]) return;
  render(currentEntry(changes[STORE_KEY].newValue || {}));
});

watchLocationChanges();
refresh();
