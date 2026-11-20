// 采集逆水寒黄金畅玩服各服铜价：7881 游戏币挂单
// 数据来源：search.7881.com 列表页自己发出的 goods-service-api/api/goods/list 接口（请求带 lb-sign 签名，
// 所以用浏览器打开列表页并截获返回，不直接拼 HTTP 请求）。
// 2026-11-20 起替代千岛（千岛频繁出滑块）。千岛脚本 collect.js 保留，可手动运行。
//
// 口径：7881 只有卖家挂单，没有成交记录。
//   rmb_per_wan     = 在该服从最便宜的挂单买起，买满 1000 万铜的平均单价（元/万铜）；该服挂单不足 1000 万铜时用全部挂单
//   trading_volume  = 该服全部挂单的铜钱总量（万铜 = 每件数量 × 库存）。这是挂单量，不是成交量
//   bucket_str      = 采集时刻所在的北京时间小时；同一小时多次采集，后一次覆盖前一次
// 明细另存 data/tongjia-7881.csv（最低价、买满 1000 万铜均价、挂单数、挂单量）。

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HEADED = process.argv.includes('--headed');
const GROUP_ID = 'G6065P002'; // 黄金畅玩服
const listUrl = (n) => `https://search.7881.com/G6065-100001-${GROUP_ID}-0-0.html?pageNum=${n}`;
const API_PART = '/goods-service-api/api/goods/list';
const MAX_PAGES = 40;
const DEPTH_WAN = 1000; // 买满多少万铜的均价
const UNIT_MIN = 0.5; // 元/万铜，超出范围的挂单视为异常，不参与计算
const UNIT_MAX = 50;
const NO_GOODS = 170001; // 越过末页时接口返回“未查询到有效的商品”

// 7881 服名 → 本仓库沿用的服名（日报按服名对应市场）
const NAME_FIX = { 昆仑墟: '昆仑虚' };

const DATA_DIR = path.join(__dirname, '..', 'data');
const CSV_PATH = path.join(DATA_DIR, 'tongjia.csv');
const CSV_HEADER = 'server,spec_id,bucket_timestamp,bucket_str,rmb_per_wan,trading_volume,fetched_at\n';
const DETAIL_PATH = path.join(DATA_DIR, 'tongjia-7881.csv');
const DETAIL_HEADER = 'server,server_id,bucket_str,min_price,price_1000wan,listings,stock_wan,fetched_at\n';

function beijingHour(date) {
  const bj = new Date(date.getTime() + 8 * 3600000);
  const bucketStr = bj.toISOString().slice(0, 13).replace('T', ' ');
  const bucketTimestamp = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), bj.getUTCHours()) - 8 * 3600000;
  return { bucketStr, bucketTimestamp };
}

// 从最便宜的挂单买起，买满 depth 万铜的平均单价
function depthPrice(items, depth = DEPTH_WAN) {
  const sorted = [...items].sort((a, b) => a.unit - b.unit);
  let got = 0;
  let amt = 0;
  for (const it of sorted) {
    if (got >= depth) break;
    const take = Math.min(it.wan, depth - got);
    got += take;
    amt += take * it.unit;
  }
  return got ? amt / got : null;
}

const round4 = (x) => Math.round(x * 10000) / 10000;

// 把挂单列表汇总成每服一行。纯函数，便于测试。
function summarize(listings) {
  const byServer = new Map();
  let skipped = 0;
  for (const g of listings) {
    const unit = Number(g.priceOfUnit);
    const per = Number(g.pernum);
    const stock = Number(g.stock);
    if (g.groupId !== GROUP_ID || g.unit !== '万铜钱' || !g.serverName
      || !Number.isFinite(unit) || unit < UNIT_MIN || unit > UNIT_MAX
      || !Number.isFinite(per) || per <= 0 || !Number.isFinite(stock) || stock <= 0) { skipped++; continue; }
    const name = NAME_FIX[g.serverName] || g.serverName;
    if (!byServer.has(name)) byServer.set(name, { server: name, serverId: g.serverId, items: [] });
    byServer.get(name).items.push({ unit, wan: per * stock });
  }
  const rows = [...byServer.values()].map((s) => ({
    server: s.server,
    serverId: s.serverId,
    minPrice: round4(Math.min(...s.items.map((x) => x.unit))),
    price: round4(depthPrice(s.items)),
    listings: s.items.length,
    stockWan: Math.round(s.items.reduce((t, x) => t + x.wan, 0) * 100) / 100,
  }));
  return { rows, skipped };
}

function readCsv(file, header, keyOf) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line || line === header.trim()) continue;
    map.set(keyOf(line.split(',')), line);
  }
  return map;
}

function writeCsv(file, header, map, sortKey) {
  const lines = [...map.values()].sort((a, b) => {
    const [ka, kb] = [sortKey(a.split(',')), sortKey(b.split(','))];
    return ka[0] !== kb[0] ? ka[0].localeCompare(kb[0], 'en') : ka[1] - kb[1];
  });
  fs.writeFileSync(file, header + lines.join('\n') + (lines.length ? '\n' : ''));
}

