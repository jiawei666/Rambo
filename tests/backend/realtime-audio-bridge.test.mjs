import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as connectTcp, createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import {
  adaptRealtimeAudioEvent,
  RealtimeAudioBridge
} from '../../src/main/realtime-audio-bridge.ts';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptFor(key) {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function encodeFrame(payload, options = {}) {
  const data = Buffer.from(payload);
  const masked = options.masked ?? false;
  const opcode = options.opcode ?? 1;
  const first = 0x80 | opcode;
  const maskLength = masked ? 4 : 0;
  let header;
  if (data.length < 126) {
    header = Buffer.from([first, (masked ? 0x80 : 0) | data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = (masked ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  if (!masked) return Buffer.concat([header, data]);
  const mask = randomBytes(4);
  const encoded = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index++) {
    encoded[index] = data[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, encoded]);
}

class FrameReader {
  buffer = Buffer.alloc(0);

  push(chunk) {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    const frames = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      const end = offset + length;
      if (this.buffer.length < end) break;
      const payload = Buffer.from(this.buffer.subarray(offset, end));
      if (masked) {
        for (let index = 0; index < payload.length; index++) {
          payload[index] ^= this.buffer[maskOffset + (index % 4)];
        }
      }
      frames.push({ final: Boolean(first & 0x80), opcode: first & 0x0f, payload });
      this.buffer = this.buffer.subarray(end);
    }
    return frames;
  }
}

function onceFrame(socket, reader, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for a WebSocket frame'));
    }, 3_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onData = chunk => {
      for (const frame of reader.push(chunk)) {
        if (!predicate(frame)) continue;
        cleanup();
        resolve(frame);
        return;
      }
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function closeServer(server) {
  await new Promise(resolve => server.close(() => resolve()));
}

async function createUpstream() {
  const server = createHttpServer();
  const requests = [];
  let socket = null;
  let received = null;
  server.on('upgrade', (request, upstreamSocket) => {
    requests.push(request.headers);
    socket = upstreamSocket;
    const key = request.headers['sec-websocket-key'];
    upstreamSocket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptFor(key)}`,
      '',
      ''
    ].join('\r\n'));
    const reader = new FrameReader();
    upstreamSocket.on('data', chunk => {
      for (const frame of reader.push(chunk)) {
        if (frame.opcode !== 1) continue;
        received = JSON.parse(frame.payload.toString('utf8'));
        const event = JSON.stringify({
          type: 'session.output_audio.delta',
          delta: 'AAE='
        });
        upstreamSocket.write(encodeFrame(event));
      }
    });
  });
  const port = await listen(server);
  return {
    baseUrl: `ws://127.0.0.1:${port}`,
    requests,
    received: () => received,
    socket: () => socket,
    close: () => closeServer(server)
  };
}

function openClient(baseUrl, headers = {}) {
  const url = new URL(`${baseUrl}/test-call`);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...headers
      }
    });
    request.once('upgrade', (response, socket, head) => {
      resolve({ response, socket, head });
    });
    request.once('response', response => {
      reject(new Error(`Expected WebSocket upgrade, received HTTP ${response.statusCode}`));
    });
    request.once('error', reject);
    request.end();
  });
}

test('realtime audio adapter rewrites only the mismatched output audio event', () => {
  assert.deepEqual(
    JSON.parse(adaptRealtimeAudioEvent(JSON.stringify({
      type: 'session.output_audio.delta',
      delta: 'AAE='
    }))),
    { type: 'output_audio.delta', audio: 'AAE=' }
  );
  assert.deepEqual(
    JSON.parse(adaptRealtimeAudioEvent(JSON.stringify({
      type: 'output_audio.delta',
      delta: 'AgI='
    }))),
    { type: 'output_audio.delta', audio: 'AgI=' }
  );
  const transcript = JSON.stringify({ type: 'transcript.delta', delta: 'hello' });
  assert.equal(adaptRealtimeAudioEvent(transcript), transcript);
  assert.equal(adaptRealtimeAudioEvent('not json'), 'not json');
});

test('realtime audio bridge rotates its loopback capability after closing', async () => {
  const bridge = new RealtimeAudioBridge();
  const first = await bridge.start();
  await bridge.close();
  const second = await bridge.start();
  assert.notEqual(first, second);
  assert.match(first, /^ws:\/\/127\.0\.0\.1:\d+\/v1\/[A-Za-z0-9_-]+$/u);
  assert.match(second, /^ws:\/\/127\.0\.0\.1:\d+\/v1\/[A-Za-z0-9_-]+$/u);
  await bridge.close();
});

test('realtime audio bridge forwards auth and adapts upstream audio over WebSocket', async () => {
  const upstream = await createUpstream();
  const bridge = new RealtimeAudioBridge({ upstreamBaseUrl: upstream.baseUrl });
  let client;
  try {
    const baseUrl = await bridge.start();
    client = await openClient(baseUrl, { Authorization: 'Bearer test-token' });
    assert.equal(client.response.statusCode, 101);
    const reader = new FrameReader();
    const eventFrame = onceFrame(
      client.socket,
      reader,
      frame => frame.opcode === 1
    );
    if (client.head.length) reader.push(client.head);
    client.socket.write(encodeFrame(JSON.stringify({ type: 'client.ping' }), { masked: true }));
    const frame = await eventFrame;
    assert.deepEqual(JSON.parse(frame.payload.toString('utf8')), {
      type: 'output_audio.delta',
      audio: 'AAE='
    });
    assert.equal(upstream.requests[0].authorization, 'Bearer test-token');
    assert.deepEqual(upstream.received(), { type: 'client.ping' });
  } finally {
    client?.socket.destroy();
    await bridge.close();
    upstream.socket()?.destroy();
    await upstream.close();
  }
});

test('realtime audio bridge honors an HTTP CONNECT proxy', async () => {
  const upstream = await createUpstream();
  const proxyRequests = [];
  const proxy = createHttpServer();
  proxy.on('connect', (request, client, head) => {
    proxyRequests.push(request.url);
    const [hostname, portText] = String(request.url).split(':');
    const target = connectTcp({ host: hostname, port: Number(portText) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      client.pipe(target);
      target.pipe(client);
    });
    target.on('error', () => client.destroy());
    client.on('error', () => target.destroy());
  });
  const proxyPort = await listen(proxy);
  const bridge = new RealtimeAudioBridge({
    upstreamBaseUrl: upstream.baseUrl,
    proxyUrl: `http://127.0.0.1:${proxyPort}`
  });
  let client;
  try {
    const baseUrl = await bridge.start();
    client = await openClient(baseUrl);
    const reader = new FrameReader();
    if (client.head.length) reader.push(client.head);
    const eventFrame = onceFrame(client.socket, reader, frame => frame.opcode === 1);
    client.socket.write(encodeFrame(JSON.stringify({ type: 'proxy.ping' }), { masked: true }));
    const frame = await eventFrame;
    assert.equal(JSON.parse(frame.payload.toString('utf8')).type, 'output_audio.delta');
    assert.deepEqual(proxyRequests, [`127.0.0.1:${new URL(upstream.baseUrl).port}`]);
    assert.deepEqual(upstream.received(), { type: 'proxy.ping' });
  } finally {
    client?.socket.destroy();
    await bridge.close();
    upstream.socket()?.destroy();
    await upstream.close();
    await closeServer(proxy);
  }
});
