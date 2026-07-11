const GroupCrypto = {
  keys: {},

  async importKey(b64) {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  },

  async exportKey(key) {
    const raw = await crypto.subtle.exportKey("raw", key);
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
  },

  async generateKey() {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    return key;
  },

  setGroupKey(groupId, key) {
    GroupCrypto.keys[groupId] = key;
  },

  hasKey(groupId) {
    return Boolean(GroupCrypto.keys[groupId]);
  },

  async seal(groupId, content) {
    const key = GroupCrypto.keys[groupId];
    if (!key) throw new Error("No group key");
    const body = typeof content === "string" ? { kind: "text", text: content } : content;
    const payload = JSON.stringify(body);
    const encoded = new TextEncoder().encode(payload);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    return {
      iv: Array.from(iv).map((b) => b.toString(16).padStart(2, "0")).join(""),
      ciphertext: Array.from(new Uint8Array(ciphertext)).map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
  },

  async open(groupId, envelope) {
    const key = GroupCrypto.keys[groupId];
    if (!key) throw new Error("No group key");
    const iv = new Uint8Array(envelope.iv.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const ct = new Uint8Array(envelope.ciphertext.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(decrypted));
  },

  wipeGroup(groupId) {
    delete GroupCrypto.keys[groupId];
  },

  wipeAll() {
    GroupCrypto.keys = {};
  },
};