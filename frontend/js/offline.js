const Offline = {
  visible: false,
  checking: false,

  init() {
    window.addEventListener("online", () => Offline._onOnline());
    window.addEventListener("offline", () => Offline.show());
    document.getElementById("btn-offline-retry").onclick = () => Offline.retry();
    Offline._sync();
  },

  _sync() {
    if (!navigator.onLine) Offline.show();
    else Offline.hide();
  },

  show() {
    document.getElementById("offline-screen").classList.remove("hidden");
    document.body.classList.add("offline-active");
    Offline.visible = true;
  },

  hide() {
    document.getElementById("offline-screen").classList.add("hidden");
    document.body.classList.remove("offline-active");
    Offline.visible = false;
  },

  async _onOnline() {
    await Offline.retry();
  },

  async retry() {
    if (!navigator.onLine) return;
    const btn = document.getElementById("btn-offline-retry");
    const label = btn.querySelector(".btn-label");
    const prev = label.textContent;
    btn.disabled = true;
    Offline.checking = true;
    label.textContent = "Checking...";
    let ok = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch("/health", { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      ok = res.ok;
    } catch (_) {}
    btn.disabled = false;
    Offline.checking = false;
    label.textContent = prev;
    if (ok) {
      Offline.hide();
      if (typeof App !== "undefined" && App.accountId && typeof WSClient !== "undefined") {
        WSClient.connect(App.accountId);
      }
    }
  },
};