import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const worker = process.argv[2] ? resolve(process.argv[2]) : null;
const MAX_PAYLOAD = 64 * 1024 * 1024;

if (!worker) {
  throw new Error('usage: node protocol.test.mjs <path-to-ofs-rdp-worker>');
}

function frame(type, requestId, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(16);
  header.write('OFSR', 0, 'ascii');
  header.writeUInt16LE(1, 4);
  header.writeUInt8(type, 6);
  header.writeUInt32LE(data.length, 8);
  header.writeUInt32LE(requestId, 12);
  return Buffer.concat([header, data]);
}

function rawHeader({ magic = 'OFSR', version = 1, type = 0x10, flags = 0, length = 0, requestId = 0 }) {
  const header = Buffer.alloc(16);
  header.write(magic, 0, 'ascii');
  header.writeUInt16LE(version, 4);
  header.writeUInt8(type, 6);
  header.writeUInt8(flags, 7);
  header.writeUInt32LE(length, 8);
  header.writeUInt32LE(requestId, 12);
  return header;
}

function parseFrames(output) {
  const frames = [];
  let offset = 0;
  while (offset < output.length) {
    assert.ok(offset + 16 <= output.length, 'output has a complete OFSR header');
    assert.equal(output.toString('ascii', offset, offset + 4), 'OFSR', 'output magic');
    assert.equal(output.readUInt16LE(offset + 4), 1, 'output protocol version');
    const length = output.readUInt32LE(offset + 8);
    assert.ok(length <= MAX_PAYLOAD, 'output payload is bounded');
    assert.ok(offset + 16 + length <= output.length, 'output has a complete OFSR payload');
    const payload = output.subarray(offset + 16, offset + 16 + length);
    frames.push({
      type: output.readUInt8(offset + 6),
      requestId: output.readUInt32LE(offset + 12),
      payload,
      json: payload.length > 0 && output.readUInt8(offset + 6) !== 0x30 ? JSON.parse(payload.toString('utf8')) : null
    });
    offset += 16 + length;
  }
  return frames;
}