async function fetchAllListings(page) {
  const pages = new Map(); // pageNum -> body
  let failure = null;
  page.on('response', async (resp) => {
    if (!resp.url().includes(API_PART)) return;
    try {
      const req = JSON.parse(resp.request().postData() || '{}');
      if (req.groupId !== GROUP_ID || req.marketRequestSource !== 'search') return;
      const json = await resp.json();
      if (json.code === NO_GOODS) { pages.set(Number(req.pageNum), { results: [], pages: 0 }); return; }
      if (json.code !== 0 || !json.body) throw new Error(`列表接口返回错误：code=${json.code} ${json.msg || json.message || ''}`);
      pages.set(Number(req.pageNum), json.body);
    } catch (e) {
      failure = e;
    }
  });

  const load = async (n) => {
    pages.delete(n);
    const nav = await page.goto(listUrl(n), { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (nav && nav.status() >= 400) throw new Error(`列表页第 ${n} 页 HTTP ${nav.status()}`);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (pages.has(n)) return pages.get(n);
      await page.waitForTimeout(200);
    }
    throw new Error(`等待列表第 ${n} 页数据超时（页面可能出现了验证或改版）`);
  };

  const first = await load(1);
  const total = Math.min(Number(first.pages) || 1, MAX_PAGES);
  const all = [...(first.results || [])];
  for (let n = 2; n <= total; n++) {
    await page.waitForTimeout(800 + Math.random() * 700);
    const body = await load(n);
    if (!body.results || !body.results.length) break; // 翻页途中挂单变少，提前到末页
    all.push(...body.results);
  }
  const ids = new Set();
  const dedup = all.filter((g) => (ids.has(g.goodsId) ? false : ids.add(g.goodsId)));
  return { listings: dedup, records: Number(first.records), pages: total };
}

async function main() {
  const fetched = new Date();
  const fetchedAt = fetched.toISOString();
  const { bucketStr, bucketTimestamp } = beijingHour(fetched);
  let status = { source: '7881', fetchedAt, bucketStr, ok: 0, failed: 0, noData: 0, servers: [] };
  let exit = 0;

  const browser = await chromium.launch({ headless: !HEADED, channel: 'chromium' });
  try {
    const page = await browser.newPage({ locale: 'zh-CN' });
    const { listings, records, pages } = await fetchAllListings(page);
    console.log(`[7881] 共 ${records} 条挂单，${pages} 页，实取 ${listings.length} 条`);
    const { rows, skipped } = summarize(listings);
    if (!rows.length) {
      const e = new Error('没有取到有效挂单；保留历史数据');
      e.code = 'NO_DATA';
      throw e;
    }

    const main = readCsv(CSV_PATH, CSV_HEADER, (c) => `${c[0]}|${c[3]}`);
    const detail = readCsv(DETAIL_PATH, DETAIL_HEADER, (c) => `${c[0]}|${c[2]}`);
    for (const r of rows) {
      main.set(`${r.server}|${bucketStr}`, [r.server, r.serverId, bucketTimestamp, bucketStr, r.price, r.stockWan, fetchedAt].join(','));
      detail.set(`${r.server}|${bucketStr}`, [r.server, r.serverId, bucketStr, r.minPrice, r.price, r.listings, r.stockWan, fetchedAt].join(','));
      console.log(`[OK] ${r.server}: 买满 ${DEPTH_WAN} 万铜均价 ${r.price} 元/万，最低 ${r.minPrice}，挂单 ${r.listings} 个 / ${r.stockWan} 万铜`);
    }
    writeCsv(CSV_PATH, CSV_HEADER, main, (c) => [c[0], Number(c[2])]);
    writeCsv(DETAIL_PATH, DETAIL_HEADER, detail, (c) => [c[0], Date.parse(c[2].replace(' ', 'T') + ':00:00+08:00')]);
    status = {
      ...status, ok: rows.length, totalListings: listings.length, skippedListings: skipped,
      servers: rows.map((r) => ({ server: r.server, status: 'ok', listings: r.listings, price: r.price, minPrice: r.minPrice, stockWan: r.stockWan })),
    };
    console.log(`完成。${rows.length} 个服有挂单，跳过异常挂单 ${skipped} 个。已写入 ${CSV_PATH}`);
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    status = { ...status, failed: e.code === 'NO_DATA' ? 0 : 1, noData: e.code === 'NO_DATA' ? 1 : 0, error: e.message };
    exit = 1;
  } finally {
    await browser.close();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'status.json'), JSON.stringify(status, null, 2) + '\n');
  }
  process.exitCode = exit;
}

if (require.main === module) main().catch((e) => { console.error(`[ERROR] ${e.message}`); process.exitCode = 1; });
module.exports = { summarize, beijingHour, depthPrice };
