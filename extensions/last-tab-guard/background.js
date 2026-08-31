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
  const lastActive = await getLastActiveMap();
  if (lastActive[windowId] !== undefined) {
    delete lastActive[windowId];
    await chrome.storage.session.set({ lastActiveTabs: lastActive });
  }
  locks.delete(windowId);
});

// ガードタブに当たる直前にアクティブだった通常タブを覚えておき、
// Ctrl+Tab(右回り) / Ctrl+Shift+Tab(左回り) のどちらでガードに
// 当たったのかを推定するために使う。
async function getLastActiveMap() {
  const { lastActiveTabs } = await chrome.storage.session.get("lastActiveTabs");
  return lastActiveTabs || {};
}

async function setLastActiveTab(windowId, tabId) {
  const map = await getLastActiveMap();
  map[windowId] = tabId;
  await chrome.storage.session.set({ lastActiveTabs: map });
}

// 直前のアクティブタブがガードの左隣(=通常タブの左端)なら、左回りで
// ガードに当たったと判断して "left" を返す。右端なら "right"。
// 判定材料が無い場合(クリックで直接ガードを選んだ等)は従来どおり "right"。
async function inferDirection(windowId, guardTabId) {
  const map = await getLastActiveMap();
  const prevTabId = map[windowId];
  if (prevTabId === undefined) return "right";

  const tabs = await chrome.tabs.query({ windowId });
  const normalTabs = tabs
    .filter((tab) => tab.id !== guardTabId)
    .sort((a, b) => a.index - b.index);
  if (normalTabs.length < 2) return "right";

  if (normalTabs[0].id === prevTabId) return "left";
  return "right";
}

// 通常タブが1つも無ければ新しく開き、あれば direction に応じて
// アクティブにする:
//   "right" … ガードタブの右隣(=通常タブの左端)へ。右回りの回り込み。
//   "left"  … 通常タブの右端へ。左回りの回り込み。
// onRemoved由来の呼び出しとonActivated由来の呼び出しがほぼ同時に
// 発生しうるため、ensureGuardと同じロックで直列化し、新規タブが
// 二重に作られないようにする。
async function focusNormalTab(windowId, guardTabId, direction = "right") {
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

    const target =
      direction === "left"
        ? normalTabs[normalTabs.length - 1]
        : normalTabs.find((tab) => tab.index > (guard ? guard.index : -1)) ||
          normalTabs[0];
    if (!target.active) {
      chrome.tabs.update(target.id, { active: true });
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
// 移動方向を推定して回り込んだ先の通常タブへ即座にフォーカスを戻し、
// ガードタブを操作させない。通常タブがアクティブになった場合は、
// 次にガードへ当たったときの方向推定に使うため位置を記録する。
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const map = await getGuardMap();
  const guardTabId = map[windowId];

  if (guardTabId !== tabId) {
    await setLastActiveTab(windowId, tabId);
    return;
  }

  const direction = await inferDirection(windowId, guardTabId);
  focusNormalTab(windowId, guardTabId, direction);
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
