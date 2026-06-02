const addForm = document.getElementById("addForm");
const urlInput = document.getElementById("urlInput");
const memoInput = document.getElementById("memoInput");
const statusEl = document.getElementById("status");
const emptyEl = document.getElementById("empty");
const entriesEl = document.getElementById("entries");
const template = document.getElementById("entryTemplate");

function setStatus(message) {
  statusEl.textContent = message;
}

async function renderEntries() {
  const entries = await UrlMemoStorage.getEntries();
  const sortedUrls = Object.keys(entries).sort();

  entriesEl.textContent = "";
  emptyEl.hidden = sortedUrls.length > 0;

  for (const url of sortedUrls) {
    const entry = entries[url];
    const node = template.content.firstElementChild.cloneNode(true);
    const link = node.querySelector(".entry-url");
    const noteInput = node.querySelector(".entry-note");
    const removeButton = node.querySelector(".entry-remove");

    link.href = url;
    link.textContent = url;
    link.title = url;
    noteInput.value = entry.note || "";

    noteInput.addEventListener("change", async () => {
      await UrlMemoStorage.upsertEntry(url, noteInput.value);
      setStatus("保存しました。");
    });

    noteInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        noteInput.blur();
      }
    });

    removeButton.addEventListener("click", async () => {
      await UrlMemoStorage.removeEntry(url);
      setStatus("削除しました。");
      renderEntries();
    });

    entriesEl.append(node);
  }
}

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!UrlMemoStorage.isSupportedUrl(urlInput.value)) {
    setStatus("http / https のURLを入力してください。");
    return;
  }

  await UrlMemoStorage.upsertEntry(urlInput.value, memoInput.value);
  urlInput.value = "";
  memoInput.value = "";
  setStatus("追加しました。");
  renderEntries();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[UrlMemoStorage.STORE_KEY]) {
    renderEntries();
  }
});

renderEntries();
