const GUARD_URL = "chrome://newtab/";

// onInstalled / onStartup / onCreated がほぼ同時に発火すると、
// ensureGuard が同じウィンドウに対して並行実行されてピン留めタブが重複生成される。
// ウィンドウIDごとに直列化することでこれを防ぐ。
const locks = new Map();

function withLock(windowId, fn) {
  const prev = locks.get(windowId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(windowId, next.catch(() => {}));
  return next;
}

async function getGuardMap() {
  const { guardTabs } = await chrome.storage.session.get("guardTabs");
  return guardTabs || {};
}

async function setGuardMap(map) {
  await chrome.storage.session.set({ guardTabs: map });
}

async function ensureGuard(windowId) {
  return withLock(windowId, async () => {
    try {
      await chrome.windows.get(windowId);
    } catch {
      return; // ウィンドウが既に閉じている
    }

    const map = await getGuardMap();
    const guardTabId = map[windowId];

    if (guardTabId) {
      try {
        const tab = await chrome.tabs.get(guardTabId);
        if (tab && tab.windowId === windowId) return; // 既にガードタブが存在する
      } catch {
        // ガードタブが失われている。再作成する。
      }
    }

    const tab = await chrome.tabs.create({
      windowId,
      url: GUARD_URL,
      pinned: true,
      active: false,
      index: 0,
    });

    map[windowId] = tab.id;
    await setGuardMap(map);
  });
}

async function ensureAllWindows() {
  const windows = await chrome.windows.getAll();
  for (const win of windows) {
    if (win.type === "normal") ensureGuard(win.id);
  }
}

chrome.runtime.onInstalled.addListener(ensureAllWindows);
chrome.runtime.onStartup.addListener(ensureAllWindows);

chrome.windows.onCreated.addListener((win) => {
  if (win.type === "normal") ensureGuard(win.id);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const map = await getGuardMap();
  if (map[windowId] !== undefined) {
    delete map[windowId];
    await setGuardMap(map);
  }
  locks.delete(windowId);
});

// 通常タブが1つも無ければ新しく開き、あれば(ガードタブより右優先で)
// アクティブにする。onRemoved由来の呼び出しとonActivated由来の呼び出しが
// ほぼ同時に発生しうるため、ensureGuardと同じロックで直列化し、
// 新規タブが二重に作られないようにする。
async function focusNormalTab(windowId, guardTabId) {
  return withLock(windowId, async () => {
    const tabs = await chrome.tabs.query({ windowId });
    const guard = tabs.find((tab) => tab.id === guardTabId);
    const normalTabs = tabs
      .filter((tab) => tab.id !== guardTabId)
      .sort((a, b) => a.index - b.index);

    if (normalTabs.length === 0) {
      await chrome.tabs.create({ windowId, url: GUARD_URL, active: true });
      return;
    }

    const neighbor =
      normalTabs.find((tab) => tab.index > (guard ? guard.index : -1)) ||
      normalTabs[0];
    if (!neighbor.active) {
      chrome.tabs.update(neighbor.id, { active: true });
    }
  });
}

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  // ウィンドウごと閉じる場合は何もしない(＝ここでは復元しない)。
  // これにより「ガードタブしか残っていない状態でそれを閉じる」操作や
  // Chrome自体の終了(Cmd+Q等)でウィンドウを閉じることは妨げない。
  if (removeInfo.isWindowClosing) return;

  const windowId = removeInfo.windowId;
  const map = await getGuardMap();
  const guardTabId = map[windowId];

  if (guardTabId === tabId) {
    // ガードタブ自体が何らかの方法で閉じられた場合は作り直す。
    delete map[windowId];
    await setGuardMap(map);
    ensureGuard(windowId);
    return;
  }

  // 通常タブを閉じた結果ガードタブしか残っていない場合、
  // ガードタブとは別に新しい通常タブを開く(ガードタブはアクティブにしない)。
  focusNormalTab(windowId, guardTabId);
});

// ガードタブがアクティブになった(クリックやCtrl+Tab等)場合、
// 右隣の通常タブへ即座にフォーカスを戻し、ガードタブを操作させない。
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const map = await getGuardMap();
  if (map[windowId] !== tabId) return;

  focusNormalTab(windowId, tabId);
});

// ガードタブが別ウィンドウへドラッグされた場合、元のウィンドウは
// ガードを失うため作り直し、移動先ウィンドウのマッピングを更新する。
chrome.tabs.onDetached.addListener(async (tabId, detachInfo) => {
  const map = await getGuardMap();
  if (map[detachInfo.oldWindowId] === tabId) {
    delete map[detachInfo.oldWindowId];
    await setGuardMap(map);
    ensureGuard(detachInfo.oldWindowId);
  }
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  const map = await getGuardMap();
  if (map[attachInfo.newWindowId] === undefined) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.pinned && tab.url === GUARD_URL) {
      map[attachInfo.newWindowId] = tabId;
      await setGuardMap(map);
    }
  }
});
