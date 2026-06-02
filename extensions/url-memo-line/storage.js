(function () {
  const STORE_KEY = "urlMemoLine.entries";

  function normalizeUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      url.hash = "";
      return url.toString();
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
    return result[STORE_KEY] || {};
  }

  async function setEntries(entries) {
    await chrome.storage.local.set({ [STORE_KEY]: entries });
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
