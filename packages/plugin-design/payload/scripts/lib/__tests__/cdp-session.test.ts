import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connect } from '../cdp-session.mts';

class FakeSocket extends EventTarget {
  static latest: FakeSocket;
  sent: { id: number; method: string }[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.latest = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as { id: number; method: string });
  }

  close(): void {
    this.dispatchEvent(new Event('close'));
  }

  reply(data: unknown): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(data) }),
    );
  }
}

async function openConnection() {
  const connection = await connect('ws://fake');
  return { connection, socket: FakeSocket.latest };
}

describe('connect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves a call with the reply result', async () => {
    const { connection, socket } = await openConnection();
    const call = connection.send('Page.enable');
    socket.reply({ id: socket.sent[0]!.id, result: { ok: 1 } });
    await expect(call).resolves.toEqual({ ok: 1 });
  });

  it('rejects a call Chrome never answers, naming the method and the bound', async () => {
    const { connection } = await openConnection();
    const call = connection.send('Page.navigate');
    const outcome = expect(call).rejects.toThrow(
      'Chrome did not answer Page.navigate within 30000 ms',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
  });

  it('rejects a pending call, naming its method, when the socket closes', async () => {
    const { connection, socket } = await openConnection();
    const call = connection.send('Page.navigate');
    const outcome = expect(call).rejects.toThrow(
      'the Chrome debugging socket closed before Page.navigate answered',
    );
    socket.close();
    await outcome;
  });

  it('rejects a call issued after the socket closed', async () => {
    const { connection, socket } = await openConnection();
    socket.close();
    await expect(connection.send('Page.enable')).rejects.toThrow(
      'closed before Page.enable was sent',
    );
  });

  it('drops a reply that arrives after its call timed out', async () => {
    const { connection, socket } = await openConnection();
    const call = connection.send('Page.navigate');
    const outcome = expect(call).rejects.toThrow('did not answer');
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
    expect(() =>
      socket.reply({ id: socket.sent[0]!.id, result: {} }),
    ).not.toThrow();
  });

  it('does not throw when closed twice or with nothing pending', async () => {
    const { connection } = await openConnection();
    expect(() => {
      connection.close();
      connection.close();
    }).not.toThrow();
  });
});
