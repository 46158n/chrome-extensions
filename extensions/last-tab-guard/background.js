const GUARD_URL = "chrome://newtab/";

// onInstalled / onStartup / onCreated がほぼ同時に発火すると、
// ensureGuard が同じウィンドウに対して並行実行されてピン留めタブが重複生成される。
// ウィンドウIDごとに直列化することでこれを防ぐ。
const locks = new Map();

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

// guardTabs は storage.session に保存する windowId -> ガードタブID のマップ。
// 拡張機能のリロードやブラウザ再起動で storage.session は消えるが、ピン留めタブ
// 自体はウィンドウに残る。マップだけを信じると「マップに無いが実在するガード
// タブ」が生まれ、そこへ遷移できてしまう。そのため実タブの走査も併用する。
async function getGuardMap() {
  const { guardTabs } = await chrome.storage.session.get("guardTabs");
  return guardTabs || {};
}

async function setGuardMap(map) {
  await chrome.storage.session.set({ guardTabs: map });
}

// guardTabs の read-modify-write を全ウィンドウ横断で直列化する。
// ウィンドウ別ロックだけだと、別ウィンドウの ensureGuard 同士が
// 読み込んだ古いマップを書き戻してエントリを取りこぼす。
function updateGuardMap(mutator) {
  return withLock("guardMap", async () => {
    const map = await getGuardMap();
    await mutator(map);
    await setGuardMap(map);
  });
}

function isNewTabUrl(url) {
  return (
    !url ||
    url.startsWith("chrome://newtab") ||
    url.startsWith("chrome://new-tab-page")
  );
}

// ガードタブ候補 = ピン留めされた新規タブ。読み込み中(pendingUrl)が別URLの
// ものは除外する。ウィンドウ内のものを index 昇順で返す。
function looksLikeGuardTab(tab) {
  return (
    tab.pinned &&
    isNewTabUrl(tab.url) &&
    (!tab.pendingUrl || isNewTabUrl(tab.pendingUrl))
  );
}

async function findGuardTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId, pinned: true });
  return tabs.filter(looksLikeGuardTab).sort((a, b) => a.index - b.index);
}

// 保護モード:
//   "last" … 通常ウィンドウが1つだけのときそのウィンドウにだけガードタブを置く。
//            2つ以上あるときはどのウィンドウも保護しない(自由に閉じられる)。
//   "all"  … 開いているすべての通常ウィンドウにガードタブを常駐させる。
// options.html から chrome.storage.sync に保存される。
const DEFAULT_MODE = "last";

async function getMode() {
  try {
    const { guardMode } = await chrome.storage.sync.get("guardMode");
    return guardMode === "all" ? "all" : "last";
  } catch {
    return DEFAULT_MODE;
  }
}

async function ensureGuard(windowId) {
  return withLock(windowId, async () => {
    try {
      await chrome.windows.get(windowId);
    } catch {
      return; // ウィンドウが既に閉じている
    }

    // 高速パス: マップされたガードタブが健在なら何もしない。
    const map = await getGuardMap();
    const mapped = map[windowId];
    if (mapped !== undefined) {
      try {
        const tab = await chrome.tabs.get(mapped);
        if (tab.windowId === windowId && tab.pinned) return;
      } catch {
        // 失われている。以下で作り直す。
      }
    }

    // storage.session が消えた場合などに備え、既存のピン留め新規タブを
    // 流用する。重複していれば先頭以外を片付ける。
    let guardTabId;
    try {
      const guards = await findGuardTabs(windowId);
      if (guards.length > 0) {
        guardTabId = guards[0].id;
        for (const dup of guards.slice(1)) {
          try {
            await chrome.tabs.remove(dup.id);
          } catch {}
        }
        if (guards[0].index !== 0) {
          try {
            await chrome.tabs.move(guardTabId, { index: 0 });
          } catch {}
        }
      } else {
        const tab = await chrome.tabs.create({
          windowId,
          url: GUARD_URL,
          pinned: true,
          active: false,
          index: 0,
        });
        guardTabId = tab.id;
      }
    } catch {
      return; // 途中でウィンドウが閉じられた
    }

    if (guardTabId === undefined) return;
    await updateGuardMap((m) => {
      m[windowId] = guardTabId;
    });
  });
}

// ガードタブを取り除く。ガードタブしか無いウィンドウでは削除するとウィンドウ
// ごと消えてしまうため、1つ目は削除せずピン留めだけ解除して通常タブに戻す。
async function removeGuard(windowId) {
  return withLock(windowId, async () => {
    await updateGuardMap((m) => {
      delete m[windowId];
    });

    let guards;
    try {
      guards = await findGuardTabs(windowId);
    } catch {
      return; // ウィンドウが既に存在しない
    }
    if (guards.length === 0) return;

    let allTabs;
    try {
      allTabs = await chrome.tabs.query({ windowId });
    } catch {
      return; // ウィンドウが既に存在しない
    }
    let survivors = allTabs.length - guards.length;
    for (const guard of guards) {
      if (survivors <= 0) {
        try {
          await chrome.tabs.update(guard.id, { pinned: false });
          survivors += 1;
        } catch {}
      } else {
        try {
          await chrome.tabs.remove(guard.id);
        } catch {}
      }
    }
  });
}

