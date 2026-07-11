const PACKET_SIZES = [512, 1024, 4096, 16384, 65536, 262144];
const CHUNK_DATA_BYTES = 180000;

const KoalaMix = {
  ratchets: {},
  _chunkBuffers: {},

  async initRatchet(myId, peerId, sharedBits) {
    if (KoalaMix.ratchets[peerId]) return;
    const sendLabel = myId < peerId ? "send" : "recv";
    const recvLabel = myId < peerId ? "recv" : "send";
    const sendChain = await KoalaMix._kdfMaterial(sharedBits, sendLabel);
    const recvChain = await KoalaMix._kdfMaterial(sharedBits, recvLabel);
    KoalaMix.ratchets[peerId] = {
      sendChain,
      recvChain,
      sendCounter: 0,
      recvCounter: 0,
      messageKeys: {},
    };
  },

  async _kdfMaterial(input, label) {
    const material = input instanceof ArrayBuffer ? input : await crypto.subtle.exportKey("raw", input);
    const key = await crypto.subtle.importKey(
      "raw",
      material,
      { name: "HKDF" },
      false,
      ["deriveBits"]
    );
    const info = new TextEncoder().encode(`koalamix:${label}`);
    return crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
      key,
      256
    );
  },

  async _deriveMessageKey(chainMaterial, counter) {
    const key = await crypto.subtle.importKey(
      "raw",
      chainMaterial,
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

  _generateChunkId() {
    const id = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(id).map((b) => b.toString(16).padStart(2, "0")).join("");
  },

  _bytesToBase64(bytes) {
    let binary = "";
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  },

  _base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  },

  _padToSize(data, targetSize) {
    const overhead = 96;
    const needed = targetSize - overhead;
    if (data.length > needed) {
      const larger = PACKET_SIZES.find((s) => s - overhead >= data.length);
      if (!larger || larger === targetSize) {
        throw new Error("Payload exceeds maximum packet size");
      }
      return KoalaMix._padToSize(data, larger);
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

  _maxSingleFramedBytes() {
    const maxPacket = PACKET_SIZES[PACKET_SIZES.length - 1];
    return maxPacket - 96 - 4;
  },

  async _sealPacket(peerId, body) {
    const ratchet = KoalaMix.ratchets[peerId];
    if (!ratchet) throw new Error("No ratchet for peer");

    const msgKey = await KoalaMix._deriveMessageKey(ratchet.sendChain, ratchet.sendCounter);
    ratchet.sendCounter++;

    const payload = JSON.stringify(body);
    const encoded = new TextEncoder().encode(payload);
    const framed = new Uint8Array(4 + encoded.length);
    new DataView(framed.buffer).setUint32(0, encoded.length);
    framed.set(encoded, 4);

    const packetSize = KoalaMix._selectPacketSize(framed.length);
    const padded = KoalaMix._padToSize(framed, packetSize);

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
      blind_token: body.token || "",
      ciphertext: Array.from(new Uint8Array(ciphertext)).map((b) => b.toString(16).padStart(2, "0")).join(""),
      iv: Array.from(iv).map((b) => b.toString(16).padStart(2, "0")).join(""),
      packet_size: packetSize,
      counter: ratchet.sendCounter - 1,
    };
  },

  async _openPacket(peerId, packet) {
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

    const plain = new Uint8Array(decrypted);
    if (plain.length < 4) throw new Error("Invalid message payload");
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const jsonLen = view.getUint32(0);
    if (jsonLen < 1 || 4 + jsonLen > plain.length) throw new Error("Invalid message payload");
    const jsonBytes = plain.subarray(4, 4 + jsonLen);
    const parsed = JSON.parse(new TextDecoder().decode(jsonBytes));
    ratchet.recvCounter = Math.max(ratchet.recvCounter, counter + 1);
    return parsed;
  },

  async seal(peerId, content) {
    const ratchet = KoalaMix.ratchets[peerId];
    if (!ratchet) throw new Error("No ratchet for peer");

    const blindToken = KoalaMix._generateBlindToken();
    const body = typeof content === "string" ? { kind: "text", text: content } : content;
    const payload = JSON.stringify({ ...body, token: blindToken });
    const encoded = new TextEncoder().encode(payload);

    if (encoded.length <= KoalaMix._maxSingleFramedBytes()) {
      const packet = await KoalaMix._sealPacket(peerId, { ...body, token: blindToken });
      return [packet];
    }

    const cid = KoalaMix._generateChunkId();
    const total = Math.ceil(encoded.length / CHUNK_DATA_BYTES);
    const envelopes = [];
    for (let i = 0; i < total; i++) {
      const slice = encoded.slice(i * CHUNK_DATA_BYTES, (i + 1) * CHUNK_DATA_BYTES);
      const chunkBody = {
        kind: "_chunk",
        cid,
        index: i,
        total,
        data: KoalaMix._bytesToBase64(slice),
        token: blindToken,
      };
      envelopes.push(await KoalaMix._sealPacket(peerId, chunkBody));
    }
    return envelopes;
  },

  async open(peerId, packet) {
    const parsed = await KoalaMix._openPacket(peerId, packet);
    if (parsed.kind !== "_chunk") return parsed;

    const bufKey = `${peerId}:${parsed.cid}`;
    if (!KoalaMix._chunkBuffers[bufKey]) {
      KoalaMix._chunkBuffers[bufKey] = { parts: {}, total: parsed.total, token: parsed.token };
    }
    const buf = KoalaMix._chunkBuffers[bufKey];
    buf.parts[parsed.index] = parsed.data;

    if (Object.keys(buf.parts).length < parsed.total) return null;

    const chunks = [];
    for (let i = 0; i < parsed.total; i++) {
      if (!buf.parts[i]) {
        delete KoalaMix._chunkBuffers[bufKey];
        throw new Error("Missing chunk");
      }
      chunks.push(KoalaMix._base64ToBytes(buf.parts[i]));
    }
    delete KoalaMix._chunkBuffers[bufKey];

    let totalLen = 0;
    chunks.forEach((c) => { totalLen += c.length; });
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    chunks.forEach((c) => {
      merged.set(c, offset);
      offset += c.length;
    });

    const full = JSON.parse(new TextDecoder().decode(merged));
    if (full.token !== parsed.token) throw new Error("Chunk token mismatch");
    delete full.token;
    return full;
  },

  wipePeer(peerId) {
    delete KoalaMix.ratchets[peerId];
    Object.keys(KoalaMix._chunkBuffers).forEach((k) => {
      if (k.startsWith(`${peerId}:`)) delete KoalaMix._chunkBuffers[k];
    });
  },

  wipeAll() {
    KoalaMix.ratchets = {};
    KoalaMix._chunkBuffers = {};
  },
};