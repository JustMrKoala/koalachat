const Groups = {
  list: [],
  meta: {},

  async load() {
    const stored = localStorage.getItem("koala_groups");
    if (stored) Groups.list = JSON.parse(stored);
    const meta = localStorage.getItem("koala_group_meta");
    if (meta) Groups.meta = JSON.parse(meta);
    const keys = localStorage.getItem("koala_group_keys");
    if (keys) {
      const parsed = JSON.parse(keys);
      for (const [gid, b64] of Object.entries(parsed)) {
        const key = await GroupCrypto.importKey(b64);
        GroupCrypto.setGroupKey(gid, key);
      }
    }
  },

  save() {
    localStorage.setItem("koala_groups", JSON.stringify(Groups.list));
    localStorage.setItem("koala_group_meta", JSON.stringify(Groups.meta));
  },

  async saveKeys() {
    const exported = {};
    for (const gid of Groups.list) {
      const key = GroupCrypto.keys[gid];
      if (key) exported[gid] = await GroupCrypto.exportKey(key);
    }
    localStorage.setItem("koala_group_keys", JSON.stringify(exported));
  },

  chatKey(groupId) {
    return `group:${groupId}`;
  },

  isGroupChat(chatId) {
    return typeof chatId === "string" && chatId.startsWith("group:");
  },

  groupIdFromChat(chatId) {
    return chatId.startsWith("group:") ? chatId.slice(6) : null;
  },

  displayName(groupId) {
    const meta = Groups.meta[groupId];
    return meta && meta.name ? meta.name : `Group ${groupId.slice(0, 6)}`;
  },

  memberCount(groupId) {
    const meta = Groups.meta[groupId];
    return meta && meta.members ? meta.members.length : 0;
  },

  add(groupId, name, members, key) {
    if (!Groups.list.includes(groupId)) Groups.list.push(groupId);
    Groups.meta[groupId] = { name, members: [...members], createdAt: Date.now() };
    if (key) GroupCrypto.setGroupKey(groupId, key);
    Groups.save();
    if (key) Groups.saveKeys();
  },

  updateMembers(groupId, members) {
    if (!Groups.meta[groupId]) return;
    Groups.meta[groupId].members = [...members];
    Groups.save();
  },

  remove(groupId) {
    Groups.list = Groups.list.filter((g) => g !== groupId);
    delete Groups.meta[groupId];
    GroupCrypto.wipeGroup(groupId);
    Groups.save();
    Groups.saveKeys();
  },

  async handleGroupKey(payload) {
    const key = await GroupCrypto.importKey(payload.key);
    Groups.add(payload.group_id, payload.name, payload.members, key);
  },

  async distributeKey(groupId, memberIds, key, name, members) {
    const b64 = await GroupCrypto.exportKey(key);
    for (const mid of memberIds) {
      if (mid === App.accountId) continue;
      if (!Friends.list.includes(mid)) continue;
      if (!KoalaMix.ratchets[mid]) {
        await Friends.setupRatchet(App.accountId, mid, App.privateKey);
      }
      const envelopes = await KoalaMix.seal(mid, {
        kind: "group_key",
        group_id: groupId,
        key: b64,
        name,
        members,
      });
      for (const envelope of envelopes) {
        WSClient.send({
          type: "message",
          recipient_id: mid,
          envelope,
          ttl: 86400,
        });
      }
    }
  },

  wipe() {
    Groups.list = [];
    Groups.meta = {};
    GroupCrypto.wipeAll();
    localStorage.removeItem("koala_groups");
    localStorage.removeItem("koala_group_meta");
    localStorage.removeItem("koala_group_keys");
  },
};