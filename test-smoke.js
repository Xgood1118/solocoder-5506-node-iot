const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const {
  computeHmac,
  buildCanonicalString,
  buildTelemetryCanonical,
} = require('./src/auth');

const LOG_FILE = 'test-result.txt';
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
const origLog = console.log.bind(console);
console.log = function (...args) {
  origLog(...args);
  logStream.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
};
const origErr = console.error.bind(console);
console.error = function (...args) {
  origErr(...args);
  logStream.write('[ERR] ' + args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
};
process.on('exit', () => logStream.end());

const ADMIN_PWD = process.argv[2] || '9b0aaa98fe97715e942b56c2d4ae99c6';
const BASE = 'http://localhost:3000';

function httpReq({ method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
      timeout: 10000,
    };
    if (bodyStr) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (_e) {
          parsed = data;
        }
        resolve({ statusCode: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function assert(cond, name, info = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    console.log(`  ❌ ${name}  ${info}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('=== Smoke Test IoT Gateway ===\n');

  console.log('[1] /healthz');
  const hz = await httpReq({ method: 'GET', path: '/healthz' });
  assert(hz.statusCode === 200, 'status 200', `got ${hz.statusCode}`);
  assert(hz.body.status === 'ok', 'body.status ok');
  console.log();

  console.log('[2] /admin/meta');
  const meta = await httpReq({ method: 'GET', path: '/admin/meta' });
  assert(meta.statusCode === 200, 'status 200');
  assert(Array.isArray(meta.body.dataTypes), 'dataTypes array');
  assert(Array.isArray(meta.body.deviceModels), 'deviceModels array');
  assert(Array.isArray(meta.body.deviceStatuses), 'deviceStatuses array');
  assert(meta.body.dataTypes.includes('electric_meter'), 'electric_meter dataType present');
  assert(meta.body.deviceModels.includes('electric_meter'), 'electric_meter model present');
  console.log();

  console.log('[3] Admin login');
  const login = await httpReq({
    method: 'POST',
    path: '/admin/login',
    body: { username: 'admin', password: ADMIN_PWD },
  });
  assert(login.statusCode === 200, 'status 200', `got ${login.statusCode}: ${JSON.stringify(login.body)}`);
  const token = login.body?.token;
  assert(!!token, 'token present');
  console.log();

  console.log('[4] Create device (valid 20-char id)');
  const deviceId = 'FFGGHHIIJJ9988776655';
  const createDev = await httpReq({
    method: 'POST',
    path: '/admin/devices',
    headers: { Authorization: `Bearer ${token}` },
    body: { id: deviceId, model: 'temp_humi_sensor', projectId: 'proj-001' },
  });
  assert(createDev.statusCode === 201, 'status 201', `got ${createDev.statusCode}: ${JSON.stringify(createDev.body)}`);
  const presharedKey = createDev.body?.presharedKey;
  console.log('  [DEBUG] createDev:', createDev.statusCode, 'body keys:', Object.keys(createDev.body || {}));
  assert(!!presharedKey, 'presharedKey present');
  assert(createDev.body.model === 'temp_humi_sensor', 'model assigned');
  console.log();

  console.log('[5] Create device with invalid id');
  const badId = await httpReq({
    method: 'POST',
    path: '/admin/devices',
    headers: { Authorization: `Bearer ${token}` },
    body: { id: 'SHORT', model: 'temp_humi_sensor' },
  });
  assert(badId.statusCode === 400, 'status 400 reject', `got ${badId.statusCode}`);
  console.log();

  console.log('[6] Create device with invalid model');
  const badModel = await httpReq({
    method: 'POST',
    path: '/admin/devices',
    headers: { Authorization: `Bearer ${token}` },
    body: { id: 'FFGGHHIIJJ9988776666', model: 'invalid_model_x' },
  });
  assert(badModel.statusCode === 400, 'status 400 reject', `got ${badModel.statusCode}: ${JSON.stringify(badModel.body)}`);
  console.log();

  console.log('[7] Telemetry without HMAC headers (should 401)');
  const noHmac = await httpReq({
    method: 'POST',
    path: '/device/telemetry',
    body: { device_id: deviceId, timestamp: Date.now(), data_type: 'temperature', value: 25.5, signature: 'x' },
  });
  assert(noHmac.statusCode === 401, 'status 401', `got ${noHmac.statusCode}`);
  console.log();

  console.log('[8] Telemetry with bad signature (should 401)');
  const ts = Date.now();
  const nonce = crypto.randomBytes(8).toString('hex');
  const teleBody = {
    device_id: deviceId,
    timestamp: ts,
    data_type: 'temperature',
    value: 25.5,
    extra: { unit: 'C' },
    signature: 'invalid-signature',
  };
  const badSig = await httpReq({
    method: 'POST',
    path: '/device/telemetry',
    headers: {
      'x-device-id': deviceId,
      'x-timestamp': String(ts),
      'x-nonce': nonce,
      'x-signature': 'bad-request-sig',
    },
    body: teleBody,
  });
  assert(badSig.statusCode === 401, 'status 401', `got ${badSig.statusCode}: ${JSON.stringify(badSig.body)}`);
  console.log();

  console.log('[9] Valid telemetry (HMAC + telemetry signature)');
  const ts2 = Date.now();
  const nonce2 = crypto.randomBytes(8).toString('hex');
  const teleBody2 = {
    device_id: deviceId,
    timestamp: ts2,
    data_type: 'temperature',
    value: 26.3,
    extra: { unit: 'C', location: 'room1' },
  };
  const teleSig = computeHmac(presharedKey, buildTelemetryCanonical(teleBody2));
  teleBody2.signature = teleSig;
  const requestCanonical = buildCanonicalString({
    method: 'POST',
    path: '/device/telemetry',
    timestamp: String(ts2),
    nonce: nonce2,
    body: teleBody2,
  });
  const requestSig = computeHmac(presharedKey, requestCanonical);
  const goodTele = await httpReq({
    method: 'POST',
    path: '/device/telemetry',
    headers: {
      'x-device-id': deviceId,
      'x-timestamp': String(ts2),
      'x-nonce': nonce2,
      'x-signature': requestSig,
    },
    body: teleBody2,
  });
  assert(goodTele.statusCode === 200, 'status 200', `got ${goodTele.statusCode}: ${JSON.stringify(goodTele.body)}`);
  assert(goodTele.body?.status === 'accepted', 'status accepted');
  console.log();

  console.log('[10] Idempotent telemetry (same triple, should 200 idempotent=true)');
  const ts3 = ts2 + 1;
  const nonce3 = crypto.randomBytes(8).toString('hex');
  const teleBody3 = {
    device_id: deviceId,
    timestamp: ts2,
    data_type: 'temperature',
    value: 26.3,
    extra: { unit: 'C' },
  };
  teleBody3.signature = computeHmac(presharedKey, buildTelemetryCanonical(teleBody3));
  const reqCanon3 = buildCanonicalString({
    method: 'POST',
    path: '/device/telemetry',
    timestamp: String(ts3),
    nonce: nonce3,
    body: teleBody3,
  });
  const reqSig3 = computeHmac(presharedKey, reqCanon3);
  const idempotent = await httpReq({
    method: 'POST',
    path: '/device/telemetry',
    headers: {
      'x-device-id': deviceId,
      'x-timestamp': String(ts3),
      'x-nonce': nonce3,
      'x-signature': reqSig3,
    },
    body: teleBody3,
  });
  assert(idempotent.statusCode === 200, 'status 200');
  assert(idempotent.body?.idempotent === true, 'idempotent=true', `got ${JSON.stringify(idempotent.body)}`);
  console.log();

  console.log('[11] Valid heartbeat');
  const hbTs = Date.now();
  const hbNonce = crypto.randomBytes(8).toString('hex');
  const hbBody = {};
  const hbCanon = buildCanonicalString({
    method: 'POST',
    path: '/device/heartbeat',
    timestamp: String(hbTs),
    nonce: hbNonce,
    body: hbBody,
  });
  const hbSig = computeHmac(presharedKey, hbCanon);
  const hb = await httpReq({
    method: 'POST',
    path: '/device/heartbeat',
    headers: {
      'x-device-id': deviceId,
      'x-timestamp': String(hbTs),
      'x-nonce': hbNonce,
      'x-signature': hbSig,
    },
    body: hbBody,
  });
  assert(hb.statusCode === 200, 'status 200', `got ${hb.statusCode}: ${JSON.stringify(hb.body)}`);
  assert(hb.body?.status === 'ok', 'status ok');
  assert(typeof hb.body?.heartbeatInterval === 'number', 'heartbeatInterval returned');
  console.log();

  console.log('[12] Device status should be online after heartbeat');
  const devDetail = await httpReq({
    method: 'GET',
    path: `/admin/devices/${deviceId}`,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(devDetail.statusCode === 200, 'status 200');
  assert(devDetail.body?.status === 'online', `status online (got ${devDetail.body?.status})`);
  console.log();

  console.log('[13] Admin health with cleanup stats');
  const adminHealth = await httpReq({
    method: 'GET',
    path: '/admin/health',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(adminHealth.statusCode === 200, 'status 200');
  assert(adminHealth.body.deviceCount >= 1, 'deviceCount present');
  assert(adminHealth.body.cleanup, 'cleanup stats present');
  assert(adminHealth.body.cleanup.nextRunAt != null, 'cleanup.nextRunAt present');
  assert(adminHealth.body.cleanup.intervalMs === 60000, 'cleanup.intervalMs correct');
  console.log();

  console.log('\n=== Done ===');
  if (process.exitCode) {
    console.log('Some tests FAILED');
  } else {
    console.log('All tests PASSED!');
  }
})().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
