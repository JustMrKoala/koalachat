const AntiTamper = {
  active: false,
  shieldLocked: false,
  captureCooldown: false,
  shieldTimer: null,
  warningTimer: null,
  hiddenAt: null,

  _messages: {
    shortcut: "Screenshot shortcut detected content hidden",
    "screen-share": "Screen recording detected content hidden",
    print: "Print attempt blocked content hidden",
    zoom: "Screen magnification detected content hidden",
    suspected: "Possible screenshot content hidden for protection",
    default: "Screen capture detected content hidden",
  },

  init() {
    AntiTamper.active = true;
    document.addEventListener("visibilitychange", AntiTamper._onVisibility);
    window.addEventListener("blur", AntiTamper._onWindowBlur);
    window.addEventListener("focus", AntiTamper._onWindowFocus);
    window.addEventListener("pagehide", AntiTamper._onPageHide);
    document.addEventListener("pointerdown", AntiTamper._onPointerDown, true);
    document.addEventListener("contextmenu", AntiTamper._blockContext);
    document.addEventListener("keydown", AntiTamper._blockKeys, true);
    document.addEventListener("keyup", AntiTamper._onKeyUp, true);
    document.addEventListener("copy", AntiTamper._blockCopy, true);
    document.addEventListener("cut", AntiTamper._blockCopy, true);
    document.addEventListener("dragstart", AntiTamper._blockDrag, true);
    document.addEventListener("touchmove", AntiTamper._blockTouchMove, { passive: false });
    window.addEventListener("beforeprint", AntiTamper._onBeforePrint);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", AntiTamper._onViewportResize);
    }
    AntiTamper._detectScreenCapture();
    AntiTamper._applyStyles();
    AntiTamper._syncShield();
  },

  _applyStyles() {
    const style = document.createElement("style");
    style.id = "antitamper-style";
    style.textContent = `
      html, body, #app-shell {
        overscroll-behavior: none;
        touch-action: manipulation;
      }
      .chat-messages, .message-bubble, .message-text,
      .message-image, .account-card, .chat-item, .request-item {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
      }
      .message-image {
        -webkit-user-drag: none;
        user-drag: none;
        pointer-events: none;
      }
      @supports (-webkit-touch-callout: none) {
        html, body {
          position: fixed;
          inset: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
        }
        #app-shell {
          height: 100%;
          height: 100dvh;
        }
      }
      @media print {
        body { display: none !important; }
      }
    `;
    document.head.appendChild(style);
  },

  _isSensitive() {
    const main = document.getElementById("main-view");
    return main && !main.classList.contains("hidden");
  },

  _isTouchDevice() {
    return "ontouchstart" in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
  },

  _onVisibility() {
    if (!AntiTamper._isSensitive()) return;
    if (document.hidden) {
      AntiTamper.hiddenAt = Date.now();
      AntiTamper._engageShield();
    } else {
      const elapsed = AntiTamper.hiddenAt ? Date.now() - AntiTamper.hiddenAt : 0;
      AntiTamper.hiddenAt = null;
      if (
        AntiTamper._isTouchDevice()
        && elapsed >= 100
        && elapsed <= 3000
        && !AntiTamper.captureCooldown
      ) {
        AntiTamper._onCaptureDetected("suspected");
      } else if (!AntiTamper.captureCooldown) {
        AntiTamper._releaseShield();
      }
    }
  },

  _onWindowBlur() {
    if (!AntiTamper._isSensitive()) return;
    AntiTamper._engageShield();
  },

  _onWindowFocus() {
    if (!AntiTamper.captureCooldown) {
      AntiTamper._releaseShield();
    }
  },

  _onPageHide() {
    if (!AntiTamper._isSensitive()) return;
    AntiTamper._engageShield();
  },

  _onViewportResize() {
    if (!AntiTamper._isSensitive()) return;
    if (window.visualViewport && window.visualViewport.scale > 1.02) {
      AntiTamper._onCaptureDetected("zoom");
    }
  },

  _blockTouchMove(e) {
    if (!AntiTamper._isSensitive()) return;
    const t = e.target;
    if (t.closest("button, a, [role=\"button\"], .btn, .toolbar-btn, .header-btn, .compose-action-btn, .send-btn, .chat-item-remove, .copy-btn, input, textarea, select")) {
      return;
    }
    if (!t.closest(".chat-messages, .chat-list, .sheet-content, .requests-list")) {
      e.preventDefault();
    }
  },

  _onPointerDown() {
    if (!AntiTamper._isSensitive() || AntiTamper.captureCooldown) return;
    if (document.hasFocus() && !document.hidden) {
      AntiTamper._releaseShield();
    }
  },

  onViewChange() {
    AntiTamper._syncShield();
  },

  _onBeforePrint(e) {
    if (!AntiTamper._isSensitive()) return;
    e.preventDefault();
    AntiTamper._onCaptureDetected("print");
  },

  _blockContext(e) {
    if (!AntiTamper._isSensitive()) return;
    if (e.target.closest(".chat-messages, .message-bubble, .account-card, .chat-item, .request-item")) {
      e.preventDefault();
    }
  },

  _blockCopy(e) {
    if (!AntiTamper._isSensitive()) return;
    if (e.target.closest(".chat-messages, .message-bubble, .account-card, .chat-item, .request-item")) {
      e.preventDefault();
    }
  },

  _blockDrag(e) {
    if (!AntiTamper._isSensitive()) return;
    if (e.target.closest(".chat-messages, .message-bubble, .message-image, .account-card")) {
      e.preventDefault();
    }
  },

  _isCaptureShortcut(e) {
    if (e.key === "PrintScreen") return true;
    const osDown = typeof e.getModifierState === "function" && e.getModifierState("OS");
    const snip = e.key.toLowerCase() === "s" && e.shiftKey && (e.metaKey || osDown);
    if (snip) return true;
    const gameBar = e.key.toLowerCase() === "g" && e.metaKey;
    if (gameBar) return true;
    return false;
  },

  _blockKeys(e) {
    if (!AntiTamper._isSensitive()) return;
    if (AntiTamper._isCaptureShortcut(e)) {
      e.preventDefault();
      AntiTamper._onCaptureDetected("shortcut");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ["p", "s", "c", "u"].includes(e.key.toLowerCase())) {
      if (document.querySelector("#chat-view:not(.hidden), .chat-messages, .account-card")) {
        e.preventDefault();
      }
    }
  },

  _onKeyUp(e) {
    if (!AntiTamper._isSensitive()) return;
    if (e.key === "PrintScreen" || AntiTamper._isCaptureShortcut(e)) {
      AntiTamper._onCaptureDetected("shortcut");
      AntiTamper._clearClipboard();
    }
  },

  _clearClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText("").catch(() => {});
    if (navigator.clipboard.write) {
      try {
        const blank = new ClipboardItem({
          "text/plain": new Blob([""], { type: "text/plain" }),
        });
        navigator.clipboard.write([blank]).catch(() => {});
      } catch (_) {}
    }
  },

  _detectScreenCapture() {
    if (!navigator.mediaDevices) return;
    const original = navigator.mediaDevices.getDisplayMedia;
    if (!original) return;
    navigator.mediaDevices.getDisplayMedia = function (...args) {
      AntiTamper._onCaptureDetected("screen-share");
      return original.apply(navigator.mediaDevices, args);
    };
  },

  _engageShield() {
    AntiTamper.shieldLocked = true;
    AntiTamper._syncShield();
  },

  _releaseShield() {
    if (AntiTamper.captureCooldown) return;
    AntiTamper.shieldLocked = false;
    if (AntiTamper.shieldTimer) {
      clearTimeout(AntiTamper.shieldTimer);
      AntiTamper.shieldTimer = null;
    }
    AntiTamper._syncShield();
  },

  _syncShield() {
    const shield = document.getElementById("capture-shield");
    if (!shield) return;
    const show = AntiTamper.active && AntiTamper._isSensitive() && (
      AntiTamper.shieldLocked || document.hidden
    );
    shield.classList.toggle("hidden", !show);
    shield.setAttribute("aria-hidden", show ? "false" : "true");
    const shell = document.getElementById("app-shell");
    if (shell) shell.classList.toggle("antitamper-blur", show);
  },

  _showCaptureFeedback(reason) {
    const message = AntiTamper._messages[reason] || AntiTamper._messages.default;
    const overlay = document.getElementById("capture-warning");
    const text = document.getElementById("capture-warning-text");
    if (text) text.textContent = message;
    if (overlay) {
      overlay.classList.remove("hidden");
      if (AntiTamper.warningTimer) clearTimeout(AntiTamper.warningTimer);
      AntiTamper.warningTimer = setTimeout(() => {
        AntiTamper.warningTimer = null;
        overlay.classList.add("hidden");
      }, 6000);
    }
    if (typeof App !== "undefined" && App._toast) {
      App._toast(message);
    }
    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }
  },

  _onCaptureDetected(reason = "default") {
    AntiTamper.captureCooldown = true;
    AntiTamper._engageShield();
    AntiTamper._showCaptureFeedback(reason);
    document.querySelectorAll(".message-bubble, .account-card, .chat-messages").forEach((el) => {
      el.classList.add("antitamper-blur");
    });
    if (AntiTamper.shieldTimer) clearTimeout(AntiTamper.shieldTimer);
    AntiTamper.shieldTimer = setTimeout(() => {
      AntiTamper.shieldTimer = null;
      AntiTamper.captureCooldown = false;
      document.querySelectorAll(".message-bubble, .account-card, .chat-messages").forEach((el) => {
        el.classList.remove("antitamper-blur");
      });
      if (document.hasFocus() && !document.hidden) {
        AntiTamper.shieldLocked = false;
        AntiTamper._syncShield();
      }
    }, 12000);
  },

  destroy() {
    AntiTamper.active = false;
    AntiTamper.captureCooldown = false;
    AntiTamper.shieldLocked = false;
    AntiTamper.hiddenAt = null;
    if (AntiTamper.shieldTimer) {
      clearTimeout(AntiTamper.shieldTimer);
      AntiTamper.shieldTimer = null;
    }
    if (AntiTamper.warningTimer) {
      clearTimeout(AntiTamper.warningTimer);
      AntiTamper.warningTimer = null;
    }
    const style = document.getElementById("antitamper-style");
    if (style) style.remove();
    const shield = document.getElementById("capture-shield");
    if (shield) shield.classList.add("hidden");
    const warning = document.getElementById("capture-warning");
    if (warning) warning.classList.add("hidden");
    const shell = document.getElementById("app-shell");
    if (shell) shell.classList.remove("antitamper-blur");
  },
};