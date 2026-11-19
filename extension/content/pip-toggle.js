/**
 * Alt+W 注入脚本（MAIN world）。
 * 关闭：document.exitPictureInPicture() / documentPictureInPicture.window.close() / 点击退出按钮
 * 打开：点击播放器 PiP 按钮 → video.requestPictureInPicture()
 */
(function runPipToggle() {
  function hostKind() {
    const h = location.hostname.replace(/^www\./, "");
    if (h.includes("youtube.com")) return "youtube";
    if (h.includes("bilibili")) return "bilibili";
    if (h.includes("douyin.com")) return "douyin";
    return "generic";
  }

  function queryDeep(selector, root = document) {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const node of root.querySelectorAll?.("*") || []) {
      if (node.shadowRoot) {
        const found = queryDeep(selector, node.shadowRoot);
        if (found) return found;
      }
    }
    return null;
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

  function findLargestVideo() {
    if (document.pictureInPictureElement instanceof HTMLVideoElement) {
      return document.pictureInPictureElement;
    }
    const pipWin = globalThis.documentPictureInPicture?.window;
    if (pipWin) {
      const pipVideo = pipWin.document?.querySelector("video");
      if (pipVideo instanceof HTMLVideoElement) return pipVideo;
    }

    if (hostKind() === "douyin") {
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
    if (!videos.length) return null;
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

  function findDouyinPipIcon() {
    // 1. 最优先：从抖音当前激活的视频卡片 [data-e2e="feed-active-video"] 内查找
    const activeSlide = findActiveDouyinSlide();
    if (activeSlide) {
      const activeBtn = activeSlide.querySelector(
        "xg-icon.xgplayer-pip, .xgplayer-pip"
      );
      if (activeBtn instanceof HTMLElement) return activeBtn;
    }

    // 2. 其次：从当前播放的 video 所在的 xgplayer 容器内找 .xgplayer-pip
    const video = findLargestVideo();
    const playerContainer =
      video?.closest('[data-e2e="feed-active-video"]') ||
      video?.closest(".xgplayer") ||
      video?.closest("[data-e2e*='video-player']") ||
      video?.parentElement?.parentElement;
    if (playerContainer) {
      const scopedBtn = playerContainer.querySelector(
        "xg-icon.xgplayer-pip, .xgplayer-pip"
      );
      if (scopedBtn instanceof HTMLElement) return scopedBtn;
    }

    // 3. 兜底：在所有 .xgplayer-pip 中按所在播放器是否在视口及是否正在播放排序
    const allBtns = [
      ...document.querySelectorAll("xg-icon.xgplayer-pip, .xgplayer-pip"),
    ].filter((el) => el instanceof HTMLElement);
    if (!allBtns.length) return null;
    allBtns.sort((a, b) => {
      const scoreBtn = (btn) => {
        let s = 0;
        if (btn.closest?.('[data-e2e="feed-active-video"]')) s += 30;
        const player = btn.closest?.(".xgplayer") || btn;
        if (isInViewport(player)) s += 15;
        const v = player.querySelector?.("video");
        if (v && !v.paused) s += 20;
        return s;
      };
      return scoreBtn(b) - scoreBtn(a);
    });
    return allBtns[0];
  }

  function revealControls() {
    const kind = hostKind();
    if (kind === "youtube") {
      const root =
        document.getElementById("movie_player") ||
        document.querySelector(".html5-video-player");
      if (!root) return;
      root.classList.remove("ytp-autohide");
      root.querySelector(".ytp-chrome-bottom")?.classList.remove("ytp-autohide");
      root.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, cancelable: true })
      );
    }
    if (kind === "bilibili") {
      const root = document.querySelector(".bpx-player-container");
      root?.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, cancelable: true })
      );
    }
    if (kind === "douyin") {
      const activeSlide = findActiveDouyinSlide();
      const video = findLargestVideo();
      const root =
        activeSlide?.querySelector(".xgplayer") ||
        video?.closest(".xgplayer") ||
        document.querySelector(".xgplayer");
      root?.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, cancelable: true })
      );
    }
  }

  function triggerDouyinPipIconClick(btn) {
    if (!btn) return false;
    // 抖音 xgplayer 的小窗按钮点击事件有时绑定在内部 .xgplayer-icon 或 xg-icon 本体上，依次确保触发
    const iconDiv = btn.querySelector(".xgplayer-icon");
    if (iconDiv instanceof HTMLElement) {
      iconDiv.click();
    } else {
      btn.click();
    }
    return true;
  }

  function clickPipButton() {
    const kind = hostKind();
    revealControls();

    if (kind === "douyin") {
      const btn = findDouyinPipIcon();
      if (btn) {
        triggerDouyinPipIconClick(btn);
        return true;
      }
      return false;
    }

    const selectors =
      kind === "youtube"
        ? [
            "#movie_player button.ytp-pip-button",
            "button.ytp-pip-button",
            'button[aria-label*="Picture-in-Picture"]',
            'button[aria-label*="画中画"]',
          ]
        : [
            ".bpx-player-ctrl-pip",
            ".bcc-player-ctrl-pip",
            ".bilibili-player-video-btn-pip",
            'button[aria-label*="画中画"]',
          ];

    for (const sel of selectors) {
      const btn = queryDeep(sel);
      if (btn instanceof HTMLElement && !btn.disabled) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function unlockVideo(video) {
    video.removeAttribute("disablePictureInPicture");
    video.disablePictureInPicture = false;
    try {
      video.controlsList?.remove("nopictureinpicture");
    } catch {
      /* ignore */
    }
  }

  async function tryEnterNativePip() {
    const video = findLargestVideo();
    if (!video || !document.pictureInPictureEnabled) return false;
    unlockVideo(video);
    try {
      await video.requestPictureInPicture();
      return true;
    } catch {
      return false;
    }
  }

  async function togglePip() {
    // 1. 若开启了 Document Picture-in-Picture（抖音/新版播放器常用，小窗内带弹幕和自定义控件）
    const docPipWin = globalThis.documentPictureInPicture?.window;
    if (docPipWin) {
      if (hostKind() === "douyin") {
        const btn = findDouyinPipIcon();
        if (btn) {
          triggerDouyinPipIconClick(btn);
          if (!globalThis.documentPictureInPicture?.window) return;
        }
      }
      docPipWin.close();
      return;
    }

    // 2. 若开启了原生 Video Picture-in-Picture
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return;
    }

    // 3. 尝试点击播放器自身的画中画按钮
    const clicked = clickPipButton();
    if (clicked) {
      // 如果点击了抖音的 .xgplayer-pip 按钮后，由于页面在后台没有焦点或该条视频未挂载 Document PiP 导致小窗没有弹出，立刻在同一个用户手势周期内用原生 requestPictureInPicture 兜底！
      if (
        !globalThis.documentPictureInPicture?.window &&
        !document.pictureInPictureElement
      ) {
        await new Promise((r) => setTimeout(r, 40));
        if (
          !globalThis.documentPictureInPicture?.window &&
          !document.pictureInPictureElement
        ) {
          await tryEnterNativePip();
        }
      }
      return;
    }

    await tryEnterNativePip();
  }

  void togglePip();
})();