function run(input) {
  const result = spawnSync(worker, [], { input, maxBuffer: MAX_PAYLOAD + 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, frames: parseFrames(result.stdout) };
}

function helloAck(requestId = 1, extra = '') {
  return frame(0x02, requestId, `{"op":"helloAck","protocol":1,"maxPayload":${MAX_PAYLOAD},"sessionId":"test"${extra}}`);
}

function mainStart(requestId = 2, overrides = {}) {
  return frame(0x10, requestId, JSON.stringify({
    op: 'start',
    host: '127.0.0.1',
    port: 3389,
    username: 'alice',
    domain: '',
    gateway: null,
    display: { width: 320, height: 320, dpi: 96 },
    features: { clipboard: true, certificatePolicy: 'prompt' },
    ...overrides
  }));
}

function expectError(result, requestId, code = 'PROTOCOL_ERROR') {
  assert.equal(result.status, 2, 'worker exits after invalid control/protocol input');
  const error = result.frames.at(-1);
  assert.equal(error.type, 0x7f, 'worker emits ERROR');
  assert.equal(error.requestId, requestId, 'error has the trusted request correlation only');
  assert.equal(error.json?.code, code, 'error uses the expected protocol code');
}

function detectWorkerVersion() {
  const result = spawnSync(worker, ['--self-test'], { maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, 'worker self-test exits cleanly');
  const frames = parseFrames(result.stdout);
  assert.equal(frames.length, 1, 'self-test emits one frame');
  assert.equal(frames[0].type, 0x01, 'self-test frame is HELLO');
  return frames[0].json?.workerVersion;
}

function testMainWorkerInteroperability() {
  const input = Buffer.concat([
    helloAck(1),
    mainStart(2),
    frame(0x13, 3, JSON.stringify({ op: 'resize', width: 640, height: 480, dpi: 96 })),
    frame(0x14, 4, JSON.stringify({ op: 'key', scanCode: 30, pressed: true, extended: false, unicode: 97 })),
    frame(0x15, 5, JSON.stringify({ op: 'pointer', x: 20, y: 30, buttons: 1, wheelX: 0, wheelY: 0 })),
    frame(0x16, 6, JSON.stringify({ op: 'clipboardSet', mime: 'text/plain', text: 'main-to-worker' })),
    frame(0x17, 7, JSON.stringify({ op: 'clipboardGet', requestId: 7 })),
    frame(0x12, 8, JSON.stringify({ op: 'close', reason: 'user' }))
  ]);
  const result = run(input);
  assert.equal(result.status, 0, 'normal session exits cleanly');
  assert.equal(result.frames[0].type, 0x01, 'worker starts with HELLO');
  assert.deepEqual(result.frames.slice(1, 4).map((entry) => entry.type), [0x20, 0x30, 0x20], 'first frame precedes ready');
  assert.deepEqual(
    result.frames.slice(1).filter((entry) => entry.type === 0x20 && entry.json?.op === 'state').map((entry) => entry.json.state),
    ['connecting', 'ready', 'closed']
  );
  const image = result.frames.find((entry) => entry.type === 0x30);
  assert.equal(image.payload.readUInt32LE(0), 320, 'mock frame width');
  assert.equal(image.payload.readUInt32LE(4), 320, 'mock frame height');
  assert.ok(result.frames.some((entry) => entry.type === 0x30 && entry.payload.readUInt32LE(0) === 640), 'main resize produces the requested frame');
  assert.ok(result.frames.some((entry) => entry.type === 0x22 && entry.requestId === 7), 'clipboard request correlation is preserved');
}

function testKeyUnicodeScalarValidation() {
  const invalidKeys = [
    { op: 'key', scanCode: 30, pressed: true, unicode: 0xd800 },
    { op: 'key', scanCode: 30, pressed: true, unicode: 0x110000 },
    { op: 'key', scanCode: 30, pressed: true, unicode: '97' },
    { op: 'key', scanCode: 30, pressed: true, extra: false },
    '{"op":"key","scanCode":30,"pressed":true,"scanCode":31}',
    '{"op":"key","scanCode":30,"pressed":true,"unicode":999999999999999999999999999999}'
  ];
  for (const [index, key] of invalidKeys.entries()) {
    const payload = typeof key === 'string' ? key : JSON.stringify(key);
    expectError(run(Buffer.concat([
      helloAck(1),
      mainStart(2),
      frame(0x14, 10 + index, payload)
    ])), 10 + index);
  }
}

function testFreeRdpStartWaitsForCredentialWithoutMockFrame() {
  const input = Buffer.concat([
    helloAck(1),
    mainStart(2),
    frame(0x12, 3, JSON.stringify({ op: 'close', reason: 'user' }))
  ]);
  const result = run(input);
  assert.equal(result.status, 0, 'FreeRDP session can be closed before credentials are supplied');
  assert.equal(result.frames[0].type, 0x01, 'worker starts with HELLO');
  assert.equal(result.frames[0].json.workerVersion, 'freerdp', 'worker advertises the FreeRDP backend');
  assert.ok(result.frames[0].json.capabilities.includes('freerdp'), 'FreeRDP capability is present');
  assert.equal(result.frames[0].json.capabilities.includes('mock'), false, 'mock capability is absent');
  assert.equal(result.frames.some((entry) => entry.type === 0x30), false, 'FreeRDP build never emits a mock framebuffer before authentication');
  assert.deepEqual(
    result.frames.filter((entry) => entry.type === 0x20 && entry.json?.op === 'state').map((entry) => entry.json.state),
    ['connecting', 'closed']
  );
}

function testStartUsesFrozenNestedDisplay() {
  const legacyFlat = frame(0x10, 2, JSON.stringify({
    op: 'start', host: '127.0.0.1', port: 3389, username: 'alice', domain: '', gateway: null,
    width: 320, height: 320, dpi: 96, features: { clipboard: true, certificatePolicy: 'prompt' }
  }));
  expectError(run(Buffer.concat([helloAck(1), legacyFlat])), 2);

  const nestedWithLegacyFields = mainStart(3, { width: 320, height: 320, dpi: 96 });
  expectError(run(Buffer.concat([helloAck(1), nestedWithLegacyFields])), 3);

  expectError(run(Buffer.concat([helloAck(1), mainStart(4, { gateway: 'rdp-gateway.example' })])), 4, 'UNSUPPORTED');

  expectError(run(Buffer.concat([helloAck(1), mainStart(5, { features: { clipboard: true } })])), 5);
  expectError(run(Buffer.concat([helloAck(1), mainStart(6, { features: { clipboard: true, certificatePolicy: 'trust-all' } })])), 6);
  const strict = run(Buffer.concat([
    helloAck(1),
    mainStart(7, { features: { clipboard: true, certificatePolicy: 'strict' } }),
    frame(0x12, 8, JSON.stringify({ op: 'close', reason: 'user' }))
  ]));
  assert.equal(strict.status, 0, 'strict certificate policy is accepted as a frozen START feature');
}

function testUnsolicitedCertificateResponsesAreNotAcknowledged() {
  const responses = [
    frame(0x11, 41, JSON.stringify({ op: 'certificate', requestId: 41, accept: true })),
    frame(0x11, 41, JSON.stringify({ op: 'certificate', requestId: 41, accept: true })),
    frame(0x11, 42, JSON.stringify({ op: 'certificate', requestId: 99, accept: true })),
    frame(0x11, 0, JSON.stringify({ op: 'certificate', requestId: 0, accept: true }))
  ];
  const result = run(Buffer.concat([helloAck(1), mainStart(2), ...responses, frame(0x12, 43, JSON.stringify({ op: 'close', reason: 'user' }))]));
  assert.equal(result.status, 0, 'unsolicited, mismatched, and zero-id certificate responses are dropped');
  const acknowledgements = result.frames.filter((entry) => entry.type === 0x20 && entry.json?.op === 'ack');
  assert.equal(acknowledgements.some((entry) => [0, 41, 42].includes(entry.requestId)), false, 'certificate response without a pending prompt is never ACKed');
}

function testStrictJson() {
  expectError(run(helloAck(7, ',')), 7);
  expectError(run(frame(0x02, 8, `{"op":"helloAck","op":"wrong","protocol":1,"maxPayload":${MAX_PAYLOAD},"sessionId":"test"}`)), 8);
  expectError(run(frame(0x02, 9, `{"note":"\\\"op\\\":\\\"helloAck\\\"","protocol":1,"maxPayload":${MAX_PAYLOAD},"sessionId":"test"}`)), 9);
  expectError(run(frame(0x02, 10, `{"op":"helloAck","protocol":[1],"maxPayload":${MAX_PAYLOAD},"sessionId":"test"}`)), 10);
}

function testContractPixelCeilingUsesDirtyRectWhenFullFrameWouldExceedPayload() {
  const input = Buffer.concat([
    helloAck(1),
    mainStart(2, { display: { width: 4096, height: 4096, dpi: 96 } }),
    frame(0x12, 3, JSON.stringify({ op: 'close', reason: 'user' }))
  ]);
  const result = run(input);
  assert.equal(result.status, 0, 'contract maximum canvas exits cleanly');
  const image = result.frames.find((entry) => entry.type === 0x30);
  assert.equal(image.payload.readUInt32LE(0), 4096, 'canvas width follows the accepted display');
  assert.equal(image.payload.readUInt32LE(4), 4096, 'canvas height follows the accepted display');
  assert.equal(image.payload.readUInt16LE(12), 1, 'mock sends one dirty rectangle');
  assert.equal(image.payload.readUInt32LE(24), 1, 'dirty rectangle width is bounded');
  assert.equal(image.payload.readUInt32LE(28), 1, 'dirty rectangle height is bounded');
  assert.equal(image.payload.readUInt32LE(36), 4, 'dirty rectangle bytes stay under the frame limit');
}

function testDisplayAboveContractPixelCeilingIsRejected() {
  const input = Buffer.concat([
    helloAck(1),
    mainStart(2, { display: { width: 4096, height: 4097, dpi: 96 } })
  ]);
  const result = run(input);
  expectError(result, 2, 'UNSUPPORTED');
  assert.equal(result.frames.some((entry) => entry.type === 0x30), false, 'an oversized display is never announced as ready');
}

function testUntrustedRequestIds() {
  const previousRequest = 0x0badcafe;
  expectError(run(Buffer.concat([helloAck(previousRequest), rawHeader({ magic: 'BADS', requestId: 0xfeedface })])), 0);
  const truncatedPayload = rawHeader({ type: 0x10, length: 12, requestId: 0xfeedface }).subarray(0, 16);
  expectError(run(Buffer.concat([helloAck(previousRequest), truncatedPayload, Buffer.from('{"op"', 'utf8')])), 0);
}

const workerVersion = detectWorkerVersion();
if (workerVersion === 'mock') {
  testMainWorkerInteroperability();
  testKeyUnicodeScalarValidation();
}
else if (workerVersion === 'freerdp') testFreeRdpStartWaitsForCredentialWithoutMockFrame();
else assert.fail(`unexpected worker backend ${workerVersion}`);
testStartUsesFrozenNestedDisplay();
testUnsolicitedCertificateResponsesAreNotAcknowledged();
testStrictJson();
if (workerVersion === 'mock') testContractPixelCeilingUsesDirtyRectWhenFullFrameWouldExceedPayload();
testDisplayAboveContractPixelCeilingIsRejected();
testUntrustedRequestIds();
process.stdout.write('rdp-worker protocol tests passed\n');
