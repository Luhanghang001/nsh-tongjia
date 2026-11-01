// 采集逆水寒(黄金畅玩服铜币) 各服铜价逐时数据
// 数据来源: qiandao.com 前端页面网络请求 get-price-line (需要浏览器环境, 因为请求带签名)
// 输出: data/tongjia.csv (server, spec_id, bucket_timestamp, bucket_str, rmb_per_wan, trading_volume, fetched_at)

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const INTERACTIVE = process.argv.includes('--interactive');
const HEADED = INTERACTIVE || process.argv.includes('--headed');
const PROFILE = process.env.TONGJIA_PROFILE;
const WAIT_MS = INTERACTIVE ? 10 * 60 * 1000 : 45000;
const VERIFY_MESSAGE = '千岛要求人工访问验证。请运行 npm run collect:interactive，在打开的浏览器中手动完成验证。';
const attemptedVerification = new WeakSet();

// 2026-10-27 千岛改版，旧的 catalogName/tagIds 入口不再显示区服，改用 islandId 入口
const PAGE_URL = 'https://qiandao.com/currency/currency-zone?islandId=300692';

// 服务器名 -> specId 映射 (来自 get-cascade-attribute 接口)
const SERVERS = [
  { name: '三清山', specId: '324996' },
  { name: '云樱岛', specId: '324997' },
  { name: '桃花坞', specId: '324998' },
  { name: '水帘洞', specId: '3211946' },
  { name: '白帝城', specId: '324999' },
  { name: '花果山', specId: '3146578' },
  { name: '女儿国', specId: '3712269' },
  { name: '昆仑虚', specId: '3865477' }, // 千岛下拉项显示为「昆仑虚（9.25开启）」，按包含匹配可选中
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
    if (a.server !== b.server) return a.server.localeCompare(b.server, 'en');
    return Number(a.bucketTimestamp) - Number(b.bucketTimestamp);
  });
  const body = rows
    .map((r) => `${r.server},${r.specId},${r.bucketTimestamp},${r.bucketStr},${r.rmbPerWan},${r.tradingVolume},${r.fetchedAt}`)
    .join('\n');
  fs.writeFileSync(CSV_PATH, CSV_HEADER + body + (body ? '\n' : ''));
}

function observePrices(page) {
  const responses = new Map();
  page.on('response', async (resp) => {
    if (!resp.url().includes('/c2c-web/v1/common/get-price-line')) return;
    try {
      const body = JSON.parse(resp.request().postData() || '{}');
      const json = await resp.json();
      if (Array.isArray(body.specIds)) responses.set(String(body.specIds[0]), json);
    } catch (_) { /* 验证页不是价格 JSON，交给访问验证检测处理。 */ }
  });
  return responses;
}

async function captureForCurrentSelection(page, responses, specId, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    if (await page.locator('#waf_nc_block').isVisible()) {
      if (!attemptedVerification.has(page)) {
        attemptedVerification.add(page);
        console.log('[验证] 尝试拖动页面滑块一次。');
        await slideVerification(page);
        continue;
      }
      if (!INTERACTIVE) {
        const error = new Error(VERIFY_MESSAGE);
        error.code = 'HUMAN_VERIFICATION_REQUIRED';
        throw error;
      }
      if (!announced) {
        console.error('[需要人工验证] 请在浏览器中完成滑块；程序最多等待 10 分钟。');
        announced = true;
      }
    } else if (responses.has(specId)) {
      const json = responses.get(specId);
      responses.delete(specId);
      if (String(json.code) !== '0') throw new Error(`get-price-line 返回错误: ${json.message}`);
      validatePrices(json.data?.prices);
      return json.data.prices;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`等待服务器 ${specId} 的有效价格响应超时`);
}

async function slideVerification(page) {
  const slider = page.locator('#aliyunCaptcha-sliding-slider');
  const track = page.locator('#aliyunCaptcha-sliding-body');
  const handle = await slider.boundingBox();
  const rail = await track.boundingBox();
  if (!handle || !rail) return;
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(rail.x + rail.width - handle.width / 2, y, { steps: 30 });
  } finally {
    await page.mouse.up();
  }
  await page.locator('#waf_nc_block').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
}

function validatePrices(prices) {
  if (Array.isArray(prices) && prices.length === 0) {
    const error = new Error('接口返回空价格列表；保留历史数据，不标记为采集成功');
    error.code = 'NO_DATA';
    throw error;
  }
  if (!Array.isArray(prices)) throw new Error('价格响应缺少 prices 数组');
  for (const p of prices) {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}$/.test(p.bucketStr)
      || !Number.isFinite(Number(p.bucketTimestamp)) || Number(p.bucketTimestamp) <= 0
      || p.rmbPerAmount === null || p.rmbPerAmount === undefined || p.rmbPerAmount === ''
      || !Number.isFinite(Number(p.rmbPerAmount)) || Number(p.rmbPerAmount) < 0
      || p.tradingVolume === null || p.tradingVolume === undefined || p.tradingVolume === ''
      || !Number.isFinite(Number(p.tradingVolume)) || Number(p.tradingVolume) < 0) {
      throw new Error('价格响应字段异常，拒绝写入 CSV');
    }
  }
  if (Date.now() - Math.max(...prices.map(p => Number(p.bucketTimestamp))) > 6 * 3600000) {
    throw new Error('接口最新价格已超过 6 小时，拒绝标记为采集成功');
  }
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

