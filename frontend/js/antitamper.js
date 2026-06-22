const AntiTamper = {
  active: false,

  init() {
    AntiTamper.active = true;
    document.addEventListener("visibilitychange", AntiTamper._onVisibility);
    document.addEventListener("contextmenu", AntiTamper._blockContext);
    document.addEventListener("keydown", AntiTamper._blockKeys);
    AntiTamper._detectScreenCapture();
    AntiTamper._applyStyles();
  },

  _applyStyles() {
    const style = document.createElement("style");
    style.id = "antitamper-style";
    style.textContent = `
      .chat-messages, .message-bubble, .message-text {
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

  _onVisibility() {
    const chat = document.querySelector(".chat-messages");
    if (!chat) return;
    if (document.hidden) {
      chat.classList.add("antitamper-blur");
    } else {
      chat.classList.remove("antitamper-blur");
    }
  },

  _blockContext(e) {
    if (e.target.closest(".chat-messages, .message-bubble")) {
      e.preventDefault();
    }
  },

  _blockKeys(e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "s" || e.key === "c")) {
      if (document.querySelector(".chat-view:not(.hidden)")) {
        e.preventDefault();
      }
    }
    if (e.key === "PrintScreen") {
      e.preventDefault();
      navigator.clipboard.writeText("").catch(() => {});
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

  _onCaptureDetected() {
    const overlay = document.getElementById("capture-warning");
    if (overlay) {
      overlay.classList.remove("hidden");
      setTimeout(() => overlay.classList.add("hidden"), 5000);
    }
    document.querySelectorAll(".message-bubble").forEach((el) => {
      el.classList.add("antitamper-blur");
      setTimeout(() => el.classList.remove("antitamper-blur"), 10000);
    });
  },

  destroy() {
    AntiTamper.active = false;
    const style = document.getElementById("antitamper-style");
    if (style) style.remove();
  },
};