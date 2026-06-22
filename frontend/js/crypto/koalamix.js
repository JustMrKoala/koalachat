const PACKET_SIZES = [512, 1024, 2048, 4096];

const KoalaMix = {
  ratchets: {},

  async initRatchet(myId, peerId, sharedBits) {
    const sendLabel = myId < peerId ? "send" : "recv";
    const recvLabel = myId < peerId ? "recv" : "send";
    const sendChain = await KoalaMix._kdf(sharedBits, sendLabel);
    const recvChain = await KoalaMix._kdf(sharedBits, recvLabel);
    KoalaMix.ratchets[peerId] = {
      sendChain,
      recvChain,
      sendCounter: 0,
      recvCounter: 0,
      messageKeys: {},
    };
  },

  async _kdf(input, label) {
    const material = input instanceof ArrayBuffer ? input : await crypto.subtle.exportKey("raw", input);
    const key = await crypto.subtle.importKey(
      "raw",
      material,
      { name: "HKDF" },
      false,
      ["deriveBits"]
    );
    const info = new TextEncoder().encode(`koalamix:${label}`);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
      key,
      256
    );
    return crypto.subtle.importKey(
      "raw",
      bits,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  },

  async _deriveMessageKey(chainKey, counter) {
    const raw = await crypto.subtle.exportKey("raw", chainKey);
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HKDF" },
      false,
      ["deriveBits"]
    );
    const counterBuf = new ArrayBuffer(8);
    new DataView(counterBuf).setBigUint64(0, BigInt(counter));
    const info = new Uint8Array([...new TextEncoder().encode("msgkey"), ...new Uint8Array(counterBuf)]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
      key,
      256
    );
    return crypto.subtle.importKey(
      "raw",
      bits,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  },

  _generateBlindToken() {
    const token = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(token).map((b) => b.toString(16).padStart(2, "0")).join("");
  },

  _padToSize(data, targetSize) {
    const overhead = 96;
    const needed = targetSize - overhead;
    if (data.length > needed) {
      const larger = PACKET_SIZES.find((s) => s - overhead >= data.length);
      return KoalaMix._padToSize(data, larger || PACKET_SIZES[PACKET_SIZES.length - 1]);
    }
    const padded = new Uint8Array(needed);
    padded.set(data);
    const padLen = needed - data.length;
    if (padLen > 0) {
      const padBytes = crypto.getRandomValues(new Uint8Array(padLen));
      padded.set(padBytes, data.length);
    }
    return padded;
  },

  _selectPacketSize(dataLen) {
    const overhead = 96;
    for (const size of PACKET_SIZES) {
      if (size - overhead >= dataLen) return size;
    }
    return PACKET_SIZES[PACKET_SIZES.length - 1];
  },

  async seal(peerId, plaintext) {
    const ratchet = KoalaMix.ratchets[peerId];
    if (!ratchet) throw new Error("No ratchet for peer");

    const msgKey = await KoalaMix._deriveMessageKey(ratchet.sendChain, ratchet.sendCounter);
    ratchet.sendCounter++;

    const blindToken = KoalaMix._generateBlindToken();
    const payload = JSON.stringify({ text: plaintext, token: blindToken });
    const encoded = new TextEncoder().encode(payload);

    const packetSize = KoalaMix._selectPacketSize(encoded.length);
    const padded = KoalaMix._padToSize(encoded, packetSize);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      msgKey,
      padded
    );

    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, ratchet.sendCounter - 1);
    new DataView(header.buffer).setUint32(4, packetSize);

    return {
      header: Array.from(header).map((b) => b.toString(16).padStart(2, "0")).join(""),
      blind_token: blindToken,
      ciphertext: Array.from(new Uint8Array(ciphertext)).map((b) => b.toString(16).padStart(2, "0")).join(""),
      iv: Array.from(iv).map((b) => b.toString(16).padStart(2, "0")).join(""),
      packet_size: packetSize,
      counter: ratchet.sendCounter - 1,
    };
  },

  async open(peerId, packet) {
    const ratchet = KoalaMix.ratchets[peerId];
    if (!ratchet) throw new Error("No ratchet for peer");

    const counter = packet.counter;
    const msgKey = await KoalaMix._deriveMessageKey(ratchet.recvChain, counter);

    const iv = new Uint8Array(packet.iv.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const ct = new Uint8Array(packet.ciphertext.match(/.{2}/g).map((h) => parseInt(h, 16)));

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      msgKey,
      ct
    );

    const payload = new TextDecoder().decode(decrypted);
    const parsed = JSON.parse(payload.replace(/\0+$/, ""));
    ratchet.recvCounter = Math.max(ratchet.recvCounter, counter + 1);
    return parsed.text;
  },

  wipePeer(peerId) {
    delete KoalaMix.ratchets[peerId];
  },

  wipeAll() {
    KoalaMix.ratchets = {};
  },
};