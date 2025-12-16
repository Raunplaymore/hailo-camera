#!/usr/bin/env node
/*
 * Simple smoke test for the camera capture server.
 * Requires the server to be running locally and a connected rpicam/libcamera-compatible camera.
 */

const baseUrl = process.env.SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const authToken = process.env.SMOKE_TOKEN || process.env.AUTH_TOKEN || '';

async function main() {
  console.log(`Using server: ${baseUrl}`);
  try {
    await statusCheck();
    await captureOnce('jpg');
    await captureOnce('mp4');
    await busyCheck();
  } catch (err) {
    console.error('Smoke test failed:', err.message);
    process.exit(1);
  }
}

async function statusCheck() {
  const res = await getJson('/api/camera/status');
  console.log('Status:', res);
  if (!res.ok) throw new Error('Status endpoint returned not ok');
}

async function captureOnce(format) {
  const payload = {
    format,
    width: 640,
    height: 480,
    fps: format === 'jpg' ? undefined : 15,
    durationSec: 1,
  };
  const res = await postJson('/api/camera/capture', payload);
  console.log(`${format} capture response:`, res);
  if (!res.ok) throw new Error(`${format} capture failed: ${res.error || 'unknown error'}`);
}

async function busyCheck() {
  console.log('Starting busy-state check...');
  const longCapture = postJson('/api/camera/capture', {
    format: 'jpg',
    width: 320,
    height: 240,
    durationSec: 4,
  });

  // Fire a quick request while the long capture is running to provoke 409.
  await sleep(200);
  const quick = await postJson('/api/camera/capture', {
    format: 'jpg',
    width: 320,
    height: 240,
    durationSec: 1,
  });

  const first = await longCapture.catch((err) => ({ ok: false, error: err.message }));
  console.log('Long capture:', first);
  console.log('Quick capture (should be 409 busy):', quick);
  if (quick && quick.ok) {
    console.warn('Busy check did not return an error; ensure lock handling is working as expected.');
  }
}

async function getJson(path) {
  const res = await fetchWithAuth('GET', path);
  return res.data;
}

async function postJson(path, body) {
  const res = await fetchWithAuth('POST', path, body);
  if (res.status === 204) return { ok: true };
  return res.data;
}

async function fetchWithAuth(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(data.error || `Request failed with status ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return { status: response.status, data };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
