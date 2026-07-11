import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const PACKET_SIZES = [512, 1024, 2048, 4096];

const KoalaMix = {
  ratchets: {},

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
    };
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
    const token = webcrypto.getRandomValues(new Uint8Array(32));
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
      const padBytes = webcrypto.getRandomValues(new Uint8Array(padLen));
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
    const msgKey = await KoalaMix._deriveMessageKey(ratchet.sendChain, ratchet.sendCounter);
    ratchet.sendCounter++;
    const blindToken = KoalaMix._generateBlindToken();
    const payload = JSON.stringify({ text: plaintext, token: blindToken });
    const encoded = new TextEncoder().encode(payload);
    const framed = new Uint8Array(4 + encoded.length);
    new DataView(framed.buffer).setUint32(0, encoded.length);
    framed.set(encoded, 4);
    const packetSize = KoalaMix._selectPacketSize(framed.length);
    const padded = KoalaMix._padToSize(framed, packetSize);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, msgKey, padded);
    return {
      header: "",
      blind_token: blindToken,
      ciphertext: Array.from(new Uint8Array(ciphertext)).map((b) => b.toString(16).padStart(2, "0")).join(""),
      iv: Array.from(iv).map((b) => b.toString(16).padStart(2, "0")).join(""),
      packet_size: packetSize,
      counter: ratchet.sendCounter - 1,
    };
  },

  async open(peerId, packet) {
    const ratchet = KoalaMix.ratchets[peerId];
    const counter = packet.counter;
    const msgKey = await KoalaMix._deriveMessageKey(ratchet.recvChain, counter);
    const iv = new Uint8Array(packet.iv.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const ct = new Uint8Array(packet.ciphertext.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const decrypted = await subtle.decrypt({ name: "AES-GCM", iv }, msgKey, ct);
    const plain = new Uint8Array(decrypted);
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const jsonLen = view.getUint32(0);
    const jsonBytes = plain.subarray(4, 4 + jsonLen);
    const parsed = JSON.parse(new TextDecoder().decode(jsonBytes));
    return parsed.text;
  },
};

const E2EE = {
  async generateKeyPair() {
    return subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
  },
  async exportPublicKey(key) {
    const raw = await subtle.exportKey("raw", key);
    return Buffer.from(raw).toString("hex");
  },
  async importPublicKey(hex) {
    const raw = Buffer.from(hex, "hex");
    return subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  },
  async deriveSharedBits(privateKey, publicKey) {
    return subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  },
};

async function setupRatchet(myId, peerId, myPrivateKey, peerPubHex) {
  const peerPub = await E2EE.importPublicKey(peerPubHex);
  const sharedBits = await E2EE.deriveSharedBits(myPrivateKey, peerPub);
  await KoalaMix.initRatchet(myId, peerId, sharedBits);
}

const idA = "1000000000000001";
const idB = "2000000000000002";

const kpA = await E2EE.generateKeyPair();
const kpB = await E2EE.generateKeyPair();
const pubA = await E2EE.exportPublicKey(kpA.publicKey);
const pubB = await E2EE.exportPublicKey(kpB.publicKey);

await setupRatchet(idA, idB, kpA.privateKey, pubB);
await setupRatchet(idB, idA, kpB.privateKey, pubA);

for (let i = 0; i < 20; i++) {
  const packet = await KoalaMix.seal(idB, `hello ${i} with } brace`);
  const roundTrip = JSON.parse(JSON.stringify(packet));
  const text = await KoalaMix.open(idA, roundTrip);
  if (text !== `hello ${i} with } brace`) throw new Error(`A recv fail ${i}: ${text}`);
}

for (let i = 0; i < 20; i++) {
  const packet = await KoalaMix.seal(idA, `reply ${i}`);
  const text = await KoalaMix.open(idB, JSON.parse(JSON.stringify(packet)));
  if (text !== `reply ${i}`) throw new Error(`B recv fail ${i}: ${text}`);
}

console.log("koalamix round-trip ok");