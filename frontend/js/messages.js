const Messages = {
  conversations: {},
  defaultTTL: 3600,

  load() {
    const stored = localStorage.getItem("koala_messages");
    if (stored) {
      Messages.conversations = JSON.parse(stored);
      Messages._purgeExpired();
    }
    const ttl = localStorage.getItem("koala_ttl");
    if (ttl) Messages.defaultTTL = parseInt(ttl, 10);
  },

  save() {
    localStorage.setItem("koala_messages", JSON.stringify(Messages.conversations));
    localStorage.setItem("koala_ttl", Messages.defaultTTL.toString());
  },

  setTTL(seconds) {
    Messages.defaultTTL = seconds;
    Messages.save();
  },

  add(peerId, msg, direction, expiresAt, status) {
    if (!Messages.conversations[peerId]) Messages.conversations[peerId] = [];
    const entry = typeof msg === "string"
      ? { kind: "text", text: msg, direction, timestamp: Date.now(), expiresAt, status }
      : { ...msg, direction, timestamp: Date.now(), expiresAt, status: status || (direction === "sent" ? "sending" : undefined) };
    Messages.conversations[peerId].push(entry);
    Messages.save();
  },

  preview(msg) {
    if (!msg) return "";
    if (typeof msg === "string") return msg;
    if (!msg.kind) return msg.text || "";
    if (msg.kind === "image") return msg.text ? msg.text : "Photo";
    if (msg.kind === "audio") return "Voice message";
    if (msg.kind === "file") return msg.name || "File";
    return msg.text || "";
  },

  get(peerId) {
    Messages._purgeExpired();
    return Messages.conversations[peerId] || [];
  },

  clear(peerId) {
    if (Messages.conversations[peerId]) {
      delete Messages.conversations[peerId];
      Messages.save();
    }
  },

  _purgeExpired() {
    const now = Date.now();
    for (const peerId of Object.keys(Messages.conversations)) {
      Messages.conversations[peerId] = Messages.conversations[peerId].filter(
        (m) => !m.expiresAt || m.expiresAt > now
      );
      if (Messages.conversations[peerId].length === 0) {
        delete Messages.conversations[peerId];
      }
    }
    Messages.save();
  },

  wipe() {
    Messages.conversations = {};
    localStorage.removeItem("koala_messages");
    localStorage.removeItem("koala_ttl");
  },

  // Remove all history involving a specific peer (1:1 convo + any messages they authored in groups)
  purgeFrom(peerId) {
    if (!peerId) return;
    // Direct 1:1 conversation
    delete Messages.conversations[peerId];

    // Scrub from all group conversations (messages are stored with senderId)
    for (const key of Object.keys(Messages.conversations)) {
      if (typeof key === "string" && key.startsWith("group:")) {
        Messages.conversations[key] = (Messages.conversations[key] || []).filter((m) => {
          return m && m.senderId !== peerId;
        });
        if (Messages.conversations[key].length === 0) {
          delete Messages.conversations[key];
        }
      }
    }
    Messages.save();
  },

  // Remove only messages from a specific sender inside one chat (used for group scrubbing)
  purgeSenderFromChat(chatKey, senderId) {
    if (!chatKey || !senderId || !Messages.conversations[chatKey]) return;
    Messages.conversations[chatKey] = Messages.conversations[chatKey].filter((m) => {
      return m && m.senderId !== senderId;
    });
    if (Messages.conversations[chatKey].length === 0) {
      delete Messages.conversations[chatKey];
    }
    Messages.save();
  },
};