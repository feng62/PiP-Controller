/**
 * 隔离环境：Alt+A/S/D 在后台标签可用（sendMessage）。
 * Alt+W 由 background 注入 pip-toggle.js（MAIN），不在此处理。
 */
(function initPipBridge() {
  if (globalThis.__pipControllerBridgeLoaded) return;
  globalThis.__pipControllerBridgeLoaded = true;

  const DEFAULT_SEEK_SECONDS = 5;
  const DEFAULT_HOLD_RATE = 2.0;
  // Windows 默认键盘首次重复延迟约 250~500ms，后续重复约 33ms
  const FIRST_REPEAT_WINDOW_MS = 650;
  const HOLD_RELEASE_TIMEOUT_MS = 550;

  let seekForwardState = {
    lastTriggerTime: 0,
    isHoldingRate: false,
    originalRate: 1.0,
    targetVideo: null,
    pendingSeekTimer: null,
    releaseRateTimer: null,
  };

  // 暂停/播放防抖与防冲突锁：防止键盘连发或 Alt+Space 触发浏览器/网页自身空格监听导致“刚播放又立刻被暂停”
  const TOGGLE_PLAY_COOLDOWN_MS = 350;
  let lastTogglePlayTime = 0;
  let expectedPausedState = null;
  let guardVideoRef = null;
  let stateGuardTimer = null;

  // 拦截页面内 Alt+Space 的键盘冒泡，防止抖音/B站/YouTube 自身的空格快捷键监听器跟扩展同时触发一次 toggle
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey && (e.code === "Space" || e.key === " ")) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true
  );

  // 与 background 建立长连接并每 24 秒发送一次心跳，防止 MV3 Service Worker 30 秒休眠导致 Alt+W 丢失用户手势打不开画中画
  let keepAlivePort = null;
  function connectKeepAlive() {
    try {
      keepAlivePort = chrome.runtime.connect({ name: "pip-keepalive" });
      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
        setTimeout(connectKeepAlive, 2000);
      });
    } catch {
      keepAlivePort = null;
    }
  }
  connectKeepAlive();
  setInterval(() => {
    if (!keepAlivePort) {
      connectKeepAlive();
    }
    try {
      const v = findVideo();
      keepAlivePort?.postMessage({
        type: "ping",
        playing: Boolean(v && !v.paused),
      });
    } catch {
      keepAlivePort = null;
    }
  }, 24000);

  function normalizeSeekSeconds(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_SEEK_SECONDS;
    return Math.min(120, Math.max(1, n));
  }

  function normalizeHoldRate(value) {
    const r = Number(value);
    if (!Number.isFinite(r)) return DEFAULT_HOLD_RATE;
    return Math.min(16, Math.max(1.25, r));
  }

  function restoreHoldRate() {
    if (seekForwardState.releaseRateTimer) {
      clearTimeout(seekForwardState.releaseRateTimer);
      seekForwardState.releaseRateTimer = null;
    }
    if (seekForwardState.isHoldingRate && seekForwardState.targetVideo) {
      try {
        seekForwardState.targetVideo.playbackRate = seekForwardState.originalRate;
      } catch {
        /* ignore */
      }
    }
    seekForwardState.isHoldingRate = false;
    seekForwardState.targetVideo = null;
    seekForwardState.lastTriggerTime = 0;
  }

  function handleSeekForwardOrHoldRate(video, step, holdRate) {
    const now = performance.now();
    const elapsed = now - seekForwardState.lastTriggerTime;
    seekForwardState.lastTriggerTime = now;

    // 如果已经在长按倍速状态，或者距离上次按下在首次重复窗口内（说明用户按住没放触发了连发）
    if (seekForwardState.isHoldingRate || (elapsed > 0 && elapsed < FIRST_REPEAT_WINDOW_MS)) {
      if (seekForwardState.pendingSeekTimer) {
        clearTimeout(seekForwardState.pendingSeekTimer);
        seekForwardState.pendingSeekTimer = null;
      }

      if (!seekForwardState.isHoldingRate) {
        seekForwardState.isHoldingRate = true;
        seekForwardState.targetVideo = video;
        seekForwardState.originalRate = video.playbackRate || 1.0;
        video.playbackRate = holdRate;
        if (video.paused) {
          void video.play();
        }
      } else if (seekForwardState.targetVideo === video && video.playbackRate !== holdRate) {
        video.playbackRate = holdRate;
      }

      if (seekForwardState.releaseRateTimer) {
        clearTimeout(seekForwardState.releaseRateTimer);
      }
      seekForwardState.releaseRateTimer = setTimeout(() => {
        restoreHoldRate();
      }, HOLD_RELEASE_TIMEOUT_MS);

      return { ok: true, action: "hold-playback-rate", rate: holdRate };
    }

    // 首次按下：延迟一小段时间等待是否有第二次连发信号；若没有（单击松开），则立即执行快进
    if (seekForwardState.pendingSeekTimer) {
      clearTimeout(seekForwardState.pendingSeekTimer);
    }
    seekForwardState.pendingSeekTimer = setTimeout(() => {
      seekForwardState.pendingSeekTimer = null;
      if (!seekForwardState.isHoldingRate) {
        const duration = Number.isFinite(video.duration)
          ? video.duration
          : Infinity;
        video.currentTime = Math.min(duration, video.currentTime + step);
        seekForwardState.lastTriggerTime = 0;
      }
    }, 320);

    return { ok: true, action: "seek-forward-or-hold-pending" };
  }

  function isInViewport(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const visibleX = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visibleY = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return (visibleX * visibleY) / (r.width * r.height) > 0.3;
  }

  function findActiveDouyinSlide() {
    const activeSlides = [
      ...document.querySelectorAll('[data-e2e="feed-active-video"]'),
    ].filter((el) => el instanceof HTMLElement);
    if (activeSlides.length === 1) return activeSlides[0];
    if (activeSlides.length > 1) {
      activeSlides.sort((a, b) => (isInViewport(b) ? 1 : 0) - (isInViewport(a) ? 1 : 0));
      return activeSlides[0];
    }
    return null;
  }

  function findVideo() {
    if (document.pictureInPictureElement instanceof HTMLVideoElement) {
      return document.pictureInPictureElement;
    }

    const docPipWin = globalThis.documentPictureInPicture?.window;
    if (docPipWin?.document) {
      const pipVideo = docPipWin.document.querySelector("video");
      if (pipVideo instanceof HTMLVideoElement) {
        return pipVideo;
      }
    }

    if (location.hostname.includes("douyin.com")) {
      const activeSlide = findActiveDouyinSlide();
      if (activeSlide) {
        const activeVideo = activeSlide.querySelector("video");
        if (activeVideo instanceof HTMLVideoElement) {
          return activeVideo;
        }
      }
    }

    const videos = [...document.querySelectorAll("video")].filter(
      (v) => v.readyState > 0 && !v.ended
    );
    if (videos.length === 0) return null;

    videos.sort((a, b) => {
      const score = (v) => {
        let s = 0;
        if (!v.paused) s += 20;
        if (isInViewport(v)) s += 15;
        if (v.closest?.('[data-e2e="feed-active-video"]')) s += 30;
        const r = v.getBoundingClientRect();
        return s + (r.width * r.height) / 1e6;
      };
      return score(b) - score(a);
    });
    return videos[0];
  }

  function unlockVideoForPip(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    video.removeAttribute("disablePictureInPicture");
    video.disablePictureInPicture = false;
    try {
      video.controlsList?.remove("nopictureinpicture");
    } catch {
      /* ignore */
    }
  }

  function triggerDouyinNextVideo() {
    // 1. 优先尝试点击小窗或主页面里的“下一个视频”切换按钮（如果存在且可用）
    const nextBtnSelectors = [
      '[data-e2e="video-switch-next-arrow"]',
      ".xgplayer-playswitch-next",
    ];
    const docPipWin = globalThis.documentPictureInPicture?.window;
    for (const sel of nextBtnSelectors) {
      const pipBtn = docPipWin?.document?.querySelector(sel);
      if (pipBtn instanceof HTMLElement && !pipBtn.classList.contains("disabled")) {
        pipBtn.click();
        return { ok: true, action: "douyin-next-video" };
      }
      const mainBtn = document.querySelector(sel);
      if (mainBtn instanceof HTMLElement && !mainBtn.classList.contains("disabled")) {
        mainBtn.click();
        return { ok: true, action: "douyin-next-video" };
      }
    }

    // 2. 向页面派发抖音原生快捷键 "s"（KeyS, keyCode 83）切换下一个视频
    const keyOpts = {
      key: "s",
      code: "KeyS",
      keyCode: 83,
      which: 83,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    const activeSlide = findActiveDouyinSlide();
    const target =
      activeSlide ||
      (document.activeElement &&
      document.activeElement !== document.body &&
      document.activeElement.tagName !== "INPUT" &&
      document.activeElement.tagName !== "TEXTAREA"
        ? document.activeElement
        : document.body) ||
      document.documentElement;

    target.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
    target.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
    return { ok: true, action: "douyin-next-video" };
  }

  function handleTogglePlay(video) {
    const now = performance.now();
    // 1. 冷却期内忽略重复触发（防止按键稍微按久一点触发系统连发，或者双重触发）
    if (now - lastTogglePlayTime < TOGGLE_PLAY_COOLDOWN_MS) {
      return { ok: true, action: "toggle-play-debounced" };
    }
    lastTogglePlayTime = now;

    if (stateGuardTimer) {
      clearTimeout(stateGuardTimer);
      stateGuardTimer = null;
    }

    // 2. 如果是抖音，并且页面有 .xgplayer-play 按钮，同时同步播放器状态；但直接操作 video 并加状态守卫最可靠
    const wantPlay = video.paused;
    expectedPausedState = !wantPlay;
    guardVideoRef = video;

    if (wantPlay) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }

    // 3. 状态守卫：如果在 220ms 内页面自身的事件监听器（如残留的空格事件或播放器假状态）又把视频反向暂停/播放了，强制纠正回来
    const onUnexpectedFlip = () => {
      if (guardVideoRef !== video || expectedPausedState === null) return;
      if (performance.now() - lastTogglePlayTime < 220) {
        if (expectedPausedState === false && video.paused) {
          void video.play().catch(() => {});
        } else if (expectedPausedState === true && !video.paused) {
          video.pause();
        }
      }
    };

    video.addEventListener("pause", onUnexpectedFlip);
    video.addEventListener("play", onUnexpectedFlip);
    stateGuardTimer = setTimeout(() => {
      video.removeEventListener("pause", onUnexpectedFlip);
      video.removeEventListener("play", onUnexpectedFlip);
      expectedPausedState = null;
      guardVideoRef = null;
      stateGuardTimer = null;
    }, 250);

    return { ok: true, action: wantPlay ? "play" : "pause" };
  }

  function handleCommand(
    command,
    seekSeconds = DEFAULT_SEEK_SECONDS,
    holdPlaybackRate = DEFAULT_HOLD_RATE
  ) {
    if (command === "next-video") {
      return triggerDouyinNextVideo();
    }

    const video = findVideo();
    if (!video) return { ok: false, error: "no-video" };
    const step = normalizeSeekSeconds(seekSeconds);
    const holdRate = normalizeHoldRate(holdPlaybackRate);

    switch (command) {
      case "seek-back":
        video.currentTime = Math.max(0, video.currentTime - step);
        return { ok: true, action: "seek-back" };
      case "seek-forward":
        return handleSeekForwardOrHoldRate(video, step, holdRate);
      case "toggle-play":
        return handleTogglePlay(video);
      default:
        return { ok: false, error: "unknown-command" };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "pip-controller") return false;
    sendResponse(
      handleCommand(
        message.command,
        message.seekSeconds,
        message.holdPlaybackRate
      )
    );
    return false;
  });

  const host = location.hostname;
  if (host.includes("bilibili") || host.includes("douyin")) {
    const applyUnlock = () => {
      document.querySelectorAll("video").forEach(unlockVideoForPip);
    };
    applyUnlock();
    new MutationObserver(applyUnlock).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disablePictureInPicture", "controlsList"],
    });
  }

  if (navigator.mediaSession?.setActionHandler) {
    try {
      navigator.mediaSession.setActionHandler("enterpictureinpicture", () => {
        const video = findVideo();
        if (!video) return;
        unlockVideoForPip(video);
        void video.requestPictureInPicture();
      });
    } catch {
      /* 部分页面无媒体会话 */
    }
  }
})();