// 現在のモードと通常ウィンドウの数に応じて、各ウィンドウのガードタブの
// 有無を調整する。すべてのイベントハンドラはこの関数を呼んで状態を合わせる。
async function applyGuardPolicy() {
  try {
    const mode = await getMode();
    const windows = await chrome.windows.getAll();
    const normalIds = windows
      .filter((win) => win.type === "normal")
      .map((win) => win.id);

    if (mode === "all") {
      for (const id of normalIds) await ensureGuard(id);
      return;
    }

    // mode === "last"
    if (normalIds.length === 1) {
      await ensureGuard(normalIds[0]);
    } else {
      for (const id of normalIds) await removeGuard(id);
    }
  } catch {
    // ウィンドウ構成が途中で変わった等。次のイベントで再調整される。
  }
}

// 非同期リスナー内で送出された例外を握りつぶし、
// "Uncaught (in promise)" が拡張機能のエラーページに積み上がるのを防ぐ。
function safe(handler) {
  return (...args) => Promise.resolve()
    .then(() => handler(...args))
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(safe(applyGuardPolicy));
chrome.runtime.onStartup.addListener(safe(applyGuardPolicy));

chrome.windows.onCreated.addListener((win) => {
  if (win.type === "normal") applyGuardPolicy();
});

// options.html でモードが変更されたら即座に反映する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.guardMode) applyGuardPolicy();
});

chrome.windows.onRemoved.addListener(safe(async (windowId) => {
  await updateGuardMap((m) => {
    delete m[windowId];
  });
  const lastActive = await getLastActiveMap();
  if (lastActive[windowId] !== undefined) {
    delete lastActive[windowId];
    await chrome.storage.session.set({ lastActiveTabs: lastActive });
  }
  locks.delete(windowId);

  // "last" モードで通常ウィンドウが残り1つになった場合、そのウィンドウを保護する。
  applyGuardPolicy();
}));

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

  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch {
    return "right";
  }
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
    let tabs;
    try {
      tabs = await chrome.tabs.query({ windowId });
    } catch {
      return; // ウィンドウが既に閉じている
    }
    const guard = tabs.find((tab) => tab.id === guardTabId);
    const normalTabs = tabs
      .filter((tab) => tab.id !== guardTabId)
      .sort((a, b) => a.index - b.index);

    try {
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
        await chrome.tabs.update(target.id, { active: true });
      }
    } catch {
      // ウィンドウ/タブが操作中に閉じられた
    }
  });
}

chrome.tabs.onRemoved.addListener(safe(async (tabId, removeInfo) => {
  // ウィンドウごと閉じる場合は何もしない(＝ここでは復元しない)。
  // これにより「ガードタブしか残っていない状態でそれを閉じる」操作や
  // Chrome自体の終了(Cmd+Q等)でウィンドウを閉じることは妨げない。
  if (removeInfo.isWindowClosing) return;

  const windowId = removeInfo.windowId;
  const map = await getGuardMap();
  const guardTabId = map[windowId];

  if (guardTabId === tabId) {
    // ガードタブ自体が何らかの方法で閉じられた場合、モードに応じて作り直す。
    await updateGuardMap((m) => {
      delete m[windowId];
    });
    applyGuardPolicy();
    return;
  }

  // このウィンドウはガード対象外(="last"モードで複数ウィンドウ)。何もしない。
  if (guardTabId === undefined) return;

  // 通常タブを閉じた結果ガードタブしか残らなかった場合だけ、新しい通常タブを
  // 開いてガードタブがアクティブのまま残らないようにする。
  // それ以外は Chrome 標準のタブ遷移に任せる(勝手に一番左へ飛ばさない)。
  // ガードタブが選択されてしまうケースは onActivated 側で拾って回り込ませる。
  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch {
    return; // ウィンドウが既に閉じている
  }
  const hasNormalTab = tabs.some((tab) => tab.id !== guardTabId);
  if (!hasNormalTab) {
    try {
      await chrome.tabs.create({ windowId, url: GUARD_URL, active: true });
    } catch {}
  }
}));

// ガードタブがアクティブになった(クリックやCtrl+Tab等)場合、
// 移動方向を推定して回り込んだ先の通常タブへ即座にフォーカスを戻し、
// ガードタブを操作させない。通常タブがアクティブになった場合は、
// 次にガードへ当たったときの方向推定に使うため位置を記録する。
chrome.tabs.onActivated.addListener(safe(async ({ tabId, windowId }) => {
  const map = await getGuardMap();
  let isGuard = map[windowId] === tabId;

  // マップが古い(リロード直後など)可能性に備え、アクティブになったタブ自体が
  // ガードタブか確認する。ただしこのウィンドウがガード対象のときだけ。
  if (!isGuard && map[windowId] !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (looksLikeGuardTab(tab)) {
        isGuard = true;
        await updateGuardMap((m) => {
          m[windowId] = tabId;
        });
      }
    } catch {
      return;
    }
  }

  if (!isGuard) {
    await setLastActiveTab(windowId, tabId);
    return;
  }

  const direction = await inferDirection(windowId, tabId);
  focusNormalTab(windowId, tabId, direction);
}));

// ガードタブが別ウィンドウへドラッグされた場合、元のウィンドウのマッピングを
// 外し、モードに応じてガードの配置をやり直す。
chrome.tabs.onDetached.addListener(safe(async (tabId, detachInfo) => {
  const map = await getGuardMap();
  if (map[detachInfo.oldWindowId] === tabId) {
    await updateGuardMap((m) => {
      delete m[detachInfo.oldWindowId];
    });
    applyGuardPolicy();
  }
}));

chrome.tabs.onAttached.addListener(safe(async (tabId, attachInfo) => {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!looksLikeGuardTab(tab)) return;

  await updateGuardMap((m) => {
    if (m[attachInfo.newWindowId] === undefined) {
      m[attachInfo.newWindowId] = tabId;
    }
  });
  applyGuardPolicy();
}));
