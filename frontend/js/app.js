const AVATAR_COLORS = ["#00a884", "#53bdeb", "#e542a3", "#7f66ff", "#ff6b6b", "#ffa94d", "#20c997", "#845ef7"];

const App = {
  accountId: null,
  friendCode: null,
  keyPair: null,
  publicKeyHex: null,
  fingerprint: null,
  activeChat: null,
  privateKey: null,
  searchQuery: "",

  async init() {
    Messages.load();
    await Friends.loadFromStorage();
    AntiTamper.init();

    const stored = localStorage.getItem("koala_account");
    if (stored) {
      const data = JSON.parse(stored);
      App.accountId = data.accountId;
      App.friendCode = data.friendCode || null;
      App.publicKeyHex = data.publicKeyHex;
      App.fingerprint = data.fingerprint;
      await App._restoreKeys(data.privateKeyJwk);
      await App._ensureFriendCode();
      App.showMain();
      App._bindEvents();
      App._bindWS();
      WSClient.connect(App.accountId);
    } else {
      App.showWelcome();
    }

    App._registerSW();
    App._startTTLCleanup();
    window.addEventListener("resize", () => App._syncLayout());
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

  async _ensureFriendCode() {
    if (App.friendCode || !App.accountId) return;
    try {
      const res = await fetch(`/api/account/${App.accountId}/friendcode`);
      if (!res.ok) return;
      const data = await res.json();
      App.friendCode = data.friend_code;
      const stored = JSON.parse(localStorage.getItem("koala_account"));
      stored.friendCode = App.friendCode;
      localStorage.setItem("koala_account", JSON.stringify(stored));
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
      return;
    }

    const data = await res.json();
    App.accountId = data.account_id;
    App.friendCode = data.friend_code;

    const privateJwk = await crypto.subtle.exportKey("jwk", App.privateKey);
    localStorage.setItem(
      "koala_account",
      JSON.stringify({
        accountId: App.accountId,
        friendCode: App.friendCode,
        publicKeyHex: App.publicKeyHex,
        fingerprint: App.fingerprint,
        privateKeyJwk: privateJwk,
      })
    );

    App.showMain();
    App._bindEvents();
    App._bindWS();
    WSClient.connect(App.accountId);
  },

  showMain() {
    document.getElementById("welcome-view").classList.add("hidden");
    document.getElementById("main-view").classList.remove("hidden");
    document.getElementById("account-id-display").textContent = App.accountId;
    document.getElementById("friend-code-display").textContent = App.friendCode || "--------";
    document.getElementById("ttl-select").value = Messages.defaultTTL.toString();
    App.renderFriends();
    App.renderRequests();
    App.renderSentStatus();
    App.renderQR();
    App._syncLayout();
  },

  renderQR() {
    const container = document.getElementById("qr-code");
    container.innerHTML = "";
    const qrData = Friends.generateQRData(App.friendCode, App.fingerprint, App.publicKeyHex);
    if (typeof QRCode !== "undefined") {
      new QRCode(container, {
        text: qrData,
        width: 180,
        height: 180,
        colorDark: "#111b21",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H,
      });
    }
  },

  renderFriends() {
    const list = document.getElementById("friends-list");
    const empty = document.getElementById("empty-chats");
    list.innerHTML = "";
    const filtered = Friends.list.filter((fid) => {
      if (!App.searchQuery) return true;
      const name = Friends.displayName(fid);
      return name.includes(App.searchQuery) || fid.includes(App.searchQuery);
    });
    if (filtered.length === 0) {
      empty.classList.remove("hidden");
      list.classList.add("hidden");
      if (Friends.list.length > 0 && App.searchQuery) {
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
    filtered.forEach((fid) => {
      const msgs = Messages.get(fid);
      const last = msgs[msgs.length - 1];
      const li = document.createElement("li");
      li.className = `chat-item${fid === App.activeChat ? " active" : ""}`;
      const displayName = Friends.displayName(fid);
      const color = App.avatarColor(displayName);
      const preview = last ? last.text : "Tap to start chatting";
      const time = last ? App._formatListTime(last.timestamp) : "";
      li.innerHTML = `
        <div class="avatar" style="background:${color}">${App.avatarInitial(displayName)}</div>
        <div class="chat-item-body">
          <div class="chat-item-top">
            <span class="chat-item-name">${App._escapeHtml(displayName)}</span>
            ${time ? `<span class="chat-item-time">${time}</span>` : ""}
          </div>
          <div class="chat-item-preview">${App._escapeHtml(preview)}</div>
        </div>
      `;
      li.onclick = () => App.openChat(fid);
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

  async openChat(peerId) {
    App.activeChat = peerId;
    const displayName = Friends.displayName(peerId);
    document.getElementById("chat-peer-id").textContent = displayName;
    App.setAvatar(document.getElementById("chat-avatar"), displayName);
    document.getElementById("app-shell").classList.add("chat-open");
    App._syncLayout();
    App.renderFriends();
    await Friends.setupRatchet(App.accountId, peerId, App.privateKey);
    App.renderMessages(peerId);
    document.getElementById("message-input").focus();
  },

  closeChat() {
    App.activeChat = null;
    document.getElementById("app-shell").classList.remove("chat-open");
    App._syncLayout();
    App.renderFriends();
  },

  renderMessages(peerId) {
    const container = document.getElementById("chat-messages");
    container.innerHTML = "";
    const msgs = Messages.get(peerId);
    msgs.forEach((m) => {
      const row = document.createElement("div");
      row.className = `message-row ${m.direction}`;
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      const text = document.createElement("span");
      text.className = "message-text";
      text.textContent = m.text;
      bubble.appendChild(text);
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
      bubble.appendChild(meta);
      row.appendChild(bubble);
      container.appendChild(row);
    });
    container.scrollTop = container.scrollHeight;
  },

  _formatTTL(seconds) {
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
    return `${seconds}s`;
  },

  async sendMessage() {
    const input = document.getElementById("message-input");
    const text = input.value.trim();
    if (!text || !App.activeChat) return;

    const packet = await KoalaMix.seal(App.activeChat, text);
    const expiresAt = Date.now() + Messages.defaultTTL * 1000;

    WSClient.send({
      type: "message",
      recipient_id: App.activeChat,
      envelope: packet,
      ttl: Messages.defaultTTL,
    });

    Messages.add(App.activeChat, text, "sent", expiresAt);
    input.value = "";
    App.renderMessages(App.activeChat);
    App.renderFriends();
  },

  _bindEvents() {
    document.getElementById("btn-send").onclick = () => App.sendMessage();
    document.getElementById("message-input").onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        App.sendMessage();
      }
    };
    document.getElementById("btn-back").onclick = () => App.closeChat();
    document.getElementById("btn-scan-qr").onclick = () => App.openScanner();
    document.getElementById("btn-show-qr").onclick = () => App.openQR();
    document.getElementById("btn-settings").onclick = () => App.openSettings();
    document.getElementById("btn-purge-settings").onclick = () => App.confirmPurge();
    document.getElementById("btn-close-settings").onclick = () => App.closeSettings();
    document.getElementById("btn-close-qr").onclick = () => App.closeQR();
    document.getElementById("btn-close-scan").onclick = () => App.closeScanner();
    document.getElementById("ttl-select").onchange = (e) => {
      Messages.setTTL(parseInt(e.target.value, 10));
    };
    document.getElementById("btn-requests").onclick = () => App.scrollToRequests();
    document.getElementById("btn-add-friend").onclick = () => App.showAddFriend();
    document.getElementById("btn-confirm-add").onclick = () => App.addFriendManual();
    document.getElementById("btn-cancel-add").onclick = () => App.hideAddFriend();
    document.getElementById("btn-copy-friendcode").onclick = () => App.copyFriendCode();
    document.getElementById("chat-search").oninput = (e) => {
      App.searchQuery = e.target.value.trim();
      App.renderFriends();
    };
  },

  _bindWS() {
    WSClient.on("message", async (data) => {
      const senderId = data.sender_id;
      if (!Friends.list.includes(senderId)) return;

      await Friends.setupRatchet(App.accountId, senderId, App.privateKey);
      try {
        const text = await KoalaMix.open(senderId, data.envelope);
        const expiresAt = Date.now() + (data.ttl || 3600) * 1000;
        Messages.add(senderId, text, "received", expiresAt);

        if (App.activeChat === senderId) {
          App.renderMessages(senderId);
        } else {
          App.renderFriends();
        }
        App._notifyNewMessage(senderId);
      } catch (_) {}
    });

    WSClient.on("friend_request", (data) => {
      App._onFriendRequest(data);
    });

    WSClient.on("friend_request_sent", (data) => {
      const code = data.to_friend_code || "";
      if (code) Friends.addSentRequest(code);
      App.renderSentStatus();
      App._toast(`Friend request sent to ${code}`);
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
      App._toast(`${data.friend_code || "Contact"} accepted your request`);
      if (App.isDesktop() && !App.activeChat && Friends.list.length === 1) {
        App.openChat(data.friend_id);
      }
    });

    WSClient.on("error", (data) => {
      if (data.message) App._toast(data.message);
    });

    WSClient.on("purge_ack", () => {
      window.location.reload();
    });

    WSClient.on("connected", () => {
      const dot = document.getElementById("connection-status");
      dot.className = "status-dot status-connected";
      dot.title = "Connected";
    });

    WSClient.on("disconnected", () => {
      const dot = document.getElementById("connection-status");
      if (!navigator.onLine) return;
      dot.className = "status-dot status-disconnected";
      dot.title = "Reconnecting...";
    });
  },



  _onFriendRequest(data) {
    const added = Friends.addRequest(data);
    App.renderRequests();
    if (added) {
      const label = data.from_friend_code || data.from_id;
      App._toast(`New friend request from ${label}`);
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("KoalaChat", {
          body: `Friend request from ${label}`,
          icon: "/static/icons/logo.png",
        });
      }
    }
  },

  renderRequests() {
    const section = document.getElementById("requests-section");
    const list = document.getElementById("requests-list");
    const badge = document.getElementById("request-badge");
    const countEl = document.getElementById("requests-count");
    const count = Friends.getRequestCount();

    if (count === 0) {
      section.classList.add("hidden");
      badge.classList.add("hidden");
      list.innerHTML = "";
      return;
    }

    section.classList.remove("hidden");
    badge.classList.remove("hidden");
    badge.textContent = count > 9 ? "9+" : count.toString();
    countEl.textContent = count === 1 ? "1 pending" : `${count} pending`;
    list.innerHTML = "";

    Friends.incomingRequests.forEach((req) => {
      const label = req.from_friend_code || req.from_id;
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
      li.querySelector(".btn-accept").onclick = () => App.acceptRequest(req);
      li.querySelector(".btn-decline").onclick = () => App.declineRequest(req.from_id);
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
    const codes = Friends.sentRequests.join(", ");
    strip.textContent = `Pending: request sent to ${codes}`;
  },

  async acceptRequest(req) {
    if (!req.public_key) {
      App._toast("Request is missing encryption keys — ask them to resend");
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
    App._toast(`You are now connected with ${req.from_friend_code || req.from_id}`);
    if (App.isDesktop()) App.openChat(req.from_id);
  },

  declineRequest(fromId) {
    Friends.removeRequest(fromId);
    WSClient.send({ type: "friend_reject", friend_id: fromId });
    App.renderRequests();
    App._toast("Request declined");
  },

  scrollToRequests() {
    const section = document.getElementById("requests-section");
    if (section.classList.contains("hidden")) {
      App._toast("No pending friend requests");
      return;
    }
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  },

  _toast(message) {
    const el = document.getElementById("app-toast");
    el.textContent = message;
    el.classList.remove("hidden");
    clearTimeout(App._toastTimer);
    App._toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
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
    document.getElementById("scanner-panel").classList.add("hidden");
  },

  openSettings() {
    document.getElementById("settings-panel").classList.remove("hidden");
  },

  closeSettings() {
    document.getElementById("settings-panel").classList.add("hidden");
  },

  _startScanner() {
    const reader = document.getElementById("qr-reader");
    if (App._html5QrCode) {
      App._html5QrCode.stop().catch(() => {});
    }
    if (typeof Html5Qrcode === "undefined") return;
    App._html5QrCode = new Html5Qrcode("qr-reader");
    App._html5QrCode
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decoded) => App._onQRScanned(decoded),
        () => {}
      )
      .catch(() => {});
  },

  _stopScanner() {
    if (App._html5QrCode) {
      App._html5QrCode.stop().catch(() => {});
    }
  },

  async _onQRScanned(data) {
    const parsed = Friends.parseQRData(data);
    if (!parsed) return;
    if (parsed.fc === App.friendCode || parsed.id === App.accountId) return;
    App.closeScanner();

    if (parsed.legacy) {
      WSClient.send({
        type: "friend_request",
        to_id: parsed.id,
        fingerprint: App.fingerprint,
        public_key: App.publicKeyHex,
      });
    } else {
      WSClient.send({
        type: "friend_request",
        to_friend_code: parsed.fc,
        fingerprint: App.fingerprint,
        public_key: App.publicKeyHex,
      });
    }
  },

  async copyFriendCode() {
    if (!App.friendCode) return;
    try {
      await navigator.clipboard.writeText(App.friendCode);
      const btn = document.getElementById("btn-copy-friendcode");
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1500);
    } catch (_) {}
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
      App._toast("Friend code must be 10 digits");
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
      App._toast("Request already sent to this friend code");
      return;
    }

    const res = await fetch(`/api/friendcode/${code}/exists`);
    const data = await res.json();
    if (!data.exists) {
      App._toast("Friend code not found");
      return;
    }

    WSClient.send({
      type: "friend_request",
      to_friend_code: code,
      fingerprint: App.fingerprint,
      public_key: App.publicKeyHex,
    });
    document.getElementById("friend-code-input").value = "";
    App.hideAddFriend();
    if (!WSClient.isReady()) {
      App._toast("Connecting — request will send shortly");
    }
  },

  confirmPurge() {
    document.getElementById("purge-modal").classList.remove("hidden");
    document.getElementById("btn-confirm-purge").onclick = async () => {
      await Purge.execute(App.accountId);
      window.location.reload();
    };
    document.getElementById("btn-cancel-purge").onclick = () => {
      document.getElementById("purge-modal").classList.add("hidden");
    };
  },

  _notifyNewMessage(peerId) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("KoalaChat", {
        body: `New message from ${Friends.displayName(peerId)}`,
        icon: "/static/icons/logo.png",
      });
    }
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
        await navigator.serviceWorker.register("/sw.js");
      } catch (_) {}
    }
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());