import test from 'node:test';
import assert from 'node:assert/strict';
import { readJsonResponse } from './apiResponse.js';

test('Vercel text 404 produces a clear deployment error', async () => {
  const response = new Response('The page could not be found', { status: 404, headers: { 'content-type': 'text/plain' } });
  await assert.rejects(readJsonResponse(response, 'Viewer configuration'), /HTTP 404 instead of JSON/);
});

test('JSON backend errors remain actionable', async () => {
  await assert.rejects(readJsonResponse(Response.json({ error: 'Set MATTER_PORT_SDK_KEY' }, { status: 503 })), /Set MATTER_PORT_SDK_KEY/);
});

test('successful and malformed JSON responses are distinguished', async () => {
  assert.deepEqual(await readJsonResponse(Response.json({ ok: true })), { ok: true });
  await assert.rejects(readJsonResponse(new Response('{broken', { headers: { 'content-type': 'application/json' } })), /invalid JSON/);
});
