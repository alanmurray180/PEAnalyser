import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAvMessage, av, Budget, FreeKeyError, RateLimitError, PremiumError, avKey } from '../src/providers.js';

test('Alpha Vantage messages are classified correctly', () => {
  const free = 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits.';
  const freeBurst = 'Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day), raise the per-second burst limit, and remove the daily rate limit.';
  const premiumBurst = 'Thank you for using Alpha Vantage! Please contact premium@alphavantage.co if you are targeting a higher API call volume.';
  const premiumEndpoint = 'Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly unlock all premium endpoints';
  const bulkTier = 'The REALTIME_BULK_QUOTES endpoint is available for premium members with 600 requests per minute or above. Please subscribe to a plan at https://www.alphavantage.co/premium/';
  assert.equal(classifyAvMessage(free), 'free-key');
  assert.equal(classifyAvMessage(freeBurst), 'free-key');
  assert.equal(classifyAvMessage(premiumBurst), 'rate');
  assert.equal(classifyAvMessage(premiumEndpoint), 'plan');
  assert.equal(classifyAvMessage(bulkTier), 'plan'); // must NOT be read as a rate limit
  assert.equal(classifyAvMessage('Invalid API call. Please retry or visit the documentation.'), 'invalid');
});

test('key is trimmed and free-key responses raise FreeKeyError', async () => {
  let seen = null;
  globalThis.fetch = async (url) => {
    seen = new URL(url).searchParams.get('apikey');
    return new Response(JSON.stringify({ Information: 'Our standard API rate limit is 25 requests per day.' }));
  };
  const env = { AV_API_KEY: '  ABCD1234\n' };
  assert.equal(avKey(env), 'ABCD1234');
  await assert.rejects(av(env, new Budget(5, 100000), { function: 'EARNINGS', symbol: 'IBM' }), (e) => e instanceof FreeKeyError && e instanceof RateLimitError);
  assert.equal(seen, 'ABCD1234');
  globalThis.fetch = async () => new Response(JSON.stringify({ Information: 'This is a premium endpoint.' }));
  await assert.rejects(av(env, new Budget(5, 100000), { function: 'X' }), (e) => e instanceof PremiumError && !(e instanceof RateLimitError));
});
