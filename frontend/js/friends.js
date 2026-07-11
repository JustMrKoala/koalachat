const Friends = {
  list: [],
  incomingRequests: [],
  sentRequests: [],
  peerKeys: {},
  peerCodes: {},
  nicknames: {},

  async loadFromStorage() {
    const stored = localStorage.getItem("koala_friends");
    if (stored) Friends.list = JSON.parse(stored);
    const keys = localStorage.getItem("koala_peer_keys");
    if (keys) Friends.peerKeys = JSON.parse(keys);
    const codes = localStorage.getItem("koala_peer_codes");
    if (codes) Friends.peerCodes = JSON.parse(codes);
    const incoming = localStorage.getItem("koala_incoming_requests");
    if (incoming) Friends.incomingRequests = JSON.parse(incoming);
    const sent = localStorage.getItem("koala_sent_requests");
    if (sent) Friends.sentRequests = JSON.parse(sent);
    const nicknames = localStorage.getItem("koala_nicknames");
    if (nicknames) Friends.nicknames = JSON.parse(nicknames);
  },

  save() {
    localStorage.setItem("koala_friends", JSON.stringify(Friends.list));
    localStorage.setItem("koala_peer_keys", JSON.stringify(Friends.peerKeys));
    localStorage.setItem("koala_peer_codes", JSON.stringify(Friends.peerCodes));
    localStorage.setItem("koala_nicknames", JSON.stringify(Friends.nicknames));
    localStorage.setItem("koala_incoming_requests", JSON.stringify(Friends.incomingRequests));
    localStorage.setItem("koala_sent_requests", JSON.stringify(Friends.sentRequests));
  },

  addRequest(data) {
    if (Friends.list.includes(data.from_id)) return false;
    const exists = Friends.incomingRequests.some((r) => r.from_id === data.from_id);
    if (exists) return false;
    Friends.incomingRequests.push({
      from_id: data.from_id,
      from_friend_code: data.from_friend_code || "",
      fingerprint: data.fingerprint || "",
      public_key: data.public_key || "",
      received_at: Date.now(),
    });
    Friends.save();
    return true;
  },

  removeRequest(fromId) {
    Friends.incomingRequests = Friends.incomingRequests.filter((r) => r.from_id !== fromId);
    Friends.save();
  },

  addSentRequest(friendCode) {
    if (!friendCode || Friends.sentRequests.includes(friendCode)) return;
    Friends.sentRequests.push(friendCode);
    Friends.save();
  },

  removeSentRequest(friendCode) {
    Friends.sentRequests = Friends.sentRequests.filter((c) => c !== friendCode);
    Friends.save();
  },

  getRequestCount() {
    return Friends.incomingRequests.length;
  },

  add(friendId, publicKeyHex, friendCode) {
    if (!Friends.list.includes(friendId)) {
      Friends.list.push(friendId);
      if (publicKeyHex) Friends.peerKeys[friendId] = publicKeyHex;
      if (friendCode) Friends.peerCodes[friendId] = friendCode;
      Friends.removeRequest(friendId);
      Friends.save();
      return;
    }
    let changed = false;
    if (publicKeyHex && Friends.peerKeys[friendId] !== publicKeyHex) {
      Friends.peerKeys[friendId] = publicKeyHex;
      KoalaMix.wipePeer(friendId);
      changed = true;
    }
    if (friendCode && Friends.peerCodes[friendId] !== friendCode) {
      Friends.peerCodes[friendId] = friendCode;
      changed = true;
    }
    if (changed) Friends.save();
  },

  displayName(friendId) {
    const nickname = Friends.nicknames[friendId];
    if (nickname) return nickname;
    return `Contact ${friendId.slice(-4)}`;
  },

  setNickname(friendId, name) {
    const trimmed = (name || "").trim();
    if (trimmed) {
      Friends.nicknames[friendId] = trimmed.slice(0, 32);
    } else {
      delete Friends.nicknames[friendId];
    }
    Friends.save();
  },

  remove(friendId) {
    Friends.list = Friends.list.filter((f) => f !== friendId);
    delete Friends.peerKeys[friendId];
    delete Friends.peerCodes[friendId];
    delete Friends.nicknames[friendId];
    KoalaMix.wipePeer(friendId);
    Friends.save();
  },

  generateQRData(friendCode, fingerprint, publicKeyHex) {
    return JSON.stringify({
      v: 2,
      fc: friendCode,
      fp: fingerprint,
      pk: publicKeyHex,
    });
  },

  parseQRData(data) {
    try {
      const parsed = JSON.parse(data);
      if (parsed.v === 2 && parsed.fc && parsed.fp && parsed.pk) return parsed;
      if (parsed.v === 1 && parsed.id && parsed.fp && parsed.pk) {
        return { legacy: true, id: parsed.id, fp: parsed.fp, pk: parsed.pk };
      }
    } catch (_) {}
    return null;
  },

  async setupRatchet(myId, peerId, myPrivateKey) {
    const peerPubHex = Friends.peerKeys[peerId];
    if (!peerPubHex) return;
    const peerPub = await E2EE.importPublicKey(peerPubHex);
    const sharedBits = await E2EE.deriveSharedBits(myPrivateKey, peerPub);
    await KoalaMix.initRatchet(myId, peerId, sharedBits);
  },

  wipe() {
    Friends.list = [];
    Friends.incomingRequests = [];
    Friends.sentRequests = [];
    Friends.peerKeys = {};
    Friends.peerCodes = {};
    Friends.nicknames = {};
    localStorage.removeItem("koala_friends");
    localStorage.removeItem("koala_peer_keys");
    localStorage.removeItem("koala_peer_codes");
    localStorage.removeItem("koala_nicknames");
    localStorage.removeItem("koala_incoming_requests");
    localStorage.removeItem("koala_sent_requests");
    KoalaMix.wipeAll();
  },
};