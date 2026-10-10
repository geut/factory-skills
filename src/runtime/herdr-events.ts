import { connect as connectSocket, type Socket } from 'node:net';

export type HerdrPaneEvent = {
  event: 'pane_closed' | 'pane_exited';
  paneId: string;
};

export type PaneExitSource = {
  watch: (paneId: string, listener: (event: HerdrPaneEvent) => void) => () => void;
};

const reconnectDelays = [500, 1000, 2000, 5000];

export function connectHerdrEvents(input: {
  onReconnect?: () => void;
  socketPath: string;
}): PaneExitSource & { close: () => void } {
  const listeners = new Map<string, Set<(event: HerdrPaneEvent) => void>>();
  let socket: Socket | null = null;
  let closed = false;
  let everSubscribed = false;
  let attempt = 0;
  let requestCounter = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function handleLine(line: string, subscribeId: string): void {
    if (line.trim().length === 0) {
      return;
    }
    let message: {
      data?: { pane_id?: string };
      event?: string;
      id?: string;
      result?: { type?: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.id === subscribeId && message.result?.type === 'subscription_started') {
      attempt = 0;
      const resubscribe = everSubscribed;
      everSubscribed = true;
      if (resubscribe) {
        input.onReconnect?.();
      }
      return;
    }
    if (message.event !== 'pane_exited' && message.event !== 'pane_closed') {
      return;
    }
    const paneId = message.data?.pane_id;
    if (paneId === undefined || paneId.length === 0) {
      return;
    }
    const paneListeners = listeners.get(paneId);
    if (paneListeners === undefined) {
      return;
    }
    const event: HerdrPaneEvent = { event: message.event, paneId };
    for (const listener of paneListeners) {
      listener(event);
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) {
      return;
    }
    const delay = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)] ?? 5000;
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closed) {
      return;
    }
    const subscribeId = `sub${++requestCounter}`;
    let buffer = '';
    const sock = connectSocket(input.socketPath);
    socket = sock;
    sock.on('connect', () => {
      sock.write(
        `${JSON.stringify({
          id: subscribeId,
          method: 'events.subscribe',
          params: { subscriptions: [{ type: 'pane.exited' }, { type: 'pane.closed' }] },
        })}\n`,
      );
    });
    sock.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line, subscribeId);
        newline = buffer.indexOf('\n');
      }
    });
    sock.on('error', () => undefined);
    sock.on('close', () => {
      if (sock === socket) {
        socket = null;
      }
      scheduleReconnect();
    });
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.destroy();
    socket = null;
  }

  connect();

  return {
    close,
    watch(paneId, listener) {
      const paneListeners = listeners.get(paneId) ?? new Set();
      paneListeners.add(listener);
      listeners.set(paneId, paneListeners);
      return () => {
        const current = listeners.get(paneId);
        if (current === undefined) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          listeners.delete(paneId);
        }
      };
    },
  };
}
