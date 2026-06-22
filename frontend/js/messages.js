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

  add(peerId, text, direction, expiresAt) {
    if (!Messages.conversations[peerId]) Messages.conversations[peerId] = [];
    Messages.conversations[peerId].push({
      text,
      direction,
      timestamp: Date.now(),
      expiresAt,
    });
    Messages.save();
  },

  get(peerId) {
    Messages._purgeExpired();
    return Messages.conversations[peerId] || [];
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
};