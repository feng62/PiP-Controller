const MEDIA_HOSTS = [
  "youtube.com",
  "bilibili.com",
  "douyin.com",
];

/** manifest 键名带数字前缀，供 chrome://extensions/shortcuts 按序显示 */
const CMD = {
  PIP: "1-toggle-pip",
  SEEK_BACK: "2-seek-back",
  PLAY: "3-toggle-play",
  SEEK_FWD: "4-seek-forward",
  NEXT_VIDEO: "5-next-video",
};

const CMD_TO_BRIDGE = {
  [CMD.SEEK_BACK]: "seek-back",
  [CMD.PLAY]: "toggle-play",
  [CMD.SEEK_FWD]: "seek-forward",
  [CMD.NEXT_VIDEO]: "next-video",
};

const PIP_TOGGLE_SCRIPT = "content/pip-toggle.js";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 80;
const DEFAULT_SEEK_SECONDS = 5;
const SEEK_MIN = 1;
const SEEK_MAX = 120;
const DEFAULT_HOLD_RATE = 2.0;
const RATE_MIN = 1.25;
const RATE_MAX = 16;

async function getSeekSettings() {
  const { seekSeconds, holdPlaybackRate } = await chrome.storage.sync.get({
    seekSeconds: DEFAULT_SEEK_SECONDS,
    holdPlaybackRate: DEFAULT_HOLD_RATE,
  });
  const n = Math.round(Number(seekSeconds));
  const validSeek = Number.isFinite(n)
    ? Math.min(SEEK_MAX, Math.max(SEEK_MIN, n))
    : DEFAULT_SEEK_SECONDS;
  const r = Number(holdPlaybackRate);
  const validRate = Number.isFinite(r)
    ? Math.min(RATE_MAX, Math.max(RATE_MIN, r))
    : DEFAULT_HOLD_RATE;
  return { seekSeconds: validSeek, holdPlaybackRate: validRate };
}

/** 内存缓存，避免 onCommand 里 await 查标签导致用户激活丢失 */
let cachedMediaTabId = null;

/**
 * 接收来自 content/bridge.js 的长连接心跳（每 25s 一次）：
 * 1. 保持 Service Worker 处于活跃状态（不休眠），确保 cachedMediaTabId 永不丢失；
 * 2. 这样按 Alt+W 时可以在 onCommand 同步调用栈内直接注入 pip-toggle.js，保留 Chrome 用户手势（User Activation），解决 30s 后打不开画中画的问题。
 */
const activeMediaPorts = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pip-keepalive") return;
  const tab = port.sender?.tab;
  const tabId = tab?.id;
  if (tabId && isMediaUrl(tab?.url)) {
    activeMediaPorts.set(tabId, port);
    if (!cachedMediaTabId || tab.audible || tab.active) {
      rememberMediaTab(tabId);
    }
  }
  port.onMessage.addListener((msg) => {
    if (msg?.type === "ping" && tabId) {
      if (msg.playing || !cachedMediaTabId) {
        rememberMediaTab(tabId);
      }
      try {
        port.postMessage({ type: "pong" });
      } catch {
        /* ignore */
      }
    }
  });
  port.onDisconnect.addListener(() => {
    if (tabId) {
      activeMediaPorts.delete(tabId);
      if (cachedMediaTabId === tabId) {
        cachedMediaTabId = null;
        void refreshCachedMediaTab();
      }
    }
  });
});

// Service Worker 每次启动或被唤醒时，立即扫描现有的视频标签页并确保注入了 bridge.js 建立保活连接
async function ensureAllMediaTabsBridged() {
  await refreshCachedMediaTab();
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id && isMediaUrl(t.url) && !activeMediaPorts.has(t.id)) {
        void injectBridgeScript(t.id).catch(() => {});
      }
    }
  } catch {
    /* ignore */
  }
}

void ensureAllMediaTabsBridged();

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.session.set({ lastMediaTabId: null });
  if (
    details.reason === chrome.runtime.OnInstalledReason.INSTALL ||
    details.reason === chrome.runtime.OnInstalledReason.UPDATE
  ) {
    warnIfShortcutsMissing();
  }
  void refreshCachedMediaTab();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshCachedMediaTab();
});

function warnIfShortcutsMissing() {
  chrome.commands.getAll((commands) => {
    const missing = commands.filter(
      (c) => c.name === CMD.SEEK_FWD && !c.shortcut
    );
    if (missing.length > 0) {
      console.warn(
        "[PiP Controller] 「快进 5 秒」未绑定：Chrome 保留 Alt+D 给地址栏。" +
          "请到 chrome://extensions/shortcuts 手动设置为 Alt+D。"
      );
    }
  });
}

function isMediaUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return MEDIA_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

function isWatchPage(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const { pathname } = u;
    if (host === "douyin.com" || host.endsWith(".douyin.com")) {
      return (
        pathname === "/" ||
        pathname.includes("/video/") ||
        pathname.startsWith("/discover") ||
        pathname.startsWith("/follow") ||
        pathname.startsWith("/friend") ||
        pathname.startsWith("/recommend") ||
        pathname.startsWith("/user/") ||
        pathname.startsWith("/search/") ||
        pathname.startsWith("/jingxuan") ||
        u.searchParams.has("modal_id")
      );
    }
    return (
      pathname.includes("/watch") ||
      pathname.startsWith("/shorts/") ||
      pathname.includes("/video/")
    );
  } catch {
    return false;
  }
}

function scoreMediaTab(tab) {
  let score = 0;
  if (tab.audible) score += 100;
  if (tab.active) score += 60;
  if (isWatchPage(tab.url)) score += 50;
  score += (tab.lastAccessed || 0) / 1e12;
  return score;
}

