import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
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
    KoalaMix.ratchets[peerId] = { sendChain, recvChain, sendCounter: 0, recvCounter: 0 };
  },

  async _kdfMaterial(input, label) {
    const material = input instanceof ArrayBuffer ? input : await subtle.exportKey("raw", input);
    const key = await subtle.importKey("raw", material, { name: "HKDF" }, false, ["deriveBits"]);
    const info = new TextEncoder().encode(`koalamix:${label}`);
    return subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info }, key, 256);
  },

  async _deriveMessageKey(chainMaterial, counter) {
    const key = await subtle.importKey("raw", chainMaterial, { name: "HKDF" }, false, ["deriveBits"]);
    const counterBuf = new ArrayBuffer(8);
    new DataView(counterBuf).setBigUint64(0, BigInt(counter));
    const info = new Uint8Array([...new TextEncoder().encode("msgkey"), ...new Uint8Array(counterBuf)]);
    const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info }, key, 256);
    return subtle.importKey("raw", bits, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  },

  _generateBlindToken() {
    return Array.from(webcrypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
  },

  _generateChunkId() {
    return Array.from(webcrypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
  },

  _bytesToBase64(bytes) {
    return Buffer.from(bytes).toString("base64");
  },

  _base64ToBytes(b64) {
    return new Uint8Array(Buffer.from(b64, "base64"));
  },

  _padToSize(data, targetSize) {
    const overhead = 96;
    const needed = targetSize - overhead;
    if (data.length > needed) {
      const larger = PACKET_SIZES.find((s) => s - overhead >= data.length);
      if (!larger || larger === targetSize) throw new Error("Payload exceeds maximum packet size");
      return KoalaMix._padToSize(data, larger);
    }
    const padded = new Uint8Array(needed);
    padded.set(data);
    const padLen = needed - data.length;
    if (padLen > 0) padded.set(webcrypto.getRandomValues(new Uint8Array(padLen)), data.length);
    return padded;
  },

  _selectPacketSize(dataLen) {
    const overhead = 96;
    for (const size of PACKET_SIZES) if (size - overhead >= dataLen) return size;
    return PACKET_SIZES[PACKET_SIZES.length - 1];
  },

  _maxSingleFramedBytes() {
    return PACKET_SIZES[PACKET_SIZES.length - 1] - 96 - 4;
  },

  async _sealPacket(peerId, body) {
    const ratchet = KoalaMix.ratchets[peerId];
    const msgKey = await KoalaMix._deriveMessageKey(ratchet.sendChain, ratchet.sendCounter);
    ratchet.sendCounter++;
    const encoded = new TextEncoder().encode(JSON.stringify(body));
    const framed = new Uint8Array(4 + encoded.length);
    new DataView(framed.buffer).setUint32(0, encoded.length);
    framed.set(encoded, 4);
    const packetSize = KoalaMix._selectPacketSize(framed.length);
    const padded = KoalaMix._padToSize(framed, packetSize);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, msgKey, padded);
    return {
      ciphertext: Array.from(new Uint8Array(ciphertext)).map((b) => b.toString(16).padStart(2, "0")).join(""),
      iv: Array.from(iv).map((b) => b.toString(16).padStart(2, "0")).join(""),
      counter: ratchet.sendCounter - 1,
    };
  },

  async _openPacket(peerId, packet) {
    const ratchet = KoalaMix.ratchets[peerId];
    const msgKey = await KoalaMix._deriveMessageKey(ratchet.recvChain, packet.counter);
    const iv = new Uint8Array(packet.iv.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const ct = new Uint8Array(packet.ciphertext.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const decrypted = await subtle.decrypt({ name: "AES-GCM", iv }, msgKey, ct);
    const plain = new Uint8Array(decrypted);
    const jsonLen = new DataView(plain.buffer).getUint32(0);
    const parsed = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + jsonLen)));
    ratchet.recvCounter = Math.max(ratchet.recvCounter, packet.counter + 1);
    return parsed;
  },

  async seal(peerId, content) {
    const blindToken = KoalaMix._generateBlindToken();
    const body = typeof content === "string" ? { kind: "text", text: content } : content;
    const encoded = new TextEncoder().encode(JSON.stringify({ ...body, token: blindToken }));
    if (encoded.length <= KoalaMix._maxSingleFramedBytes()) {
      return [await KoalaMix._sealPacket(peerId, { ...body, token: blindToken })];
    }
    const cid = KoalaMix._generateChunkId();
    const total = Math.ceil(encoded.length / CHUNK_DATA_BYTES);
    const envelopes = [];
    for (let i = 0; i < total; i++) {
      const slice = encoded.slice(i * CHUNK_DATA_BYTES, (i + 1) * CHUNK_DATA_BYTES);
      envelopes.push(await KoalaMix._sealPacket(peerId, {
        kind: "_chunk", cid, index: i, total, data: KoalaMix._bytesToBase64(slice), token: blindToken,
      }));
    }
    return envelopes;
  },

  async open(peerId, packet) {
    const parsed = await KoalaMix._openPacket(peerId, packet);
    if (parsed.kind !== "_chunk") return parsed;
    const bufKey = `${peerId}:${parsed.cid}`;
    if (!KoalaMix._chunkBuffers[bufKey]) KoalaMix._chunkBuffers[bufKey] = { parts: {}, total: parsed.total };
    const buf = KoalaMix._chunkBuffers[bufKey];
    buf.parts[parsed.index] = parsed.data;
    if (Object.keys(buf.parts).length < parsed.total) return null;
    const chunks = [];
    for (let i = 0; i < parsed.total; i++) chunks.push(KoalaMix._base64ToBytes(buf.parts[i]));
    delete KoalaMix._chunkBuffers[bufKey];
    let totalLen = 0;
    chunks.forEach((c) => { totalLen += c.length; });
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    chunks.forEach((c) => { merged.set(c, offset); offset += c.length; });
    const full = JSON.parse(new TextDecoder().decode(merged));
    delete full.token;
    return full;
  },
};

const E2EE = {
  async generateKeyPair() {
    return subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
  },
  async exportPublicKey(key) {
    return Buffer.from(await subtle.exportKey("raw", key)).toString("hex");
  },
  async importPublicKey(hex) {
    return subtle.importKey("raw", Buffer.from(hex, "hex"), { name: "ECDH", namedCurve: "P-256" }, true, []);
  },
  async deriveSharedBits(privateKey, publicKey) {
    return subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  },
};

const idA = "1000000000000001";
const idB = "2000000000000002";
const kpA = await E2EE.generateKeyPair();
const kpB = await E2EE.generateKeyPair();
const pubA = await E2EE.exportPublicKey(kpA.publicKey);
const pubB = await E2EE.exportPublicKey(kpB.publicKey);

const sharedA = await E2EE.deriveSharedBits(kpA.privateKey, await E2EE.importPublicKey(pubB));
const sharedB = await E2EE.deriveSharedBits(kpB.privateKey, await E2EE.importPublicKey(pubA));
await KoalaMix.initRatchet(idA, idB, sharedA);
await KoalaMix.initRatchet(idB, idA, sharedB);

const bigData = "A".repeat(400000);
const envelopes = await KoalaMix.seal(idB, { kind: "image", data: bigData, mime: "image/jpeg" });
if (envelopes.length < 2) throw new Error("Expected chunked envelopes");

let result = null;
for (const env of envelopes) {
  const partial = await KoalaMix.open(idA, JSON.parse(JSON.stringify(env)));
  if (partial) result = partial;
}
if (!result || result.data !== bigData) throw new Error("Chunk reassembly failed");
console.log("chunk round-trip ok", envelopes.length, "packets");