const Purge = {
  async execute(accountId) {
    WSClient.send({ type: "purge" });

    try {
      await fetch("/api/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId }),
      });
    } catch (_) {}

    Purge._wipeLocalStorage();
    Purge._wipeIndexedDB();
    Purge._wipeCaches();
    Friends.wipe();
    KoalaMix.wipeAll();
    Messages.wipe();
    WSClient.disconnect();

    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) await reg.unregister();
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