async function pickMediaTab(excludeTabId = null) {
  const { lastMediaTabId } = await chrome.storage.session.get("lastMediaTabId");
  const tabs = await chrome.tabs.query({});
  const mediaTabs = tabs.filter(
    (t) => t.id && t.id !== excludeTabId && isMediaUrl(t.url)
  );
  if (mediaTabs.length === 0) return null;

  // 如果存在正在发声（播放中）的视频标签页，优先选正在发声的
  const audibleTabs = mediaTabs.filter((t) => t.audible);
  if (audibleTabs.length === 1) {
    return audibleTabs[0];
  }

  if (lastMediaTabId && lastMediaTabId !== excludeTabId) {
    const remembered = mediaTabs.find((t) => t.id === lastMediaTabId);
    if (remembered) {
      return remembered;
    }
  }

  mediaTabs.sort((a, b) => scoreMediaTab(b) - scoreMediaTab(a));
  return mediaTabs[0];
}

async function refreshCachedMediaTab() {
  const tab = await pickMediaTab();
  cachedMediaTabId = tab?.id ?? null;
  await chrome.storage.session.set({ lastMediaTabId: cachedMediaTabId });
  return cachedMediaTabId;
}

function rememberMediaTab(tabId) {
  if (tabId) {
    cachedMediaTabId = tabId;
    void chrome.storage.session.set({ lastMediaTabId: tabId });
  }
}

async function injectBridgeScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/bridge.js"],
  });
}

/**
 * 尽量同步注入：快捷键触发的用户激活只在极短时间内有效。
 * 不能用「模拟手势」API——目前 Chrome 未提供（见 WECG #898）。
 */
function injectPipToggle(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    files: [PIP_TOGGLE_SCRIPT],
    world: "MAIN",
  });
}

async function runPipToggle(tabId) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await injectPipToggle(tabId);
      return { ok: true };
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) {
        return { ok: false, error: String(err?.message || err) };
      }
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return { ok: false, error: "pip-inject-failed" };
}

async function sendCommandToTab(tabId, command) {
  const payload = { type: "pip-controller", command };
  if (command === "seek-back" || command === "seek-forward") {
    const { seekSeconds, holdPlaybackRate } = await getSeekSettings();
    payload.seekSeconds = seekSeconds;
    payload.holdPlaybackRate = holdPlaybackRate;
  }
  return chrome.tabs.sendMessage(tabId, payload);
}

async function runMediaCommand(tabId, command) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await sendCommandToTab(tabId, command);
      if (result?.ok) return result;
    } catch {
      try {
        await injectBridgeScript(tabId);
        const result = await sendCommandToTab(tabId, command);
        if (result?.ok) return result;
      } catch (err) {
        if (attempt === MAX_RETRIES - 1) {
          return { ok: false, error: String(err?.message || err) };
        }
      }
    }
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return { ok: false, error: "command-failed" };
}

function resolveTabIdForCommand(commandTab) {
  if (commandTab?.id && isMediaUrl(commandTab.url)) {
    return commandTab.id;
  }
  return cachedMediaTabId;
}

chrome.commands.onCommand.addListener((command, commandTab) => {
  if (command === CMD.PIP) {
    const tabId = resolveTabIdForCommand(commandTab);
    if (tabId) {
      void runPipToggle(tabId).then(async (result) => {
        if (!result?.ok) {
          // 缓存的 tabId 可能已关闭或跳转，重新找一次标签页重试
          const fallbackId = await refreshCachedMediaTab();
          if (fallbackId && fallbackId !== tabId) {
            await runPipToggle(fallbackId);
          } else {
            console.warn("[PiP Controller]", result?.error || "pip-failed");
          }
        }
      });
      return;
    }
    void refreshCachedMediaTab().then((freshTabId) => {
      if (!freshTabId) {
        console.warn("[PiP Controller] 未找到 YouTube / Bilibili / 抖音 标签页");
        return;
      }
      void runPipToggle(freshTabId);
    });
    return;
  }

  const bridgeCommand = CMD_TO_BRIDGE[command];
  if (!bridgeCommand) return;

  void (async () => {
    let tabId = resolveTabIdForCommand(commandTab) ?? (await pickMediaTab())?.id;
    if (!tabId) {
      console.warn("[PiP Controller] 未找到 YouTube / Bilibili / 抖音 标签页");
      return;
    }
    let result = await runMediaCommand(tabId, bridgeCommand);
    // 如果缓存的标签页已经关闭、无视频（no-video）或无响应，排除该失效标签页并重新选一个有效视频页重试
    if (!result?.ok) {
      const fallbackTab = await pickMediaTab(tabId);
      if (fallbackTab?.id) {
        tabId = fallbackTab.id;
        result = await runMediaCommand(tabId, bridgeCommand);
      }
    }
    if (result?.ok) {
      rememberMediaTab(tabId);
    } else {
      void refreshCachedMediaTab();
      console.warn("[PiP Controller]", result?.error || "failed");
    }
  })();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isMediaUrl(tab.url)) {
      rememberMediaTab(tabId);
    }
  } catch {
    /* ignore */
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!isMediaUrl(tab.url)) {
    if (cachedMediaTabId === tabId) {
      void refreshCachedMediaTab();
    }
    return;
  }
  if (changeInfo.audible || changeInfo.status === "complete") {
    rememberMediaTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (cachedMediaTabId === tabId) {
    cachedMediaTabId = null;
    void refreshCachedMediaTab();
  }
});
