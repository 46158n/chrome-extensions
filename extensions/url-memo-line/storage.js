(function () {
  const STORE_KEY = "urlMemoLine.entries";

  function normalizeUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return `${url.origin}/`;
    } catch {
      return "";
    }
  }

  function isSupportedUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  async function getEntries() {
    const result = await chrome.storage.local.get(STORE_KEY);
    const { entries, changed } = migrateEntries(result[STORE_KEY] || {});
    if (changed) {
      await setEntries(entries);
    }
    return entries;
  }

  async function setEntries(entries) {
    await chrome.storage.local.set({ [STORE_KEY]: entries });
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

  async function upsertEntry(rawUrl, note) {
    const url = normalizeUrl(rawUrl);
    if (!url) {
      throw new Error("Invalid URL");
    }

    const entries = await getEntries();
    const now = new Date().toISOString();
    entries[url] = {
      note: note.trim(),
      createdAt: entries[url]?.createdAt || now,
      updatedAt: now
    };
    await setEntries(entries);
    return entries[url];
  }

  async function removeEntry(rawUrl) {
    const url = normalizeUrl(rawUrl);
    const entries = await getEntries();
    delete entries[url];
    await setEntries(entries);
  }

  self.UrlMemoStorage = {
    STORE_KEY,
    getEntries,
    isSupportedUrl,
    normalizeUrl,
    removeEntry,
    upsertEntry
  };
})();
