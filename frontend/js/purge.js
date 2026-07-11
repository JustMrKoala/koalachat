const Purge = {
  async execute(accountId) {
    try {
      if (accountId) {
        // Notify server (via WS if live for immediate peer alerts + HTTP for reliable wipe)
        if (typeof WSClient !== "undefined") {
          try { WSClient.send({ type: "purge" }); } catch (_) {}
        }
        const payload = JSON.stringify({ account_id: accountId });
        if (navigator.sendBeacon) {
          try {
            navigator.sendBeacon("/api/purge", new Blob([payload], { type: "application/json" }));
          } catch (_) {}
        }
        try {
          await fetch("/api/purge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            keepalive: true,
          });
        } catch (_) {}
      }

      try {
        // Disconnect early to stop any further activity
        if (typeof WSClient !== "undefined" && WSClient.disconnect) {
          try { WSClient.disconnect(); } catch (_) {}
          if (WSClient) WSClient.outbox = [];
        }

        Purge._wipeLocalStorage();
        await Purge._wipeIndexedDB();
        await Purge._wipeCaches();
        if (typeof Friends !== "undefined" && Friends.wipe) Friends.wipe();
        if (typeof Groups !== "undefined" && Groups.wipe) Groups.wipe();
        if (typeof KoalaMix !== "undefined" && KoalaMix.wipeAll) KoalaMix.wipeAll();
        if (typeof Messages !== "undefined" && Messages.wipe) Messages.wipe();

        if ("serviceWorker" in navigator) {
          try {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const reg of regs) await reg.unregister();
          } catch (_) {}
        }
      } catch (_) {
        // still reset
      }
    } finally {
      // Always force a reload to reset UI even if something errored
      setTimeout(() => { window.location.reload(); }, 120);
    }
  },

  _wipeLocalStorage() {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.startsWith("koala_")) {
        const val = localStorage.getItem(key);
        if (val) {
          const overwrite = "0".repeat(val.length);
          localStorage.setItem(key, overwrite);
        }
        localStorage.removeItem(key);
      }
    }
  },

  async _wipeIndexedDB() {
    if (!("indexedDB" in window)) return;
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name && db.name.startsWith("koala")) {
        indexedDB.deleteDatabase(db.name);
      }
    }
  },

  async _wipeCaches() {
    if (!("caches" in window)) return;
    const names = await caches.keys();
    for (const name of names) {
      if (name.startsWith("koala")) await caches.delete(name);
    }
  },
};