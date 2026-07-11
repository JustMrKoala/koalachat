const AVATAR_COLORS = ["#00a884", "#53bdeb", "#e542a3", "#7f66ff", "#ff6b6b", "#ffa94d", "#20c997", "#845ef7"];

const App = {
  VERSION: "1.6.2",
  _removeTarget: null,
  _removeMode: "contact",
  _recording: false,
  _recordStream: null,
  _mediaRecorder: null,
  _recordChunks: [],
  _recordStartedAt: 0,
  accountId: null,
  friendCode: null,
  keyPair: null,
  publicKeyHex: null,
  fingerprint: null,
  activeChat: null,
  privateKey: null,
  searchQuery: "",
  username: null,
  wsBound: false,
  peerOnline: {},
  peerTyping: {},
  purgedPeers: new Set(),
  _typingActive: false,
  _typingStopTimer: null,
  _peerTypingTimers: {},

  async init() {
    Messages.load();
    await Groups.load();
    await Friends.loadFromStorage();
    AntiTamper.init();

    App._setVersionLabels();

    const stored = localStorage.getItem("koala_account");
    if (stored) {
      const data = JSON.parse(stored);
      if (!(await App._accountExistsOnServer(data.accountId))) {
        App._handleStaleAccount();
      } else {
        App.accountId = data.accountId;
        App.friendCode = data.friendCode || null;
        App.publicKeyHex = data.publicKeyHex;
        App.fingerprint = data.fingerprint;
        App.username = data.username || null;
        await App._restoreKeys(data.privateKeyJwk);
        await App._ensureFriendCode();
        await App._loadUsername();
        await App._persistAccount();
        App._bindEvents();
        App._bindWS();
        WSClient.connect(App.accountId);
        App.showMain();
      }
    } else {
      App.showWelcome();
    }

    App._registerSW();
    App._startTTLCleanup();
    window.addEventListener("resize", () => App._syncLayout());
    window.addEventListener("online", () => {
      if (App.accountId && !WSClient.isReady()) WSClient.connect(App.accountId);
    });
  },

  isDesktop() {
    return window.matchMedia("(min-width: 900px)").matches;
  },

  _syncLayout() {
    const placeholder = document.getElementById("chat-placeholder");
    const chatView = document.getElementById("chat-view");
    const chatsView = document.getElementById("chats-view");
    const listHeader = document.getElementById("list-header");
    if (!placeholder || document.getElementById("main-view").classList.contains("hidden")) return;
    if (App.isDesktop()) {
      chatsView.classList.remove("hidden");
      listHeader.classList.remove("hidden");
      if (App.activeChat) {
        placeholder.classList.add("hidden");
        chatView.classList.remove("hidden");
      } else {
        placeholder.classList.remove("hidden");
        chatView.classList.add("hidden");
      }
    } else if (App.activeChat) {
      placeholder.classList.add("hidden");
      chatsView.classList.add("hidden");
      listHeader.classList.add("hidden");
      chatView.classList.remove("hidden");
    } else {
      placeholder.classList.add("hidden");
      chatsView.classList.remove("hidden");
      listHeader.classList.remove("hidden");
      chatView.classList.add("hidden");
    }
  },

  async _restoreKeys(jwk) {
    App.privateKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );
    App.publicKeyHex = await E2EE.exportPublicKey(
      await crypto.subtle.importKey(
        "jwk",
        { ...jwk, d: undefined },
        { name: "ECDH", namedCurve: "P-256" },
        true,
        []
      )
    );
    App.keyPair = { privateKey: App.privateKey };
  },

  showWelcome() {
    document.getElementById("welcome-view").classList.remove("hidden");
    document.getElementById("main-view").classList.add("hidden");
    document.getElementById("btn-create-account").onclick = () => App.createAccount();
    const usernameBtn = document.getElementById("btn-show-username");
    if (usernameBtn) usernameBtn.onclick = () => App.showUsernamePanel();
    App._setVersionLabels();
    AntiTamper.onViewChange();
  },

  avatarColor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  },

  avatarInitial(id) {
    return id.slice(-2);
  },

  setAvatar(el, id) {
    el.textContent = App.avatarInitial(id);
    el.style.background = App.avatarColor(id);
  },

  async _accountExistsOnServer(accountId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`/api/account/${accountId}/exists`, { cache: "no-store" });
        if (!res.ok) return false;
        const data = await res.json();
        return !!data.exists;
      } catch (_) {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
    }
    return false;
  },

  _handleStaleAccount() {
    Friends.wipe();
    Groups.wipe();
    Messages.wipe();
    localStorage.removeItem("koala_account");
    WSClient.disconnect();
    App.accountId = null;
    App.friendCode = null;
    App.keyPair = null;
    App.publicKeyHex = null;
    App.fingerprint = null;
    App.privateKey = null;
    App.username = null;
    App.activeChat = null;
    App.wsBound = false;
    App.showWelcome();
    App._toast("Server was reset create a new account");
  },

  async _ensureFriendCode() {
    if (App.friendCode || !App.accountId) return;
    try {
      const res = await fetch(`/api/account/${App.accountId}/friendcode`);
      if (!res.ok) return;
      const data = await res.json();
      App.friendCode = data.friend_code;
      await App._persistAccount();
    } catch (_) {}
  },

  async createAccount() {
    const btn = document.getElementById("btn-create-account");
    btn.disabled = true;
    btn.textContent = "Generating keys...";

    const keyPair = await E2EE.generateKeyPair();
    App.privateKey = keyPair.privateKey;
    const publicKey = keyPair.publicKey;
    App.publicKeyHex = await E2EE.exportPublicKey(publicKey);
    App.fingerprint = await E2EE.fingerprint(App.publicKeyHex);

    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key_fingerprint: App.fingerprint }),
    });

    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = "Create Account";
      const err = await res.json().catch(() => ({}));
      App._toast(err.detail || "Registration failed. Try again.");
      return;
    }

    const data = await res.json();
    App.accountId = data.account_id;
    App.friendCode = data.friend_code;
    App.username = null;

    const privateJwk = await crypto.subtle.exportKey("jwk", App.privateKey);
    const toStore = {
      accountId: App.accountId,
      friendCode: App.friendCode,
      publicKeyHex: App.publicKeyHex,
      fingerprint: App.fingerprint,
      privateKeyJwk: privateJwk,
      username: null,
    };
    localStorage.setItem("koala_account", JSON.stringify(toStore));
    // also update in-memory username etc
    await App._persistAccount();

    App._bindEvents();
    App._bindWS();
    WSClient.connect(App.accountId);
    App.showMain();
  },

  async derivePasswordHash(username, password) {
    const enc = new TextEncoder();
    const normalized = (username || "").trim().toLowerCase();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: enc.encode("koala:" + normalized),
        iterations: 150000,
        hash: "SHA-256",
      },
      keyMaterial,
      256
    );
    return Array.from(new Uint8Array(bits))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  },

  async _persistAccount() {
    if (!App.accountId) return;
    const payload = {
      accountId: App.accountId,
      friendCode: App.friendCode || null,
      publicKeyHex: App.publicKeyHex || null,
      fingerprint: App.fingerprint || null,
      username: App.username || null,
    };
    // Preserve or export private key
    try {
      const existingRaw = localStorage.getItem("koala_account");
      if (existingRaw) {
        const prev = JSON.parse(existingRaw);
        if (prev.accountId === App.accountId && prev.privateKeyJwk) {
          payload.privateKeyJwk = prev.privateKeyJwk;
        }
      }
    } catch (_) {}
    if (!payload.privateKeyJwk && App.privateKey) {
      try {
        payload.privateKeyJwk = await crypto.subtle.exportKey("jwk", App.privateKey);
      } catch (_) {}
    }
    localStorage.setItem("koala_account", JSON.stringify(payload));
  },

  async _loadUsername() {
    if (!App.accountId) return;
    try {
      const res = await fetch(`/api/account/${App.accountId}/username`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.username) {
          App.username = data.username;
          await App._persistAccount();
        }
      }
    } catch (_) {}
  },

  showMain() {
    document.getElementById("welcome-view").classList.add("hidden");
    document.getElementById("main-view").classList.remove("hidden");

    document.getElementById("ttl-select").value = Messages.defaultTTL.toString();
    try {
      App.renderFriends();
      App.renderRequests();
      App.renderSentStatus();
    } catch (_) {}
    App._syncLayout();
    App._setVersionLabels();
    AntiTamper.onViewChange();
  },

  renderQR() {
    const container = document.getElementById("qr-code");
    if (!container || !App.friendCode) return;
    container.innerHTML = "";
    const qrData = Friends.generateQRData(App.friendCode, App.fingerprint, App.publicKeyHex);
    if (typeof QRCode === "undefined") {
      App._toast("QR library failed to load");
      return;
    }
    new QRCode(container, {
      text: qrData,
      width: 180,
      height: 180,
      colorDark: "#111b21",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H,
    });
  },

  renderFriends() {
    const list = document.getElementById("friends-list");
    const empty = document.getElementById("empty-chats");
    list.innerHTML = "";
    const chats = [];
    Groups.list.forEach((gid) => {
      chats.push({ type: "group", id: Groups.chatKey(gid), label: Groups.displayName(gid) });
    });
    Friends.list.forEach((fid) => {
      chats.push({ type: "dm", id: fid, label: Friends.displayName(fid) });
    });
    const filtered = chats.filter((chat) => {
      if (!App.searchQuery) return true;
      const q = App.searchQuery.toLowerCase();
      return chat.label.toLowerCase().includes(q) || chat.id.toLowerCase().includes(q);
    });
    if (filtered.length === 0) {
      empty.classList.remove("hidden");
      list.classList.add("hidden");
      if (chats.length > 0 && App.searchQuery) {
        empty.querySelector("p").textContent = "No results";
        empty.querySelector("span").textContent = "Try a different search term";
      } else {
        empty.querySelector("p").textContent = "No chats yet";
        empty.querySelector("span").textContent = "Scan a QR code or add a friend to start messaging";
      }
      return;
    }
    empty.classList.add("hidden");
    list.classList.remove("hidden");
    filtered.forEach((chat) => {
      const msgs = Messages.get(chat.id);
      const last = msgs[msgs.length - 1];
      const li = document.createElement("li");
      li.className = `chat-item${chat.id === App.activeChat ? " active" : ""}${chat.type === "group" ? " chat-item-group" : ""}`;
      const displayName = chat.label;
      const color = App.avatarColor(chat.id);
      const isTyping = chat.type === "dm" && Boolean(App.peerTyping[chat.id]);
      let preview = isTyping ? "typing..." : (last ? Messages.preview(last) : "Tap to start chatting");
      if (chat.type === "group" && last && last.senderId && last.direction === "received") {
        preview = `${Friends.displayName(last.senderId)}: ${preview}`;
      }
      const previewClass = isTyping ? "chat-item-preview typing" : "chat-item-preview";
      const presenceClass = chat.type === "dm" && App.peerOnline[chat.id] ? "online" : "offline";
      const time = last ? App._formatListTime(last.timestamp) : "";
      const groupBadge = chat.type === "group"
        ? `<span class="chat-item-group-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg></span>`
        : "";
      li.innerHTML = `
        <div class="avatar-wrap">
          <div class="avatar" style="background:${color}">${chat.type === "group" ? "G" : App.avatarInitial(displayName)}</div>
          ${chat.type === "dm" ? `<span class="presence-dot ${presenceClass}" aria-hidden="true"></span>` : ""}
        </div>
        <div class="chat-item-body">
          <div class="chat-item-top">
            <span class="chat-item-name">${App._escapeHtml(displayName)}${groupBadge}</span>
            ${time ? `<span class="chat-item-time">${time}</span>` : ""}
          </div>
          <div class="${previewClass}">${App._escapeHtml(preview)}</div>
        </div>
        <button type="button" class="chat-item-remove" aria-label="Remove ${App._escapeHtml(displayName)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
        </button>
      `;
      li.querySelector(".chat-item-remove").onclick = (e) => {
        e.stopPropagation();
        if (chat.type === "group") App.confirmLeaveGroup(Groups.groupIdFromChat(chat.id));
        else App.confirmRemoveContact(chat.id);
      };
      li.onclick = () => App.openChat(chat.id);
      list.appendChild(li);
    });
  },

  _escapeHtml(text) {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
  },

  _formatListTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  },

  _formatMsgTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  },

  async openChat(chatId) {
    App.activeChat = chatId;
    if (Groups.isGroupChat(chatId)) {
      App._updateGroupHeader(Groups.groupIdFromChat(chatId));
    } else {
      App._updateChatHeader(chatId);
      await Friends.setupRatchet(App.accountId, chatId, App.privateKey);
    }
    document.getElementById("app-shell").classList.add("chat-open");
    App._syncLayout();
    App.renderFriends();
    App.renderMessages(chatId);
    const input = document.getElementById("message-input");
    App._resetInput();
    if (input) {
      input.focus();
      App._autoResizeInput();
    }
  },

  _peerStatusLabel(peerId) {
    if (App.peerTyping[peerId]) return "typing...";
    return App.peerOnline[peerId] ? "online" : "offline";
  },

  _updateChatHeader(peerId) {
    const displayName = Friends.displayName(peerId);
    document.getElementById("chat-peer-id").textContent = displayName;
    const codeEl = document.getElementById("chat-peer-code");
    if (codeEl) {
      const status = App._peerStatusLabel(peerId);
      codeEl.className = "chat-subtitle";
      if (App.peerTyping[peerId]) codeEl.classList.add("typing");
      else if (App.peerOnline[peerId]) codeEl.classList.add("online");
      else codeEl.classList.add("offline");
      codeEl.textContent = status;
    }
    const presenceDot = document.getElementById("chat-presence-dot");
    if (presenceDot) {
      presenceDot.className = `presence-dot ${App.peerOnline[peerId] ? "online" : "offline"}`;
      presenceDot.classList.remove("hidden");
    }
    const avatar = document.getElementById("chat-avatar");
    avatar.textContent = App.avatarInitial(displayName);
    avatar.style.background = App.avatarColor(displayName);
    App._setGroupHeaderActions(false);
  },

  _updateGroupHeader(groupId) {
    const displayName = Groups.displayName(groupId);
    const count = Groups.memberCount(groupId);
    document.getElementById("chat-peer-id").textContent = displayName;
    const codeEl = document.getElementById("chat-peer-code");
    if (codeEl) {
      codeEl.className = "chat-subtitle";
      codeEl.textContent = count === 1 ? "1 member" : `${count} members`;
    }
    const presenceDot = document.getElementById("chat-presence-dot");
    if (presenceDot) presenceDot.classList.add("hidden");
    const avatar = document.getElementById("chat-avatar");
    avatar.textContent = "G";
    avatar.style.background = App.avatarColor(Groups.chatKey(groupId));
    App._setGroupHeaderActions(true);
  },

  _setGroupHeaderActions(isGroup) {
    const renameBtn = document.getElementById("btn-rename-peer");
    const removeBtn = document.getElementById("btn-remove-chat");
    if (renameBtn) renameBtn.classList.toggle("hidden", isGroup);
    if (removeBtn) removeBtn.classList.toggle("hidden", isGroup);
  },

  _refreshPresenceUI() {
    if (App.activeChat) {
      if (Groups.isGroupChat(App.activeChat)) {
        App._updateGroupHeader(Groups.groupIdFromChat(App.activeChat));
      } else {
        App._updateChatHeader(App.activeChat);
      }
    }
    App.renderFriends();
  },

  _notifyTyping() {
    if (!App.activeChat || !WSClient.isReady() || Groups.isGroupChat(App.activeChat)) return;
    if (!App._typingActive) {
      App._typingActive = true;
      WSClient.send({ type: "typing", recipient_id: App.activeChat, active: true });
    }
    clearTimeout(App._typingStopTimer);
    App._typingStopTimer = setTimeout(() => App._stopTyping(), 3000);
  },

  _stopTyping() {
    clearTimeout(App._typingStopTimer);
    App._typingStopTimer = null;
    if (!App._typingActive) return;
    App._typingActive = false;
    if (App.activeChat && WSClient.isReady()) {
      WSClient.send({ type: "typing", recipient_id: App.activeChat, active: false });
    }
  },

  _autoResizeInput() {
    const input = document.getElementById("message-input");
    if (!input) return;
    input.style.height = "auto";
    const maxH = 120;
    const newH = Math.min(input.scrollHeight, maxH);
    input.style.height = newH + "px";
    // allow scrolling if exceeds max
    input.style.overflowY = input.scrollHeight > maxH ? "auto" : "hidden";
  },

  _resetInput() {
    const input = document.getElementById("message-input");
    if (!input) return;
    input.value = "";
    input.style.height = "auto";
    input.style.overflowY = "hidden";
  },

  closeChat() {
    App._stopTyping();
    App.activeChat = null;
    App._resetInput();
    document.getElementById("app-shell").classList.remove("chat-open");
    App._syncLayout();
    App.renderFriends();
  },

  // Production polish: close any open sheet or modal
  closeAllSheets() {
    document.querySelectorAll(".sheet:not(.hidden)").forEach((s) => s.classList.add("hidden"));
    document.querySelectorAll(".modal-overlay:not(.hidden)").forEach((m) => m.classList.add("hidden"));
  },

  _buildMessageBody(m) {
    const frag = document.createDocumentFragment();
    if (m.kind === "image" && m.data) {
      const img = document.createElement("img");
      img.className = "message-image";
      img.alt = m.text || "Shared image";
      img.draggable = false;
      img.src = `data:${m.mime || "image/jpeg"};base64,${m.data}`;
      frag.appendChild(img);
      if (m.text) {
        const cap = document.createElement("span");
        cap.className = "message-text";
        cap.textContent = m.text;
        frag.appendChild(cap);
      }
      return frag;
    }
    if (m.kind === "audio" && m.data) {
      const audio = document.createElement("audio");
      audio.className = "message-audio";
      audio.controls = true;
      audio.preload = "none";
      audio.src = `data:${m.mime || "audio/webm"};base64,${m.data}`;
      frag.appendChild(audio);
      return frag;
    }
    if (m.kind === "file" && m.data) {
      const link = document.createElement("a");
      link.className = "message-file";
      link.href = `data:${m.mime || "application/octet-stream"};base64,${m.data}`;
      link.download = m.name || "file";
      link.textContent = m.name || "Download file";
      frag.appendChild(link);
      return frag;
    }
    const text = document.createElement("span");
    text.className = "message-text";
    text.textContent = m.text || "";
    frag.appendChild(text);
    return frag;
  },

  _payloadToMessage(payload) {
    if (payload.kind === "image") {
      return { kind: "image", data: payload.data, mime: payload.mime || "image/jpeg", text: payload.text || "" };
    }
    if (payload.kind === "audio") {
      return { kind: "audio", data: payload.data, mime: payload.mime || "audio/webm", text: "" };
    }
    if (payload.kind === "file") {
      return { kind: "file", data: payload.data, mime: payload.mime || "application/octet-stream", name: payload.name || "file" };
    }
    return { kind: "text", text: payload.text || "" };
  },

  _normalizeMessage(m) {
    if (!m.kind) return { ...m, kind: "text", text: m.text || "" };
    return m;
  },

  renderMessages(chatId) {
    const container = document.getElementById("chat-messages");
    container.innerHTML = "";
    const msgs = Messages.get(chatId);
    const isGroup = Groups.isGroupChat(chatId);
    msgs.forEach((raw) => {
      const m = App._normalizeMessage(raw);
      const row = document.createElement("div");
      row.className = `message-row ${m.direction}`;
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      if (isGroup && m.direction === "received" && m.senderId) {
        const sender = document.createElement("span");
        sender.className = "message-sender";
        sender.textContent = Friends.displayName(m.senderId);
        bubble.appendChild(sender);
      }
      bubble.appendChild(App._buildMessageBody(m));
      const meta = document.createElement("span");
      meta.className = "message-meta";
      const time = document.createElement("span");
      time.className = "msg-time";
      time.textContent = App._formatMsgTime(m.timestamp);
      meta.appendChild(time);
      if (m.expiresAt) {
        const remaining = Math.max(0, Math.floor((m.expiresAt - Date.now()) / 1000));
        const timer = document.createElement("span");
        timer.className = "msg-timer";
        timer.textContent = App._formatTTL(remaining);
        meta.appendChild(timer);
      }
      // Delivery status for sent messages (production polish)
      if (m.direction === "sent" && m.status) {
        const st = document.createElement("span");
        st.className = "message-status";
        if (m.status === "sent" || m.status === "delivered") {
          st.innerHTML = `<span class="delivered" title="Delivered"></span>`;
        } else if (m.status === "sending") {
          st.textContent = "⋯";
        }
        meta.appendChild(st);
      }
      bubble.appendChild(meta);
      row.appendChild(bubble);

      // QOL: click/tap bubble to copy text (native friendly)
      if (m.kind === "text" && m.text) {
        bubble.style.cursor = "pointer";
        bubble.title = "Click to copy";
        bubble.addEventListener("click", (ev) => {
          // avoid triggering when clicking action areas or links
          if (ev.target.closest("a")) return;
          App._copyToClipboard(m.text);
        });
      }

      container.appendChild(row);
    });
    // Native-like: scroll to latest (smooth when possible)
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  },

  async _copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      App._toast("Copied");
    } catch (_) {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); App._toast("Copied"); } catch {}
      document.body.removeChild(ta);
    }
  },

  _formatTTL(seconds) {
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
    return `${seconds}s`;
  },

  async _sendPayload(payload) {
    if (!App.activeChat) return;
    try {
      const ttl = Messages.defaultTTL;
      const expiresAt = (ttl > 0) ? (Date.now() + ttl * 1000) : null;
      const msg = App._payloadToMessage(payload);
      if (Groups.isGroupChat(App.activeChat)) {
        const groupId = Groups.groupIdFromChat(App.activeChat);
        if (!GroupCrypto.hasKey(groupId)) {
          App._toast("Group encryption not ready wait a moment");
          return;
        }
        const envelope = await GroupCrypto.seal(groupId, payload);
        WSClient.send({
          type: "group_message",
          group_id: groupId,
          envelope,
          ttl: ttl,
        });
      } else {
        if (!KoalaMix.ratchets[App.activeChat]) {
          await Friends.setupRatchet(App.accountId, App.activeChat, App.privateKey);
        }
        const envelopes = await KoalaMix.seal(App.activeChat, payload);
        for (const envelope of envelopes) {
          WSClient.send({
            type: "message",
            recipient_id: App.activeChat,
            envelope,
            ttl: ttl,
          });
        }
      }
      Messages.add(App.activeChat, msg, "sent", expiresAt, "sending");
      App._stopTyping();
      App.renderMessages(App.activeChat);
      App.renderFriends();
    } catch (_) {
      App._toast("Could not send message try reopening the chat");
    }
  },

  async sendMessage() {
    const input = document.getElementById("message-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text || !App.activeChat) return;
    App._resetInput();
    await App._sendPayload({ kind: "text", text });
    // re-focus for quick follow-ups (native chat feel)
    setTimeout(() => {
      const el = document.getElementById("message-input");
      if (el) el.focus();
    }, 0);
  },

  async _onImageSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || !App.activeChat) return;
    try {
      const blob = await Media.compressImage(file);
      const data = await Media.blobToBase64(blob);
      const inputEl = document.getElementById("message-input");
      const caption = inputEl ? inputEl.value.trim() : "";
      App._resetInput();
      await App._sendPayload({
        kind: "image",
        data,
        mime: blob.type || "image/jpeg",
        text: caption,
      });
    } catch (_) {
      App._toast("Could not send image try a smaller photo");
    }
  },

  async _onFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || !App.activeChat) return;
    try {
      await Media.prepareFile(file);
      const data = await Media.blobToBase64(file);
      await App._sendPayload({
        kind: "file",
        data,
        mime: file.type || "application/octet-stream",
        name: file.name || "file",
      });
    } catch (_) {
      App._toast("Could not send file max 500 KB");
    }
  },

  async _toggleVoiceRecord() {
    if (!App.activeChat) {
      App._toast("Open a chat to record voice");
      return;
    }
    if (!App._recording) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        App._toast("Voice recording not supported");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        App._recordStream = stream;
        App._recordChunks = [];
        App._mediaRecorder = Media.createRecorder(stream);
        App._mediaRecorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) App._recordChunks.push(ev.data);
        };
        App._mediaRecorder.onstop = () => App._finishVoiceRecord();
        App._mediaRecorder.start();
        App._recordStartedAt = Date.now();
        App._recording = true;
        clearTimeout(App._recordLimitTimer);
        App._recordLimitTimer = setTimeout(() => {
          if (App._recording && App._mediaRecorder) App._mediaRecorder.stop();
        }, Media.MAX_AUDIO_MS);
        document.getElementById("btn-record-voice").classList.add("recording");
        const hint = document.getElementById("voice-recording-hint");
        if (hint) hint.classList.remove("hidden");
      } catch (_) {
        App._toast("Microphone access denied");
      }
      return;
    }
    if (Date.now() - App._recordStartedAt < 400) {
      App._toast("Hold longer to record");
      App._cancelVoiceRecord();
      return;
    }
    App._mediaRecorder.stop();
  },

  _cancelVoiceRecord() {
    clearTimeout(App._recordLimitTimer);
    App._recording = false;
    document.getElementById("btn-record-voice").classList.remove("recording");
    const hint = document.getElementById("voice-recording-hint");
    if (hint) hint.classList.add("hidden");
    if (App._mediaRecorder && App._mediaRecorder.state !== "inactive") {
      App._mediaRecorder.onstop = null;
      App._mediaRecorder.stop();
    }
    if (App._recordStream) {
      App._recordStream.getTracks().forEach((t) => t.stop());
      App._recordStream = null;
    }
    App._mediaRecorder = null;
    App._recordChunks = [];
  },

  _finishVoiceRecord() {
    clearTimeout(App._recordLimitTimer);
    App._recording = false;
    document.getElementById("btn-record-voice").classList.remove("recording");
    const hint = document.getElementById("voice-recording-hint");
    if (hint) hint.classList.add("hidden");
    if (App._recordStream) {
      App._recordStream.getTracks().forEach((t) => t.stop());
      App._recordStream = null;
    }
    const mime = App._mediaRecorder ? App._mediaRecorder.mimeType : "audio/webm";
    const blob = new Blob(App._recordChunks, { type: mime || "audio/webm" });
    App._mediaRecorder = null;
    App._recordChunks = [];
    if (blob.size < 100) {
      App._toast("Recording too short");
      return;
    }
    if (blob.size > Media.MAX_AUDIO_BYTES) {
      App._toast("Voice message too long");
      return;
    }
    Media.blobToBase64(blob).then((data) => {
      App._sendPayload({ kind: "audio", data, mime: blob.type || "audio/webm" });
    }).catch(() => App._toast("Could not send voice message"));
  },

  _bindEvents() {
    // Helper to safely attach onclick handlers (prevents one bad element from breaking later bindings like purge)
    const bind = (id, handler) => {
      const el = document.getElementById(id);
      if (el) el.onclick = handler;
    };
    const bindPrevent = (id, handler) => {
      const el = document.getElementById(id);
      if (el) el.onclick = (e) => { e.preventDefault(); handler(e); };
    };

    bind("btn-send", () => App.sendMessage());

    const msgInput = document.getElementById("message-input");
    if (msgInput) {
      msgInput.onkeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          App.sendMessage();
        }
      };
      msgInput.oninput = () => {
        App._autoResizeInput();
        App._notifyTyping();
      };
      msgInput.onblur = () => App._stopTyping();
    }

    bind("btn-back", () => App.closeChat());
    bindPrevent("btn-scan-qr", () => App.openScanner());
    bindPrevent("btn-show-qr", () => App.openQR());
    bindPrevent("btn-settings", () => App.openSettings());
    bindPrevent("btn-settings-header", () => App.openSettings());

    const purgeBtn = document.getElementById("btn-purge-settings");
    if (purgeBtn && !purgeBtn._koalaPurgeBound) {
      purgeBtn._koalaPurgeBound = true;
      purgeBtn.addEventListener("click", () => App.confirmPurge());
    }

    bind("btn-close-settings", () => App.closeSettings());
    bind("btn-close-qr", () => App.closeQR());
    bind("btn-close-scan", () => App.closeScanner());

    const ttl = document.getElementById("ttl-select");
    if (ttl) ttl.onchange = (e) => { Messages.setTTL(parseInt(e.target.value, 10)); };

    bindPrevent("btn-requests", () => App.openRequestsInbox());
    bindPrevent("btn-close-requests", () => App.closeRequestsInbox());
    bindPrevent("btn-add-friend", () => App.showAddFriend());
    bind("btn-confirm-add", () => App.addFriendManual());
    bind("btn-cancel-add", () => App.hideAddFriend());
    bind("btn-copy-friendcode", () => App.copyFriendCode());
    bind("btn-copy-qr-code", () => App.copyFriendCode());
    const qrUpload = document.getElementById("btn-qr-upload");
    if (qrUpload) qrUpload.onclick = () => { const fi = document.getElementById("qr-file-input"); if (fi) fi.click(); };
    bindPrevent("btn-flip-camera", () => App._flipScannerCamera());
    bindPrevent("btn-rename-peer", () => App.openNicknameEditor());
    bindPrevent("btn-clear-chat", () => App.clearActiveChat());
    const removeChat = document.getElementById("btn-remove-chat");
    if (removeChat) {
      removeChat.onclick = (e) => {
        e.preventDefault();
        if (Groups.isGroupChat(App.activeChat)) {
          App.confirmLeaveGroup(Groups.groupIdFromChat(App.activeChat));
        } else {
          App.confirmRemoveContact(App.activeChat);
        }
      };
    }
    bindPrevent("btn-chat-settings", () => App.openSettings());

    const headerInfo = document.querySelector(".chat-header-info");
    if (headerInfo) {
      headerInfo.style.cursor = "pointer";
      headerInfo.addEventListener("click", () => {
        const inp = document.getElementById("message-input");
        if (inp) inp.focus();
      });
    }

    bind("btn-cancel-remove", () => App.cancelRemoveContact());
    const confirmRemove = document.getElementById("btn-confirm-remove");
    if (confirmRemove) {
      confirmRemove.onclick = () => {
        if (App._removeMode === "group") App.leaveGroup(App._removeTarget);
        else App.removeContact(App._removeTarget);
      };
    }

    bind("btn-cancel-purge", () => App._cancelPurge());
    bind("btn-confirm-purge", () => App._doPurge());

    bind("btn-save-nickname", () => App.saveNickname());
    bind("btn-cancel-nickname", () => App.closeNicknameEditor());

    const nickInput = document.getElementById("nickname-input");
    if (nickInput) {
      nickInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          App.saveNickname();
        }
      };
    }

    const qrFile = document.getElementById("qr-file-input");
    if (qrFile) qrFile.onchange = (e) => App._onQRFileSelected(e);

    bindPrevent("btn-attach-image", () => {
      if (!App.activeChat) { App._toast("Open a chat to send files"); return; }
      const fi = document.getElementById("image-file-input"); if (fi) fi.click();
    });
    const imgFile = document.getElementById("image-file-input");
    if (imgFile) imgFile.onchange = (e) => App._onImageSelected(e);

    bindPrevent("btn-attach-file", () => {
      if (!App.activeChat) { App._toast("Open a chat to send files"); return; }
      const fi = document.getElementById("file-input"); if (fi) fi.click();
    });
    const fileIn = document.getElementById("file-input");
    if (fileIn) fileIn.onchange = (e) => App._onFileSelected(e);

    bindPrevent("btn-create-group", () => App.openCreateGroup());
    bind("btn-confirm-group", () => App.createGroup());
    bind("btn-cancel-group", () => App.closeCreateGroup());
    bindPrevent("btn-record-voice", () => App._toggleVoiceRecord());

    const chatSearch = document.getElementById("chat-search");
    if (chatSearch) chatSearch.oninput = (e) => {
      App.searchQuery = e.target.value.trim();
      App.renderFriends();
    };

    // Mobile swipe-to-go-back (native feel)
    App._setupSwipeBack();

    // Desktop + global QOL keyboard shortcuts (native app feel)
    // Backdrop clicks to close sheets (production UX polish)
    document.addEventListener("click", (e) => {
      const sheet = e.target.closest(".sheet");
      if (sheet && e.target === sheet) {
        sheet.classList.add("hidden");
      }
      const modal = e.target.closest(".modal-overlay");
      if (modal && e.target === modal) {
        modal.classList.add("hidden");
      }
    }, true);

    document.addEventListener("keydown", (e) => {
      const isInputFocused = document.activeElement && (
        document.activeElement.tagName === "INPUT" ||
        document.activeElement.tagName === "TEXTAREA" ||
        document.activeElement.isContentEditable
      );

      // Cmd/Ctrl + K : focus search
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const search = document.getElementById("chat-search");
        if (search) {
          search.focus();
          search.select();
        }
        return;
      }

      // Escape handling
      if (e.key === "Escape") {
        const openSheet = document.querySelector(".sheet:not(.hidden)");
        const openModal = document.querySelector(".modal-overlay:not(.hidden)");
        if (openSheet || openModal) {
          e.preventDefault();
          App.closeAllSheets();
          return;
        }
        if (!App.isDesktop() && App.activeChat) {
          e.preventDefault();
          App.closeChat();
          return;
        }
        if (App.isDesktop() && App.activeChat) {
          e.preventDefault();
          App.closeChat();
          return;
        }
      }

      // "/" focuses search when not typing in input (common shortcut)
      if (e.key === "/" && !isInputFocused) {
        const search = document.getElementById("chat-search");
        if (search && document.getElementById("main-view") && !document.getElementById("main-view").classList.contains("hidden")) {
          e.preventDefault();
          search.focus();
        }
      }
    });
  },

  _setupSwipeBack() {
    const chatView = document.getElementById("chat-view");
    if (!chatView || chatView._swipeBound) return;
    chatView._swipeBound = true;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let lastDx = 0;

    const threshold = 68;
    const maxVertical = 55;

    chatView.addEventListener("touchstart", (e) => {
      if (App.isDesktop() || !App.activeChat) return;
      if (e.target.closest("button, .header-btn, .back-btn, a")) {
        tracking = false;
        return;
      }
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      lastDx = 0;
      tracking = (startX < 50);
    }, { passive: true });

    chatView.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      lastDx = dx;
      if (dx > 18 && dy < maxVertical) {
        const progress = Math.min(dx / 240, 1);
        chatView.style.transition = "none";
        chatView.style.transform = `translateX(${dx * 0.55}px)`;
        chatView.style.opacity = String(1 - progress * 0.25);
      }
    }, { passive: true });

    const finishSwipe = () => {
      if (!tracking) return;
      tracking = false;
      chatView.style.transition = "";
      chatView.style.transform = "";
      chatView.style.opacity = "";
      if (lastDx > threshold && !App.isDesktop() && App.activeChat) {
        App.closeChat();
      }
      lastDx = 0;
    };

    chatView.addEventListener("touchend", finishSwipe, { passive: true });
    chatView.addEventListener("touchcancel", finishSwipe, { passive: true });
  },

  _bindWS() {
    if (App.wsBound) return;
    App.wsBound = true;
    WSClient.on("message", async (data) => {
      const senderId = data.sender_id;
      if (!senderId) return;
      if (App.purgedPeers && App.purgedPeers.has(senderId)) {
        App._purgeAllFromPeer(senderId);
        return;
      }
      if (!Friends.list.includes(senderId)) return;

      if (!KoalaMix.ratchets[senderId]) {
        await Friends.setupRatchet(App.accountId, senderId, App.privateKey);
      }
      if (!KoalaMix.ratchets[senderId]) return;
      try {
        const payload = await KoalaMix.open(senderId, data.envelope);
        if (!payload) return;
        if (payload.kind === "group_key") {
          await Groups.handleGroupKey(payload);
          await Groups.saveKeys();
          App.renderFriends();
          App._toast(`Joined group ${payload.name}`);
          return;
        }
        const msg = App._payloadToMessage(payload);
        const recvTtl = (typeof data.ttl === "number") ? data.ttl : 3600;
        const expiresAt = (recvTtl > 0) ? (Date.now() + recvTtl * 1000) : null;
        Messages.add(senderId, msg, "received", expiresAt);

        if (App.activeChat === senderId) {
          App.renderMessages(senderId);
        } else {
          App.renderFriends();
        }
        App._notifyNewMessage(senderId);
      } catch (_) {
        App._toast("Could not read message try reopening the chat");
      }
    });

    WSClient.on("group_message", async (data) => {
      const groupId = data.group_id;
      const senderId = data.sender_id;
      const chatKey = Groups.chatKey(groupId);
      if (!Groups.list.includes(groupId)) return;
      if (!GroupCrypto.hasKey(groupId)) return;
      if (senderId && App.purgedPeers && App.purgedPeers.has(senderId)) {
        App._purgeAllFromPeer(senderId);
        return;
      }
      try {
        const payload = await GroupCrypto.open(groupId, data.envelope);
        const msg = { ...App._payloadToMessage(payload), senderId: data.sender_id };
        const recvTtl = (typeof data.ttl === "number") ? data.ttl : 3600;
        const expiresAt = (recvTtl > 0) ? (Date.now() + recvTtl * 1000) : null;
        Messages.add(chatKey, msg, "received", expiresAt);
        if (App.activeChat === chatKey) {
          App.renderMessages(chatKey);
        } else {
          App.renderFriends();
        }
        App._notifyNewMessage(chatKey, Friends.displayName(data.sender_id));
      } catch (_) {
        App._toast("Could not read group message");
      }
    });

    WSClient.on("group_created", async (data) => {
      if (data.creator_id === App.accountId) return;
      if (Groups.list.includes(data.group_id)) {
        Groups.updateMembers(data.group_id, data.members);
        return;
      }
      Groups.add(data.group_id, data.name, data.members, null);
      App.renderFriends();
      App._toast(`Added to group ${data.name}`);
    });

    WSClient.on("group_member_left", (data) => {
      if (!Groups.list.includes(data.group_id)) return;
      if (data.member_id === App.accountId) {
        Groups.remove(data.group_id);
        Messages.clear(Groups.chatKey(data.group_id));
        if (App.activeChat === Groups.chatKey(data.group_id)) App.closeChat();
      } else {
        Groups.updateMembers(data.group_id, data.members);
        if (App.activeChat === Groups.chatKey(data.group_id)) {
          App._updateGroupHeader(data.group_id);
        }
      }
      App.renderFriends();
    });

    WSClient.on("friend_request", (data) => {
      App._onFriendRequest(data);
    });

    WSClient.on("friend_request_sent", (data) => {
      const code = data.to_friend_code || "";
      if (code) Friends.addSentRequest(code);
      App.renderSentStatus();
      App._toast("Invite request sent");
    });

    WSClient.on("peer_purged", (data) => {
      const purgedId = data.friend_id || data.account_id;
      if (!purgedId) return;
      App._purgeAllFromPeer(purgedId);
    });

    WSClient.on("account_purged", (data) => {
      const purgedId = data.account_id || data.friend_id;
      if (!purgedId) return;
      App._purgeAllFromPeer(purgedId);
    });

    WSClient.on("friend_removed", (data) => {
      const friendId = data.friend_id;
      if (!Friends.list.includes(friendId)) return;
      App._purgeContactLocal(friendId, false);
      App._toast("A contact removed you");
    });

    WSClient.on("friend_accepted", async (data) => {
      if (data.public_key) {
        Friends.add(data.friend_id, data.public_key, data.friend_code || "");
        if (data.friend_code) Friends.removeSentRequest(data.friend_code);
        await Friends.setupRatchet(App.accountId, data.friend_id, App.privateKey);
      }
      App.renderFriends();
      App.renderRequests();
      App.renderSentStatus();
      App._toast("Contact accepted your request");
      if (App.isDesktop() && !App.activeChat && Friends.list.length === 1) {
        App.openChat(data.friend_id);
      }
    });

    WSClient.on("error", (data) => {
      if (data.message) App._toast(data.message);
    });

    WSClient.on("purge_ack", () => {
      // The initiating client handles reload itself after local cleanup.
      // Non-initiating or other acks are no-ops.
    });

    WSClient.on("presence_snapshot", (data) => {
      const onlineSet = new Set(data.online || []);
      Friends.list.forEach((fid) => {
        App.peerOnline[fid] = onlineSet.has(fid);
      });
      App._refreshPresenceUI();
    });

    WSClient.on("presence", (data) => {
      const friendId = data.friend_id;
      if (!Friends.list.includes(friendId)) return;
      App.peerOnline[friendId] = data.status === "online";
      if (data.status === "offline") {
        App.peerTyping[friendId] = false;
        clearTimeout(App._peerTypingTimers[friendId]);
      }
      App._refreshPresenceUI();
    });

    WSClient.on("typing", (data) => {
      const fromId = data.from_id;
      if (!Friends.list.includes(fromId)) return;
      App.peerTyping[fromId] = Boolean(data.active);
      clearTimeout(App._peerTypingTimers[fromId]);
      if (data.active) {
        App._peerTypingTimers[fromId] = setTimeout(() => {
          App.peerTyping[fromId] = false;
          App._refreshPresenceUI();
        }, 5000);
      }
      App._refreshPresenceUI();
    });

    WSClient.on("connected", () => {
      App._setConnectionUI(true);
    });

    WSClient.on("disconnected", () => {
      App._setConnectionUI(false, navigator.onLine ? "Reconnecting..." : "Offline");
    });

    WSClient.on("account_invalid", () => {
      App._handleStaleAccount();
    });

    WSClient.on("connection_failed", () => {
      App._toast("Cannot connect hard-refresh the page and create a new account");
    });

    // Mark sent messages as delivered when server acks (visual polish)
    WSClient.on("message_sent", (data) => {
      if (!App.activeChat || !data.id) return;
      const conv = Messages.conversations[App.activeChat] || [];
      // Update last pending sent item
      for (let i = conv.length - 1; i >= 0; i--) {
        if (conv[i].direction === "sent" && (!conv[i].status || conv[i].status === "sending")) {
          conv[i].status = "sent";
          break;
        }
      }
      Messages.save();
      App.renderMessages(App.activeChat);
    });
  },



  _onFriendRequest(data) {
    const added = Friends.addRequest(data);
    App.renderRequests();
    if (added) {
      App._toast("New contact request");
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("KoalaChat", {
          body: "New contact request",
          icon: "/static/icons/logo.png",
        });
      }
    }
  },

  renderRequests() {
    const list = document.getElementById("requests-list");
    const empty = document.getElementById("requests-empty");
    const badge = document.getElementById("request-badge");
    const countEl = document.getElementById("requests-count");
    const count = Friends.getRequestCount();

    if (count === 0) {
      badge.classList.add("hidden");
      list.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      if (countEl) countEl.textContent = "";
      App.closeRequestsInbox();
      return;
    }

    badge.classList.remove("hidden");
    badge.textContent = count > 9 ? "9+" : count.toString();
    if (countEl) countEl.textContent = count === 1 ? "1 pending" : `${count} pending`;
    if (empty) empty.classList.add("hidden");
    list.innerHTML = "";

    Friends.incomingRequests.forEach((req) => {
      const label = Friends.displayName(req.from_id);
      const li = document.createElement("li");
      li.className = "request-item";
      li.innerHTML = `
        <div class="avatar" style="background:${App.avatarColor(label)}">${App.avatarInitial(label)}</div>
        <div class="request-item-body">
          <span class="request-item-name">${App._escapeHtml(label)}</span>
          <span class="request-item-hint">Wants to connect</span>
        </div>
        <div class="request-item-actions">
          <button type="button" class="btn-accept" data-from="${req.from_id}" aria-label="Accept request from ${label}">Accept</button>
          <button type="button" class="btn-decline" data-from="${req.from_id}" aria-label="Decline request from ${label}">Decline</button>
        </div>
      `;
      const acceptBtn = li.querySelector(".btn-accept");
      const declineBtn = li.querySelector(".btn-decline");
      const onAccept = (e) => {
        e.preventDefault();
        e.stopPropagation();
        App.acceptRequest(req);
      };
      const onDecline = (e) => {
        e.preventDefault();
        e.stopPropagation();
        App.declineRequest(req.from_id);
      };
      acceptBtn.addEventListener("click", onAccept);
      declineBtn.addEventListener("click", onDecline);
      list.appendChild(li);
    });
  },

  renderSentStatus() {
    const strip = document.getElementById("sent-requests-strip");
    if (!strip) return;
    if (Friends.sentRequests.length === 0) {
      strip.classList.add("hidden");
      strip.textContent = "";
      return;
    }
    strip.classList.remove("hidden");
    const n = Friends.sentRequests.length;
    strip.textContent = n === 1 ? "1 pending invite sent" : `${n} pending invites sent`;
  },

  async acceptRequest(req) {
    if (!req.public_key) {
      App._toast("Request is missing encryption keys ask them to resend");
      return;
    }
    Friends.add(req.from_id, req.public_key, req.from_friend_code || "");
    WSClient.send({
      type: "friend_accept",
      friend_id: req.from_id,
      public_key: App.publicKeyHex,
      fingerprint: App.fingerprint,
    });
    await Friends.setupRatchet(App.accountId, req.from_id, App.privateKey);
    App.renderFriends();
    App.renderRequests();
    App.closeRequestsInbox();
    App._toast(`You are now connected with ${Friends.displayName(req.from_id)}`);
    if (App.isDesktop()) App.openChat(req.from_id);
  },

  declineRequest(fromId) {
    Friends.removeRequest(fromId);
    WSClient.send({ type: "friend_reject", friend_id: fromId });
    App.renderRequests();
    App.closeRequestsInbox();
    App._toast("Request declined");
  },

  openRequestsInbox() {
    const count = Friends.getRequestCount();
    if (count === 0) {
      App._toast("No pending friend requests");
      return;
    }
    App.renderRequests();
    document.getElementById("requests-panel").classList.remove("hidden");
  },

  closeRequestsInbox() {
    document.getElementById("requests-panel").classList.add("hidden");
  },

  _toast(message) {
    const el = document.getElementById("app-toast");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("hidden");
    requestAnimationFrame(() => el.classList.add("app-toast-visible"));
    clearTimeout(App._toastTimer);
    clearTimeout(App._toastHideTimer);
    App._toastTimer = setTimeout(() => {
      el.classList.remove("app-toast-visible");
      App._toastHideTimer = setTimeout(() => el.classList.add("hidden"), 220);
    }, 3500);
  },

  openQR() {
    document.getElementById("qr-panel").classList.remove("hidden");
    App.renderQR();
  },

  closeQR() {
    document.getElementById("qr-panel").classList.add("hidden");
  },

  openScanner() {
    document.getElementById("scanner-panel").classList.remove("hidden");
    App._startScanner();
  },

  closeScanner() {
    App._stopScanner();
    App._updateFlipButton(false);
    document.getElementById("scanner-panel").classList.add("hidden");
  },

  _setConnectionUI(connected, label) {
    const dot = document.getElementById("connection-status");
    const text = document.getElementById("connection-label");
    if (dot) {
      dot.className = connected ? "status-dot status-connected" : "status-dot status-disconnected";
      dot.title = connected ? "Connected • E2EE" : (label || "Offline");
    }
    if (text) text.textContent = connected ? "Secure • E2EE" : (label || "Offline");
  },

  confirmRemoveContact(peerId) {
    if (!peerId) return;
    App._removeTarget = peerId;
    App._removeMode = "contact";
    const name = Friends.displayName(peerId);
    const el = document.getElementById("remove-modal-text");
    if (el) el.textContent = `Remove ${name} from your contacts and clear your local chat history on this device?`;
    document.getElementById("remove-modal").classList.remove("hidden");
  },

  cancelRemoveContact() {
    App._removeTarget = null;
    document.getElementById("remove-modal").classList.add("hidden");
  },

  _purgeContactLocal(peerId, closeIfActive) {
    Friends.remove(peerId);
    Messages.clear(peerId);
    delete App.peerOnline[peerId];
    delete App.peerTyping[peerId];
    clearTimeout(App._peerTypingTimers[peerId]);
    if (closeIfActive && App.activeChat === peerId) App.closeChat();
    App.renderFriends();
  },

  // Strong "force delete everything from this person" used by Koala Purge propagation.
  // Clears 1:1 convo + every message they ever sent in any group + cleans local membership state.
  _purgeAllFromPeer(purgedId) {
    if (!purgedId) return;

    // Direct friend / 1:1
    Friends.remove(purgedId);
    Messages.purgeFrom(purgedId);
    delete App.peerOnline[purgedId];
    delete App.peerTyping[purgedId];
    clearTimeout(App._peerTypingTimers[purgedId]);

    // Crypto ratchet / key material for this peer
    if (typeof KoalaMix !== "undefined" && KoalaMix.wipePeer) {
      try { KoalaMix.wipePeer(purgedId); } catch (_) {}
    }

    // Scrub from every group conversation + local group membership lists
    if (typeof Groups !== "undefined" && Groups.list) {
      for (const gid of [...Groups.list]) {
        const chatKey = Groups.chatKey(gid);
        Messages.purgeSenderFromChat(chatKey, purgedId);

        // Remove from local group member list if present
        const meta = Groups.meta && Groups.meta[gid];
        if (meta && Array.isArray(meta.members)) {
          meta.members = meta.members.filter((m) => m !== purgedId);
        }
      }
      // Persist any group member list changes caused by remote purge
      if (typeof Groups.save === "function") {
        try { Groups.save(); } catch (_) {}
      }
    }

    // If currently viewing a direct chat or a group that might be affected, refresh
    if (App.activeChat === purgedId) {
      App.closeChat();
    } else if (App.activeChat && typeof Groups !== "undefined" && Groups.isGroupChat && Groups.isGroupChat(App.activeChat)) {
      App.renderMessages(App.activeChat);
    }

    App.renderFriends();

    if (App.purgedPeers) App.purgedPeers.add(purgedId);

    try { App._toast("Messages from a purged account were cleared from this device"); } catch (_) {}
  },

  removeContact(peerId) {
    if (!peerId) return;
    App.cancelRemoveContact();
    WSClient.send({ type: "friend_remove", friend_id: peerId });
    App._purgeContactLocal(peerId, true);
    App._toast("Contact removed");
  },

  clearActiveChat() {
    if (!App.activeChat) return;
    Messages.clear(App.activeChat);
    App.renderMessages(App.activeChat);
    App.renderFriends();
    App._toast("Chat cleared");
  },

  openSettings() {
    const panel = document.getElementById("settings-panel");
    panel.classList.remove("hidden");
    App._setVersionLabels();
  },

  closeSettings() {
    document.getElementById("settings-panel").classList.add("hidden");
  },

  openNicknameEditor() {
    if (!App.activeChat) {
      App._toast("Select a chat first");
      return;
    }
    const input = document.getElementById("nickname-input");
    const hint = document.getElementById("nickname-hint");
    if (hint) hint.textContent = "Only stored on this device";
    if (input) input.value = Friends.nicknames[App.activeChat] || "";
    document.getElementById("nickname-panel").classList.remove("hidden");
    if (input) {
      input.focus();
      input.select();
    }
  },

  saveNickname() {
    if (!App.activeChat) return;
    const input = document.getElementById("nickname-input");
    Friends.setNickname(App.activeChat, input ? input.value : "");
    App._updateChatHeader(App.activeChat);
    App.renderFriends();
    App.closeNicknameEditor();
    App._toast("Nickname saved");
  },

  closeNicknameEditor() {
    document.getElementById("nickname-panel").classList.add("hidden");
  },

  showUsernamePanel() {
    document.getElementById("login-username-panel").classList.remove("hidden");
    const u = document.getElementById("login-username-input");
    const p = document.getElementById("login-password-input");
    if (u) u.value = "";
    if (p) p.value = "";
    if (u) u.focus();
    // wire buttons
    const confirmBtn = document.getElementById("btn-confirm-login");
    if (confirmBtn) confirmBtn.onclick = () => App.continueWithUsername();
    const cancelBtn = document.getElementById("btn-cancel-login");
    if (cancelBtn) cancelBtn.onclick = () => App.closeUsernamePanel();
    // allow enter to submit
    if (p) {
      p.onkeydown = (e) => {
        if (e.key === "Enter") App.continueWithUsername();
      };
    }
    if (u) {
      u.onkeydown = (e) => {
        if (e.key === "Enter") {
          if (p) p.focus();
        }
      };
    }
  },

  closeUsernamePanel() {
    const panel = document.getElementById("login-username-panel");
    if (panel) panel.classList.add("hidden");
  },

  async continueWithUsername() {
    const uInput = document.getElementById("login-username-input");
    const pInput = document.getElementById("login-password-input");
    const confirmBtn = document.getElementById("btn-confirm-login");
    if (!uInput || !pInput) return;

    const username = (uInput.value || "").trim();
    const password = pInput.value || "";

    if (!username || username.length < 3) {
      App._toast("Username must be at least 3 characters");
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      App._toast("Username can only use letters, numbers and _");
      return;
    }
    if (!password || password.length < 6) {
      App._toast("Password must be at least 6 characters");
      return;
    }

    const origText = confirmBtn ? confirmBtn.textContent : "";
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Please wait...";
    }

    const normalized = username.toLowerCase();

    try {
      const hash = await App.derivePasswordHash(username, password);

      // 1. Try logging into an existing username account
      let loginRes = await fetch("/api/username/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password_hash: hash }),
      });

      let data;
      if (loginRes.ok) {
        data = await loginRes.json();
      } else {
        // 2. Username not taken or wrong password → create a new account + claim immediately
        const keyPair = await E2EE.generateKeyPair();
        App.privateKey = keyPair.privateKey;
        App.publicKeyHex = await E2EE.exportPublicKey(keyPair.publicKey);
        App.fingerprint = await E2EE.fingerprint(App.publicKeyHex);

        const regRes = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key_fingerprint: App.fingerprint }),
        });
        if (!regRes.ok) {
          const e = await regRes.json().catch(() => ({}));
          throw new Error(e.detail || "Could not create new account");
        }
        const regData = await regRes.json();

        const claimRes = await fetch("/api/username/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            account_id: regData.account_id,
            username,
            password_hash: hash,
          }),
        });
        if (!claimRes.ok) {
          throw new Error("That username is already taken");
        }

        data = {
          account_id: regData.account_id,
          friend_code: regData.friend_code,
          fingerprint: App.fingerprint,
          username: normalized,
        };

        // Save the new keys right away
        const privateJwk = await crypto.subtle.exportKey("jwk", App.privateKey);
        localStorage.setItem("koala_account", JSON.stringify({
          accountId: data.account_id,
          friendCode: data.friend_code,
          publicKeyHex: App.publicKeyHex,
          fingerprint: App.fingerprint,
          privateKeyJwk: privateJwk,
          username: normalized,
        }));
      }

      // Apply identity
      App.accountId = data.account_id;
      App.friendCode = data.friend_code;
      App.username = data.username || normalized;
      App.fingerprint = data.fingerprint || App.fingerprint;

      // If we didn't generate keys in the create branch, try to pull existing ones from storage
      if (!App.privateKey) {
        try {
          const existing = localStorage.getItem("koala_account");
          if (existing) {
            const prev = JSON.parse(existing);
            if (prev.accountId === App.accountId && prev.privateKeyJwk) {
              App.publicKeyHex = prev.publicKeyHex;
              await App._restoreKeys(prev.privateKeyJwk);
            }
          }
        } catch (_) {}
      }

      await App._persistAccount();
      App.closeUsernamePanel();

      App._bindEvents();
      App._bindWS();
      WSClient.connect(App.accountId);
      App.showMain();

      const msg = App.privateKey
        ? `Using "${App.username}"`
        : `Using "${App.username}" (keys for this account not found on this device)`;
      App._toast(msg);
      await App._loadUsername();
    } catch (e) {
      App._toast(e.message || "Login or registration failed");
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = origText || "Continue";
      }
    }
  },

  _setVersionLabels() {
    const label = `KoalaChat v${App.VERSION}`;
    document.querySelectorAll("[data-app-version]").forEach((el) => {
      el.textContent = label;
    });
  },

  _updateFlipButton(visible) {
    const btn = document.getElementById("btn-flip-camera");
    if (!btn) return;
    btn.classList.toggle("hidden", !visible);
  },

  async _startScanner() {
    App._stopScanner();
    App._scannerCameras = [];
    App._scannerCameraIdx = 0;
    App._scannerFacing = App.isDesktop() ? "user" : "environment";
    App._scannerActive = false;
    App._updateFlipButton(false);
    if (typeof Html5Qrcode === "undefined") {
      App._toast("QR scanner failed to load");
      return;
    }
    const hint = document.getElementById("scanner-hint");
    if (hint) hint.textContent = "Starting camera...";
    App._html5QrCode = new Html5Qrcode("qr-reader");
    let started = false;
    try {
      const cameras = await Html5Qrcode.getCameras();
      App._scannerCameras = cameras || [];
      if (cameras.length > 0) {
        const preferredIdx = App.isDesktop()
          ? cameras.findIndex((c) => /front|user|face/i.test(c.label))
          : cameras.findIndex((c) => /back|rear|environment/i.test(c.label));
        App._scannerCameraIdx = preferredIdx >= 0 ? preferredIdx : 0;
        started = await App._runScannerCamera(cameras[App._scannerCameraIdx].id);
      }
    } catch (_) {}
    if (!started) {
      const fallbacks = App.isDesktop()
        ? [{ facingMode: "user" }, true]
        : [{ facingMode: "environment" }, { facingMode: "user" }, true];
      for (const camera of fallbacks) {
        if (camera.facingMode) App._scannerFacing = camera.facingMode;
        started = await App._runScannerCamera(camera);
        if (started) break;
      }
    }
    if (hint) {
      hint.textContent = started
        ? "Point your camera at a KoalaChat QR code, or upload a screenshot below."
        : "Camera unavailable upload a screenshot of a QR code below.";
    }
    if (!started) App._toast("Camera unavailable use Upload QR Image");
    App._updateFlipButton(started);
  },

  async _runScannerCamera(spec) {
    if (!App._html5QrCode) return false;
    const onScan = (decoded) => App._onQRScanned(decoded);
    const config = { fps: 10, qrbox: { width: 250, height: 250 } };
    try {
      await App._html5QrCode.start(spec, config, onScan, () => {});
      App._scannerActive = true;
      return true;
    } catch (_) {
      App._scannerActive = false;
      return false;
    }
  },

  async _flipScannerCamera() {
    if (!App._html5QrCode || !App._scannerActive) return;
    try {
      await App._html5QrCode.stop();
    } catch (_) {}
    App._scannerActive = false;
    let started = false;
    if (App._scannerCameras.length > 1) {
      App._scannerCameraIdx = (App._scannerCameraIdx + 1) % App._scannerCameras.length;
      started = await App._runScannerCamera(App._scannerCameras[App._scannerCameraIdx].id);
    } else {
      App._scannerFacing = App._scannerFacing === "user" ? "environment" : "user";
      started = await App._runScannerCamera({ facingMode: App._scannerFacing });
    }
    if (!started) {
      App._toast("Could not switch camera");
      App._updateFlipButton(false);
      return;
    }
    App._updateFlipButton(true);
  },

  _stopScanner() {
    if (!App._html5QrCode) return;
    const scanner = App._html5QrCode;
    App._html5QrCode = null;
    scanner.stop().then(() => scanner.clear()).catch(() => {
      try { scanner.clear(); } catch (_) {}
    });
  },

  async _onQRFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || typeof Html5Qrcode === "undefined") return;
    if (!App._html5QrCode) App._html5QrCode = new Html5Qrcode("qr-reader");
    try {
      const decoded = await App._html5QrCode.scanFile(file, false);
      await App._onQRScanned(decoded);
    } catch (_) {
      App._toast("No QR code found in that image");
    }
  },

  _sendFriendRequest(target) {
    if (!target) return;
    const payload = {
      type: "friend_request",
      fingerprint: App.fingerprint,
      public_key: App.publicKeyHex,
    };
    if (target.legacy) {
      payload.to_id = target.id;
    } else {
      payload.to_friend_code = target.fc;
    }
    WSClient.send(payload);
    if (!WSClient.isReady()) {
      App._toast("Connecting request will send shortly");
    }
  },

  async _onQRScanned(data) {
    const parsed = Friends.parseQRData(data);
    if (!parsed) {
      App._toast("Invalid QR code");
      return;
    }
    if (parsed.fc === App.friendCode || parsed.id === App.accountId) {
      App._toast("You cannot add yourself");
      return;
    }
    App.closeScanner();
    App._sendFriendRequest(parsed);
  },

  async copyFriendCode() {
    if (!App.friendCode) {
      App._toast("Invite code not ready yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(App.friendCode);
      App._toast("Invite code copied");
      const btn = document.getElementById("btn-copy-friendcode");
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { if (btn) btn.textContent = prev; }, 1500);
      }
    } catch (_) {
      App._toast("Copied to clipboard failed code is " + App.friendCode);
    }
  },

  showAddFriend() {
    document.getElementById("add-friend-panel").classList.remove("hidden");
  },

  hideAddFriend() {
    document.getElementById("add-friend-panel").classList.add("hidden");
  },

  async addFriendManual() {
    const code = document.getElementById("friend-code-input").value.trim();
    if (!code) return;
    if (code.length !== 10) {
      App._toast("Invite code must be 10 digits");
      return;
    }
    if (code === App.friendCode) {
      App._toast("You cannot add yourself");
      return;
    }
    if (Friends.list.some((id) => Friends.peerCodes[id] === code)) {
      App._toast("Already connected with this friend");
      return;
    }
    if (Friends.sentRequests.includes(code)) {
      App._toast("Request already sent");
      return;
    }

    const res = await fetch(`/api/friendcode/${code}/exists`);
    const data = await res.json();
    if (!data.exists) {
      App._toast("Friend code not found");
      return;
    }

    App._sendFriendRequest({ fc: code });
    document.getElementById("friend-code-input").value = "";
    App.hideAddFriend();
  },

  confirmPurge() {
    const modal = document.getElementById("purge-modal");
    if (modal) modal.classList.remove("hidden");
  },

  _cancelPurge() {
    const modal = document.getElementById("purge-modal");
    if (modal) modal.classList.add("hidden");
  },

  async _doPurge() {
    const modal = document.getElementById("purge-modal");
    if (modal) modal.classList.add("hidden");
    try {
      if (typeof Purge !== "undefined" && Purge.execute) {
        if (App.accountId) {
          await Purge.execute(App.accountId);
        } else {
          await Purge.execute(null);
        }
      } else {
        // Last resort: minimal cleanup + reload
        try { localStorage.clear(); } catch (_) {}
        setTimeout(() => window.location.reload(), 10);
      }
    } catch (err) {
      // Force reset no matter what
      console.error("Purge error", err);
      setTimeout(() => window.location.reload(), 10);
    }
  },

  _notifyNewMessage(chatId, label) {
    if ("Notification" in window && Notification.permission === "granted") {
      const name = label || (Groups.isGroupChat(chatId)
        ? Groups.displayName(Groups.groupIdFromChat(chatId))
        : Friends.displayName(chatId));
      new Notification("KoalaChat", {
        body: `New message from ${name}`,
        icon: "/static/icons/logo.png",
      });
    }
  },

  openCreateGroup() {
    if (Friends.list.length === 0) {
      App._toast("Add friends before creating a group");
      return;
    }
    const list = document.getElementById("group-member-list");
    list.innerHTML = "";
    Friends.list.forEach((fid) => {
      const label = document.createElement("label");
      label.className = "group-member-option";
      label.innerHTML = `
        <input type="checkbox" value="${fid}" name="group-member">
        <span>${App._escapeHtml(Friends.displayName(fid))}</span>
      `;
      list.appendChild(label);
    });
    document.getElementById("group-name-input").value = "";
    document.getElementById("create-group-panel").classList.remove("hidden");
  },

  closeCreateGroup() {
    document.getElementById("create-group-panel").classList.add("hidden");
  },

  async createGroup() {
    const name = document.getElementById("group-name-input").value.trim();
    if (!name) {
      App._toast("Enter a group name");
      return;
    }
    const selected = Array.from(document.querySelectorAll("#group-member-list input:checked")).map((el) => el.value);
    if (selected.length === 0) {
      App._toast("Select at least one friend");
      return;
    }
    const groupId = crypto.randomUUID();
    const key = await GroupCrypto.generateKey();
    const members = [App.accountId, ...selected];
    Groups.add(groupId, name, members, key);
    await Groups.saveKeys();
    WSClient.send({
      type: "group_create",
      group_id: groupId,
      name,
      member_ids: selected,
    });
    await Groups.distributeKey(groupId, members, key, name, members);
    App.closeCreateGroup();
    App.renderFriends();
    App.openChat(Groups.chatKey(groupId));
    App._toast(`Group "${name}" created`);
  },

  confirmLeaveGroup(groupId) {
    if (!groupId) return;
    App._removeTarget = groupId;
    App._removeMode = "group";
    const name = Groups.displayName(groupId);
    const el = document.getElementById("remove-modal-text");
    if (el) el.textContent = `Leave ${name} and clear local group history on this device?`;
    document.getElementById("remove-modal").classList.remove("hidden");
  },

  leaveGroup(groupId) {
    if (!groupId) return;
    App.cancelRemoveContact();
    WSClient.send({ type: "group_leave", group_id: groupId });
    const chatKey = Groups.chatKey(groupId);
    Groups.remove(groupId);
    Messages.clear(chatKey);
    if (App.activeChat === chatKey) App.closeChat();
    App.renderFriends();
    App._toast("Left group");
  },

  _startTTLCleanup() {
    setInterval(() => {
      Messages._purgeExpired();
      if (App.activeChat) App.renderMessages(App.activeChat);
    }, 10000);
  },

  async _registerSW() {
    if ("serviceWorker" in navigator) {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        await reg.update();
        let reloaded = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (reloaded) return;
          reloaded = true;
          window.location.reload();
        });
        if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      } catch (_) {}
    }
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());