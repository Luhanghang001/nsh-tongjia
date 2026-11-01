const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePrices, captureForCurrentSelection } = require('../scripts/collect');

function price(overrides = {}) {
  return { bucketTimestamp: Date.now() - 3600000, bucketStr: '2026-11-01 11', rmbPerAmount: 5, tradingVolume: 10, ...overrides };
}

test('接受有效价格和真实的零成交量', () => {
  validatePrices([price(), price({ tradingVolume: 0 })]);
});

test('空数据单独标记，不伪造零价或成功', () => {
  assert.throws(() => validatePrices([]), { code: 'NO_DATA' });
  assert.throws(() => validatePrices(undefined));
});

test('拒绝异常价格、缺失成交量和过期数据', () => {
  for (const overrides of [
    { rmbPerAmount: null }, { rmbPerAmount: '' }, { rmbPerAmount: 'bad' },
    { tradingVolume: undefined }, { tradingVolume: -1 }, { bucketStr: 'bad' },
    { bucketTimestamp: Date.now() - 7 * 3600000 },
  ]) assert.throws(() => validatePrices([price(overrides)]));
});

test('滑块未通过时只尝试一次并明确失败', async () => {
  let drags = 0;
  const page = {
    locator: () => ({
      isVisible: async () => true,
      boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 40 }),
      waitFor: async () => { throw new Error('still visible'); },
    }),
    mouse: { move: async () => {}, down: async () => { drags++; }, up: async () => {} },
    waitForTimeout: async () => {},
  };
  await assert.rejects(captureForCurrentSelection(page, new Map(), '324996'), { code: 'HUMAN_VERIFICATION_REQUIRED' });
  assert.equal(drags, 1);
});

test('价格响应按 specId 匹配，空响应不会当成成功', async () => {
  const page = { locator: () => ({ isVisible: async () => false }) };
  const rows = [price()];
  assert.deepEqual(await captureForCurrentSelection(page, new Map([['324996', { code: '0', data: { prices: rows } }]]), '324996'), rows);
  await assert.rejects(captureForCurrentSelection(page, new Map([['324999', { code: '0', data: { prices: [] } }]]), '324999'), { code: 'NO_DATA' });
});
