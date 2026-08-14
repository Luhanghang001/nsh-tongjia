// 采集逆水寒(黄金畅玩服铜币) 各服铜价逐时数据
// 数据来源: qiandao.com 前端页面网络请求 get-price-line (需要浏览器环境, 因为请求带签名)
// 输出: data/tongjia.csv (server, spec_id, bucket_timestamp, bucket_str, rmb_per_wan, trading_volume, fetched_at)

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PAGE_URL =
  'https://qiandao.com/currency/currency-zone?catalogName=%E9%80%86%E6%B0%B4%E5%AF%92%E4%B8%93%E5%8C%BA&tagIds=[1883484]&attributeId=904221228984762040&entryId=1883484&entryType=TAG';

// 服务器名 -> specId 映射 (来自 get-cascade-attribute 接口)
const SERVERS = [
  { name: '三清山', specId: '324996' },
  { name: '云樱岛', specId: '324997' },
  { name: '桃花坞', specId: '324998' },
  { name: '水帘洞', specId: '3211946' },
  { name: '白帝城', specId: '324999' },
  { name: '花果山', specId: '3146578' },
];

const CSV_PATH = path.join(__dirname, '..', 'data', 'tongjia.csv');
const CSV_HEADER = 'server,spec_id,bucket_timestamp,bucket_str,rmb_per_wan,trading_volume,fetched_at\n';

function loadExisting() {
  const map = new Map(); // key: server|bucket_str -> row fields
  if (!fs.existsSync(CSV_PATH)) return map;
  const lines = fs.readFileSync(CSV_PATH, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('server,')) continue; // header
    const [server, specId, bucketTimestamp, bucketStr, rmbPerWan, tradingVolume, fetchedAt] = line.split(',');
    map.set(`${server}|${bucketStr}`, { server, specId, bucketTimestamp, bucketStr, rmbPerWan, tradingVolume, fetchedAt });
  }
  return map;
}

function saveAll(map) {
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
  const rows = Array.from(map.values()).sort((a, b) => {
    if (a.server !== b.server) return a.server.localeCompare(b.server);
    return Number(a.bucketTimestamp) - Number(b.bucketTimestamp);
  });
  const body = rows
    .map((r) => `${r.server},${r.specId},${r.bucketTimestamp},${r.bucketStr},${r.rmbPerWan},${r.tradingVolume},${r.fetchedAt}`)
    .join('\n');
  fs.writeFileSync(CSV_PATH, CSV_HEADER + body + (body ? '\n' : ''));
}

async function captureForCurrentSelection(page, specId, timeoutMs = 45000) {
  const resp = await page.waitForResponse(
    (r) => {
      if (!r.url().includes('/c2c-web/v1/common/get-price-line')) return false;
      try {
        const body = JSON.parse(r.request().postData() || '{}');
        return Array.isArray(body.specIds) && body.specIds[0] === specId;
      } catch (e) {
        return false;
      }
    },
    { timeout: timeoutMs }
  );
  const json = await resp.json();
  if (json.code !== '0') throw new Error(`get-price-line 返回错误: ${json.message}`);
  return json.data.prices || [];
}

async function selectServer(page, serverName) {
  await page.locator('.n-base-selection-input').first().click();
  await page.locator('.n-cascader-option__label', { hasText: serverName }).first().click();
}

async function saveDebug(page, tag) {
  try {
    const dir = path.join(__dirname, '..', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${tag}.png`), fullPage: true });
    fs.writeFileSync(path.join(dir, `${tag}.html`), await page.content());
    console.error(`[DEBUG] 已保存 debug/${tag}.png 和 debug/${tag}.html`);
  } catch (e) {
    console.error(`[DEBUG] 保存调试信息失败: ${e.message}`);
  }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  page.on('console', (msg) => console.log(`[浏览器控制台] ${msg.type()}: ${msg.text()}`));
  page.on('requestfailed', (req) => console.log(`[请求失败] ${req.url()} ${req.failure()?.errorText}`));

  const fetchedAt = new Date().toISOString();
  const existing = loadExisting();
  let ok = 0;
  let fail = 0;

  try {
    page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.error(`[goto失败] ${e.message}`));

    // 首次加载页面时默认选中第一个服务器(三清山), 会自动触发一次 get-price-line
    const firstServer = SERVERS[0];
    try {
      const prices = await captureForCurrentSelection(page, firstServer.specId);
      mergePrices(existing, firstServer, prices, fetchedAt);
      ok++;
      console.log(`[OK] ${firstServer.name} (默认选中) 采集到 ${prices.length} 条`);
    } catch (e) {
      fail++;
      console.error(`[FAIL] ${firstServer.name}: ${e.message}`);
      await saveDebug(page, 'first-load-failed');
    }

    for (const server of SERVERS.slice(1)) {
      try {
        const [prices2] = await Promise.all([
          captureForCurrentSelection(page, server.specId),
          selectServer(page, server.name),
        ]);
        mergePrices(existing, server, prices2, fetchedAt);
        ok++;
        console.log(`[OK] ${server.name} 采集到 ${prices2.length} 条`);
      } catch (e) {
        fail++;
        console.error(`[FAIL] ${server.name}: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  saveAll(existing);
  console.log(`完成. 成功 ${ok} 个服务器, 失败 ${fail} 个. 数据已写入 ${CSV_PATH}`);

  if (fail === SERVERS.length) {
    process.exitCode = 1; // 全部失败才算任务失败, 部分失败不影响其它数据落地
  }
})();

function mergePrices(map, server, prices, fetchedAt) {
  for (const p of prices) {
    map.set(`${server.name}|${p.bucketStr}`, {
      server: server.name,
      specId: server.specId,
      bucketTimestamp: p.bucketTimestamp,
      bucketStr: p.bucketStr,
      rmbPerWan: p.rmbPerAmount,
      tradingVolume: p.tradingVolume,
      fetchedAt,
    });
  }
}
