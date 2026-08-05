const STORE_KEY = "urlMemoLine.entries";
const ROOT_ID = "url-memo-line-root";

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}/`;
  } catch {
    return "";
  }
}

function currentEntry(entries) {
  return entries[normalizeUrl(location.href)];
}

async function getEntries() {
  const result = await chrome.storage.local.get(STORE_KEY);
  const { entries, changed } = migrateEntries(result[STORE_KEY] || {});
  if (changed) {
    await chrome.storage.local.set({ [STORE_KEY]: entries });
  }
  return entries;
}

function isNewerEntry(entry, currentEntry) {
  const entryTime = Date.parse(entry?.updatedAt || entry?.createdAt || "") || 0;
  const currentTime = Date.parse(currentEntry?.updatedAt || currentEntry?.createdAt || "") || 0;
  return entryTime >= currentTime;
}

function migrateEntries(entries) {
  const migratedEntries = {};
  let changed = false;

  for (const [rawUrl, entry] of Object.entries(entries)) {
    const url = normalizeUrl(rawUrl);
    if (!url) {
      migratedEntries[rawUrl] = entry;
      continue;
    }

    if (url !== rawUrl || migratedEntries[url]) {
      changed = true;
    }

    if (!migratedEntries[url] || isNewerEntry(entry, migratedEntries[url])) {
      migratedEntries[url] = entry;
    }
  }

  return { entries: migratedEntries, changed };
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
        <button type="button" class="url-memo-line-sm" title="開いているページのh1をメモに反映" aria-label="h1をメモに反映">H1</button>
        <button type="button" class="url-memo-line-sm" title="クリア" aria-label="メモをクリア">クリア</button>
        <button type="button" class="url-memo-line-sm" title="コピー" aria-label="メモをコピー">コピー</button>
        <button type="button" title="メモを隠す" aria-label="メモを隠す">×</button>
      </div>
    `;
    document.documentElement.append(root);

    const input = root.querySelector("input");
    const [h1Btn, clearBtn, copyBtn, closeBtn] = root.querySelectorAll("button");

    input.addEventListener("change", () => saveNote(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
        saveNote(input.value);
      }
    });
    h1Btn.addEventListener("click", () => {
      const text = document.querySelector("h1")?.textContent?.trim();
      if (!text) return;
      input.value = text.slice(0, 160);
      input.focus();
      saveNote(input.value);
    });
    clearBtn.addEventListener("click", () => {
      input.value = "";
      input.focus();
    });
    copyBtn.addEventListener("click", () => {
      if (input.value) navigator.clipboard.writeText(input.value);
    });
    closeBtn.addEventListener("click", removeRoot);
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

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  const input = document.getElementById(ROOT_ID)?.querySelector("input");
  if (input && document.activeElement === input) {
    saveNote(input.value);
  }
});

watchLocationChanges();
refresh();
