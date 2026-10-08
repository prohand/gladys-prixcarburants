// The shared HTTP helper of the open data providers: one retry on what a retry
// can fix, a short `Retry-After`, and no coordinates in the logs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETRY_WAIT_MS,
  MAX_RETRY_WAIT_MS,
  fetchJson,
  redactUrl,
  retryAfterMs,
  setRetrySleep,
} from '../src/http.js';

/** @type {number[]} */
let waits = [];

beforeEach(() => {
  waits = [];
  setRetrySleep(async (ms) => {
    waits.push(ms);
  });
});

afterEach(() => setRetrySleep());

const quietLogger = () => {
  const lines = [];
  return { lines, debug: (line) => lines.push(line), warn: () => {}, info: () => {} };
};

/** Scripted answers, one per call, the last one repeated. */
function script(t, answers) {
  let call = 0;
  const calls = () => call;
  t.mock.method(globalThis, 'fetch', async () => {
    const answer = answers[Math.min(call++, answers.length - 1)];
    if (answer instanceof Error) {
      throw answer;
    }
    if (answer.status) {
      const headers = new Headers(answer.headers ?? {});
      return { ok: false, status: answer.status, statusText: 'Nope', headers };
    }
    return { ok: true, status: 200, json: async () => answer.body };
  });
  return calls;
}

test('a 5xx is retried once and the second answer wins', async (t) => {
  const calls = script(t, [{ status: 502 }, { body: { results: [1] } }]);
  const body = await fetchJson('https://example.test/x', {
    timeoutMs: 1000,
    logger: quietLogger(),
  });
  assert.deepEqual(body, { results: [1] });
  assert.equal(calls(), 2);
  assert.deepEqual(waits, [DEFAULT_RETRY_WAIT_MS]);
});

test('a 429 waits for Retry-After, capped short for the widget deadline', async (t) => {
  script(t, [{ status: 429, headers: { 'retry-after': '2' } }, { body: {} }]);
  await fetchJson('https://example.test/x', { timeoutMs: 1000, logger: quietLogger() });
  assert.deepEqual(waits, [2000]);

  waits = [];
  t.mock.restoreAll();
  script(t, [{ status: 429, headers: { 'retry-after': '120' } }, { body: {} }]);
  await fetchJson('https://example.test/x', { timeoutMs: 1000, logger: quietLogger() });
  assert.deepEqual(waits, [MAX_RETRY_WAIT_MS], 'a server asking for minutes gets 5 s at most');
});

test('the retry happens once, never more, and the error carries the status', async (t) => {
  const calls = script(t, [{ status: 503 }]);
  await assert.rejects(
    fetchJson('https://example.test/x', {
      timeoutMs: 1000,
      label: 'prix-carburants API',
      logger: quietLogger(),
    }),
    (err) => err.status === 503 && /^prix-carburants API HTTP 503/.test(err.message),
  );
  assert.equal(calls(), 2);
});

test('a 4xx is not retried: asking the same wrong question again changes nothing', async (t) => {
  const calls = script(t, [{ status: 400 }, { body: {} }]);
  await assert.rejects(
    fetchJson('https://example.test/x', { timeoutMs: 1000, logger: quietLogger() }),
  );
  assert.equal(calls(), 1);
  assert.deepEqual(waits, []);
});

test('a network error is retried once, a timeout is not', async (t) => {
  const calls = script(t, [new TypeError('fetch failed'), { body: { ok: 1 } }]);
  assert.deepEqual(
    await fetchJson('https://example.test/x', { timeoutMs: 1000, logger: quietLogger() }),
    { ok: 1 },
  );
  assert.equal(calls(), 2);

  t.mock.restoreAll();
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const timeoutCalls = script(t, [timeout, { body: {} }]);
  await assert.rejects(
    fetchJson('https://example.test/x', { timeoutMs: 1000, logger: quietLogger() }),
  );
  assert.equal(timeoutCalls(), 1, 'a second full timeout would kill a widget pull');
});

test('the logged URL never carries the coordinates of the search circle', async (t) => {
  script(t, [{ body: {} }]);
  const url = new URL('https://example.test/records');
  url.searchParams.set('where', "within_distance(geom, geom'POINT(-1.68450 48.11130)', 5km)");
  const logger = quietLogger();

  await fetchJson(url, { timeoutMs: 1000, logger });

  assert.equal(logger.lines.length, 1);
  assert.ok(!logger.lines[0].includes('48.111'), logger.lines[0]);
  assert.ok(!logger.lines[0].includes('1.684'), logger.lines[0]);
  assert.match(logger.lines[0], /POINT\(…\)/);
  assert.match(logger.lines[0], /5km/, 'the rest of the query stays readable');
});

test('redactUrl and retryAfterMs read what servers actually send', () => {
  assert.equal(redactUrl('x?w=POINT(2.3 48.8)+and+POINT( 1 2 )'), 'x?w=POINT(…) and POINT(…)');
  const headers = (value) => ({ headers: new Headers(value ? { 'retry-after': value } : {}) });
  assert.equal(retryAfterMs(headers('1')), 1000);
  assert.equal(retryAfterMs(headers(null)), null);
  assert.equal(retryAfterMs(headers('soon')), null);
  assert.equal(retryAfterMs({}), null, 'a response without headers (the test mocks) is fine');
  const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
  assert.ok(retryAfterMs(headers(inTwoSeconds)) <= 2000);
});
