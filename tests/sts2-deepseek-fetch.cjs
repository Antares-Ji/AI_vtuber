'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDeepseekFetch } = require('../src/sts2/deepseek-fetch');

test('DeepSeek HTTPS keeps credentials on the official TLS origin and does not follow redirects', async () => {
  let calls = 0;
  const send = createDeepseekFetch((url, options, respond) => {
    calls++; assert.equal(url.origin, 'https://api.deepseek.com'); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.headers.authorization, 'Bearer test-only');
    const req = new EventEmitter(); req.setTimeout = () => {}; req.end = body => {
      assert.equal(body, '{}');
      const res = new EventEmitter(); res.statusCode = 302; res.headers = { location: 'https://example.invalid/' };
      respond(res); res.emit('data', Buffer.from('redirect')); res.emit('end');
    }; return req;
  });
  const response = await send('https://api.deepseek.com/chat/completions', { method: 'POST', body: '{}', headers: { authorization: 'Bearer test-only' } });
  assert.equal(response.status, 302); assert.equal(calls, 1);
  await assert.rejects(send('https://example.invalid/chat/completions'), /official/);
  assert.equal(calls, 1);
});

test('a cancelled request sends no API call', async () => {
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(createDeepseekFetch(() => { throw Error('must not send'); })('https://api.deepseek.com/chat/completions', { signal: controller.signal }), /cancelled/);
});
