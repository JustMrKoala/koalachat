const E2EE = {
  async generateKeyPair() {
    return crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );
  },

  async exportPublicKey(key) {
    const raw = await crypto.subtle.exportKey("raw", key);
    return E2EE.bufToHex(raw);
  },

  async importPublicKey(hex) {
    const raw = E2EE.hexToBuf(hex);
    return crypto.subtle.importKey(
      "raw",
      raw,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );
  },

  async deriveSharedBits(privateKey, publicKey) {
    return crypto.subtle.deriveBits(
      { name: "ECDH", public: publicKey },
      privateKey,
      256
    );
  },

  async deriveSharedKey(privateKey, publicKey) {
    const bits = await E2EE.deriveSharedBits(privateKey, publicKey);
    return crypto.subtle.importKey(
      "raw",
      bits,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  },

  async fingerprint(publicKeyHex) {
    const raw = E2EE.hexToBuf(publicKeyHex);
    const hash = await crypto.subtle.digest("SHA-256", raw);
    return E2EE.bufToHex(hash);
  },

  async encrypt(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoded
    );
    return {
      ciphertext: E2EE.bufToHex(ciphertext),
      iv: E2EE.bufToHex(iv),
    };
  },

  async decrypt(key, ciphertextHex, ivHex) {
    const ciphertext = E2EE.hexToBuf(ciphertextHex);
    const iv = E2EE.hexToBuf(ivHex);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  },

  bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  },

  hexToBuf(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes.buffer;
  },

  secureWipe(obj) {
    if (obj instanceof ArrayBuffer) {
      new Uint8Array(obj).fill(0);
    } else if (typeof obj === "string") {
      return "";
    }
  },
};