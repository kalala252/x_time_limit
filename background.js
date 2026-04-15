const DAILY_LIMIT_MS = 30 * 60 * 1000;
const RESET_HOUR_LOCAL = 5;
const STORAGE_KEY = "x_time_limit_state_v1";
const TICK_ALARM = "x-time-limit-tick";
const TRACKED_URL_PATTERNS = [
  "*://x.com/*",
  "*://www.x.com/*",
  "*://twitter.com/*",
  "*://www.twitter.com/*"
];

let cachedState = null;
let opChain = Promise.resolve();

function todayKey() {
  const now = new Date();
  // Shift by reset hour so the logical "day" starts at 05:00 local time.
  const shifted = new Date(now.getTime() - RESET_HOUR_LOCAL * 60 * 60 * 1000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, "0");
  const d = String(shifted.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function createDefaultState() {
  return {
    dateKey: todayKey(),
    usedMs: 0,
    tracking: null
  };
}

async function loadState() {
  if (cachedState) {
    return cachedState;
  }

  const result = await chrome.storage.local.get(STORAGE_KEY);
  cachedState = result[STORAGE_KEY] || createDefaultState();
  return cachedState;
}

async function saveState(state) {
  cachedState = state;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function resetIfNewDay(state) {
  const key = todayKey();
  if (state.dateKey !== key) {
    state.dateKey = key;
    state.usedMs = 0;
    state.tracking = null;
    return true;
  }
  return false;
}

function remainingMs(state) {
  return Math.max(0, DAILY_LIMIT_MS - state.usedMs);
}

async function getEligibleActiveContext() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
    url: TRACKED_URL_PATTERNS
  });
  const tab = tabs[0];
  if (!tab || tab.id === undefined || tab.windowId === undefined) {
    return null;
  }

  const win = await chrome.windows.get(tab.windowId);
  if (!win.focused) {
    return null;
  }

  return { tabId: tab.id, windowId: tab.windowId };
}

function accrueUsageToNow(state, nowMs) {
  if (!state.tracking) {
    return false;
  }

  const delta = Math.max(0, nowMs - state.tracking.lastTickMs);
  state.tracking.lastTickMs = nowMs;
  if (delta <= 0) {
    return false;
  }

  const remaining = remainingMs(state);
  if (remaining <= 0) {
    return false;
  }

  const add = Math.min(delta, remaining);
  state.usedMs += add;
  return add > 0;
}

async function updateBadge(state, isActivelyTracking) {
  const minutes = Math.ceil(remainingMs(state) / 60000);
  await chrome.action.setBadgeBackgroundColor({ color: isActivelyTracking ? "#0b8043" : "#b3261e" });
  await chrome.action.setBadgeText({ text: String(minutes) });
}

async function redirectTabToBlocked(tabId) {
  if (tabId === null || tabId === undefined) {
    return;
  }
  try {
    await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("blocked.html") });
  } catch (err) {
    // Tab may have been closed or replaced between checks.
  }
}

async function enforceBlockIfNeeded(state, preferredTabId = null) {
  if (remainingMs(state) > 0) {
    return;
  }

  await redirectTabToBlocked(preferredTabId);

  const eligible = await getEligibleActiveContext();
  if (!eligible) {
    return;
  }

  if (eligible.tabId !== preferredTabId) {
    await redirectTabToBlocked(eligible.tabId);
  }
}

async function refreshTracking() {
  const state = await loadState();
  const nowMs = Date.now();
  const previouslyTrackedTabId = state.tracking ? state.tracking.tabId : null;
  let changed = resetIfNewDay(state);

  if (state.tracking) {
    changed = accrueUsageToNow(state, nowMs) || changed;
  }

  const eligible = await getEligibleActiveContext();
  const exhausted = remainingMs(state) <= 0;

  if (!eligible || exhausted) {
    if (state.tracking) {
      state.tracking = null;
      changed = true;
    }
  } else if (!state.tracking || state.tracking.tabId !== eligible.tabId) {
    state.tracking = {
      tabId: eligible.tabId,
      windowId: eligible.windowId,
      lastTickMs: nowMs
    };
    changed = true;
  }

  if (changed) {
    await saveState(state);
  }

  const activelyTracking = Boolean(state.tracking) && !exhausted;
  await updateBadge(state, activelyTracking);
  await enforceBlockIfNeeded(state, previouslyTrackedTabId);
}

function queueRefresh() {
  opChain = opChain
    .then(() => refreshTracking())
    .catch((err) => {
      console.error("refreshTracking failed", err);
    });
}

async function handleShouldBlock(sendResponse) {
  opChain = opChain
    .then(async () => {
      const state = await loadState();
      let changed = resetIfNewDay(state);
      if (changed) {
        await saveState(state);
      }
      const activelyTracking = Boolean(state.tracking) && remainingMs(state) > 0;
      await updateBadge(state, activelyTracking);
      sendResponse({
        blocked: remainingMs(state) <= 0,
        remainingMs: remainingMs(state)
      });
    })
    .catch((err) => {
      console.error("handleShouldBlock failed", err);
      sendResponse({ blocked: false, remainingMs: DAILY_LIMIT_MS });
    });
}

function ensureAlarm() {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  queueRefresh();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  queueRefresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) {
    queueRefresh();
  }
});

chrome.tabs.onActivated.addListener(() => {
  queueRefresh();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    queueRefresh();
  }
});

chrome.tabs.onRemoved.addListener(() => {
  queueRefresh();
});

chrome.windows.onFocusChanged.addListener(() => {
  queueRefresh();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "SHOULD_BLOCK") {
    handleShouldBlock(sendResponse);
    return true;
  }
  return false;
});

queueRefresh();
