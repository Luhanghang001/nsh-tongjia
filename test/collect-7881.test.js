const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, beijingHour, depthPrice } = require('../scripts/collect-7881');

const g = (o = {}) => ({ groupId: 'G6065P002', serverId: 'G6065P002001', serverName: '三清山', unit: '万铜钱', priceOfUnit: '4.6', pernum: 100, stock: 1, ...o });

test('买满 1000 万铜均价：从最便宜的挂单买起，小额低价单只占小权重', () => {
  assert.equal(depthPrice([{ unit: 4.0, wan: 10 }, { unit: 4.6, wan: 2000 }]), (4.0 * 10 + 4.6 * 990) / 1000);
  assert.equal(depthPrice([{ unit: 5, wan: 100 }, { unit: 6, wan: 100 }]), 5.5); // 不足 1000 万铜用全部
});

test('按服汇总，昆仑墟改名为昆仑虚，异常挂单跳过', () => {
  const { rows, skipped } = summarize([
    g(), g({ priceOfUnit: '4.4', pernum: 50, stock: 2 }),
    g({ serverName: '昆仑墟', serverId: 'G6065P002008' }),
    g({ priceOfUnit: '0' }), g({ priceOfUnit: '999' }), g({ unit: '金' }), g({ groupId: 'X' }), g({ stock: 0 }),
  ]);
  assert.equal(skipped, 5);
  const sq = rows.find((r) => r.server === '三清山');
  assert.equal(sq.listings, 2);
  assert.equal(sq.stockWan, 200);
  assert.equal(sq.minPrice, 4.4);
  assert.equal(sq.price, 4.5);
  assert.ok(rows.find((r) => r.server === '昆仑虚'));
});

test('小时桶按北京时间', () => {
  const { bucketStr, bucketTimestamp } = beijingHour(new Date('2026-11-20T05:59:00Z'));
  assert.equal(bucketStr, '2026-11-20 13');
  assert.equal(bucketTimestamp, Date.parse('2026-11-20T13:00:00+08:00'));
});