async function main() {
  // 持久会话只留在本机。人工验证结果不上传到 GitHub。
  const profile = PROFILE || (INTERACTIVE ? path.join(__dirname, '..', '.browser-profile') : null);
  const browser = profile
    ? await chromium.launchPersistentContext(profile, { headless: !HEADED, channel: 'chromium', locale: 'zh-CN' })
    : await chromium.launch({ headless: !HEADED, channel: 'chromium' });
  const page = profile ? await browser.newPage() : await browser.newPage({ locale: 'zh-CN' });
  page.setDefaultTimeout(WAIT_MS);
  page.on('requestfailed', req => {
    const url = new URL(req.url());
    if (url.pathname.includes('/c2c-web/')) console.error(`[请求失败] ${url.pathname} ${req.failure()?.errorText}`);
  });
  const responses = observePrices(page);

  const fetchedAt = new Date().toISOString();
  const existing = loadExisting();
  let ok = 0;
  let fail = 0;
  let noData = 0;
  const results = [];

  try {
    const navigation = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (navigation && navigation.status() >= 400) {
      throw new Error(`页面返回 HTTP ${navigation.status()}，停止本轮采集，不连续重试`);
    }

    // 首次加载页面时默认选中第一个服务器(三清山), 会自动触发一次 get-price-line
    const firstServer = SERVERS[0];
    try {
      const prices = await captureForCurrentSelection(page, responses, firstServer.specId);
      mergePrices(existing, firstServer, prices, fetchedAt);
      ok++;
      results.push({ server: firstServer.name, status: 'ok', count: prices.length, latestBucket: prices.at(-1).bucketStr });
      console.log(`[OK] ${firstServer.name} (默认选中) 采集到 ${prices.length} 条`);
    } catch (e) {
      if (e.code === 'NO_DATA') noData++; else fail++;
      results.push({ server: firstServer.name, status: e.code === 'NO_DATA' ? 'no_data' : 'failed', error: e.message });
      console.error(`[FAIL] ${firstServer.name}: ${e.message}`);
      await saveDebug(page, 'first-load-failed');
      if (e.code === 'HUMAN_VERIFICATION_REQUIRED') throw e;
    }

    for (const server of SERVERS.slice(1)) {
      try {
        await page.waitForTimeout(1000);
        const [prices2] = await Promise.all([
          captureForCurrentSelection(page, responses, server.specId),
          selectServer(page, server.name),
        ]);
        mergePrices(existing, server, prices2, fetchedAt);
        ok++;
        results.push({ server: server.name, status: 'ok', count: prices2.length, latestBucket: prices2.at(-1).bucketStr });
        console.log(`[OK] ${server.name} 采集到 ${prices2.length} 条`);
      } catch (e) {
        if (e.code === 'NO_DATA') noData++; else fail++;
        results.push({ server: server.name, status: e.code === 'NO_DATA' ? 'no_data' : 'failed', error: e.message });
        console.error(`[${e.code === 'NO_DATA' ? 'NO DATA' : 'FAIL'}] ${server.name}: ${e.message}`);
        if (process.env.GITHUB_ACTIONS && e.code === 'NO_DATA') console.log(`::warning::${server.name} 本轮没有价格数据，历史价格不代表现价`);
        if (e.code === 'HUMAN_VERIFICATION_REQUIRED') throw e;
      }
    }
  } finally {
    await browser.close();
    // 包括中途失败：已验证的数据仍保存，并记录未采集的服，避免假成功。
    if (ok > 0) saveAll(existing);
    fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(CSV_PATH), 'status.json'), JSON.stringify({
      fetchedAt, ok, failed: fail, noData,
      servers: SERVERS.map(server => results.find(r => r.server === server.name) || { server: server.name, status: 'not_collected' }),
    }, null, 2) + '\n');
  }

  console.log(`完成. 成功 ${ok} 个服务器, 失败 ${fail} 个, 无数据 ${noData} 个.${ok > 0 ? ` 数据已写入 ${CSV_PATH}` : ' 未修改历史数据。'}`);

  if (fail > 0 || ok === 0) {
    process.exitCode = 1; // 任一服缺数都需要报告失败，成功的服仍落地。
  }
}

if (require.main === module) main().catch(error => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = error.code === 'HUMAN_VERIFICATION_REQUIRED' ? 2 : 1;
});
module.exports = { validatePrices, captureForCurrentSelection, slideVerification };

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
