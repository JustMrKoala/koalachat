const WSClient = {
  socket: null,
  accountId: null,
  handlers: {},
  reconnectTimer: null,
  connectTimer: null,
  pingInterval: null,
  outbox: [],
  failCount: 0,

  connect(accountId) {
    WSClient.accountId = accountId;
    clearTimeout(WSClient.reconnectTimer);
    WSClient.reconnectTimer = null;
    if (WSClient.socket) {
      WSClient.socket.onclose = null;
      WSClient.socket.onerror = null;
      if (WSClient.socket.readyState === WebSocket.OPEN || WSClient.socket.readyState === WebSocket.CONNECTING) {
        WSClient.socket.close();
      }
      WSClient.socket = null;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/${accountId}`;
    WSClient.socket = new WebSocket(url);
    clearTimeout(WSClient.connectTimer);
    WSClient.connectTimer = setTimeout(() => {
      if (WSClient.socket && WSClient.socket.readyState === WebSocket.CONNECTING) {
        WSClient.socket.close();
        WSClient._emit("connection_failed");
      }
    }, 10000);

    WSClient.socket.onopen = () => {
      clearTimeout(WSClient.connectTimer);
      WSClient.failCount = 0;
      WSClient._flushOutbox();
      WSClient._emit("connected");
      WSClient.pingInterval = setInterval(() => {
        WSClient.send({ type: "ping" });
      }, 25000);
    };

    WSClient.socket.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        WSClient._emit(data.type, data);
      } catch (_) {}
    };

    WSClient.socket.onclose = (ev) => {
      clearTimeout(WSClient.connectTimer);
      clearInterval(WSClient.pingInterval);
      if (ev.code === 4001) {
        WSClient.accountId = null;
        clearTimeout(WSClient.reconnectTimer);
        WSClient.reconnectTimer = null;
        WSClient._emit("account_invalid");
        return;
      }
      WSClient.failCount += 1;
      if (WSClient.failCount >= 3) {
        WSClient._emit("connection_failed");
      }
      WSClient._emit("disconnected");
      WSClient.reconnectTimer = setTimeout(() => {
        WSClient._verifyAndReconnect();
      }, 3000);
    };

    WSClient.socket.onerror = () => {
      WSClient.socket.close();
    };
  },

  async _verifyAndReconnect() {
    if (!WSClient.accountId) return;
    try {
      const res = await fetch(`/api/account/${WSClient.accountId}/exists`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (!data.exists) {
          WSClient.accountId = null;
          clearTimeout(WSClient.reconnectTimer);
          WSClient.reconnectTimer = null;
          WSClient._emit("account_invalid");
          return;
        }
      }
    } catch (_) {}
    if (WSClient.accountId) WSClient.connect(WSClient.accountId);
  },

  send(data) {
    if (WSClient.socket && WSClient.socket.readyState === WebSocket.OPEN) {
      WSClient.socket.send(JSON.stringify(data));
      return true;
    }
    WSClient.outbox.push(data);
    return false;
  },

  isReady() {
    return WSClient.socket && WSClient.socket.readyState === WebSocket.OPEN;
  },

  _flushOutbox() {
    while (WSClient.outbox.length && WSClient.isReady()) {
      WSClient.socket.send(JSON.stringify(WSClient.outbox.shift()));
    }
  },

  on(event, handler) {
    if (!WSClient.handlers[event]) WSClient.handlers[event] = [];
    WSClient.handlers[event].push(handler);
  },

  off(event, handler) {
    if (!WSClient.handlers[event]) return;
    WSClient.handlers[event] = WSClient.handlers[event].filter((h) => h !== handler);
  },

  _emit(event, data) {
    (WSClient.handlers[event] || []).forEach((h) => h(data));
  },

  disconnect() {
    clearTimeout(WSClient.reconnectTimer);
    clearTimeout(WSClient.connectTimer);
    clearInterval(WSClient.pingInterval);
    WSClient.failCount = 0;
    WSClient.accountId = null;
    WSClient.outbox = [];
    if (WSClient.socket) {
      WSClient.socket.close();
      WSClient.socket = null;
    }
  },
};