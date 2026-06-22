const AntiTamper = {
  active: false,
  shieldLocked: false,
  captureCooldown: false,
  shieldTimer: null,

  init() {
    AntiTamper.active = true;
    document.addEventListener("visibilitychange", AntiTamper._onVisibility);
    window.addEventListener("blur", AntiTamper._onWindowBlur);
    window.addEventListener("focus", AntiTamper._onWindowFocus);
    document.addEventListener("contextmenu", AntiTamper._blockContext);
    document.addEventListener("keydown", AntiTamper._blockKeys, true);
    document.addEventListener("keyup", AntiTamper._onKeyUp, true);
    document.addEventListener("copy", AntiTamper._blockCopy, true);
    document.addEventListener("cut", AntiTamper._blockCopy, true);
    document.addEventListener("dragstart", AntiTamper._blockDrag, true);
    window.addEventListener("beforeprint", AntiTamper._onBeforePrint);
    AntiTamper._detectScreenCapture();
    AntiTamper._applyStyles();
    AntiTamper._syncShield();
  },

  _applyStyles() {
    const style = document.createElement("style");
    style.id = "antitamper-style";
    style.textContent = `
      .chat-messages, .message-bubble, .message-text,
      .friend-code, .account-id-private, .account-strip,
      .chat-item, .request-item {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
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

  _onVisibility() {
    if (!AntiTamper._isSensitive()) return;
    if (document.hidden) {
      AntiTamper._engageShield();
    } else {
      AntiTamper._releaseShield();
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

  _onBeforePrint(e) {
    if (!AntiTamper._isSensitive()) return;
    e.preventDefault();
    AntiTamper._onCaptureDetected();
  },

  _blockContext(e) {
    if (!AntiTamper._isSensitive()) return;
    if (e.target.closest(".chat-messages, .message-bubble, .account-strip, .friend-code, .account-id-private, .chat-item, .request-item")) {
      e.preventDefault();
    }
  },

  _blockCopy(e) {
    if (!AntiTamper._isSensitive()) return;
    if (e.target.closest(".chat-messages, .message-bubble, .account-strip, .friend-code, .account-id-private, .chat-item, .request-item")) {
      e.preventDefault();
    }
  },

  _blockDrag(e) {
    if (!AntiTamper._isSensitive()) return;
    if (e.target.closest(".chat-messages, .message-bubble, .account-strip, .friend-code, .account-id-private")) {
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
      AntiTamper._onCaptureDetected();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ["p", "s", "c", "u"].includes(e.key.toLowerCase())) {
      if (document.querySelector("#chat-view:not(.hidden), .chat-messages, .account-strip")) {
        e.preventDefault();
      }
    }
  },

  _onKeyUp(e) {
    if (!AntiTamper._isSensitive()) return;
    if (e.key === "PrintScreen" || AntiTamper._isCaptureShortcut(e)) {
      AntiTamper._onCaptureDetected();
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
      AntiTamper._onCaptureDetected();
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
      AntiTamper.shieldLocked || document.hidden || !document.hasFocus()
    );
    shield.classList.toggle("hidden", !show);
    shield.setAttribute("aria-hidden", show ? "false" : "true");
    const shell = document.getElementById("app-shell");
    if (shell) shell.classList.toggle("antitamper-blur", show);
  },

  _onCaptureDetected() {
    AntiTamper.captureCooldown = true;
    AntiTamper._engageShield();
    const overlay = document.getElementById("capture-warning");
    if (overlay) {
      overlay.classList.remove("hidden");
      setTimeout(() => overlay.classList.add("hidden"), 5000);
    }
    document.querySelectorAll(".message-bubble, .account-strip, .chat-messages").forEach((el) => {
      el.classList.add("antitamper-blur");
    });
    if (AntiTamper.shieldTimer) clearTimeout(AntiTamper.shieldTimer);
    AntiTamper.shieldTimer = setTimeout(() => {
      AntiTamper.shieldTimer = null;
      AntiTamper.captureCooldown = false;
      document.querySelectorAll(".message-bubble, .account-strip, .chat-messages").forEach((el) => {
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
    if (AntiTamper.shieldTimer) {
      clearTimeout(AntiTamper.shieldTimer);
      AntiTamper.shieldTimer = null;
    }
    const style = document.getElementById("antitamper-style");
    if (style) style.remove();
    const shield = document.getElementById("capture-shield");
    if (shield) shield.classList.add("hidden");
    const shell = document.getElementById("app-shell");
    if (shell) shell.classList.remove("antitamper-blur");
  },
};