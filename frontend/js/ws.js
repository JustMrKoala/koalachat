const WSClient = {
  socket: null,
  accountId: null,
  handlers: {},
  reconnectTimer: null,
  pingInterval: null,
  outbox: [],

  connect(accountId) {
    WSClient.accountId = accountId;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/${accountId}`;
    WSClient.socket = new WebSocket(url);

    WSClient.socket.onopen = () => {
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

    WSClient.socket.onclose = () => {
      clearInterval(WSClient.pingInterval);
      WSClient._emit("disconnected");
      WSClient.reconnectTimer = setTimeout(() => {
        if (WSClient.accountId) WSClient.connect(WSClient.accountId);
      }, 3000);
    };

    WSClient.socket.onerror = () => {
      WSClient.socket.close();
    };
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
    clearInterval(WSClient.pingInterval);
    WSClient.accountId = null;
    WSClient.outbox = [];
    if (WSClient.socket) {
      WSClient.socket.close();
      WSClient.socket = null;
    }
  },
};