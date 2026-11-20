# nsh-tongjia

逆水寒(黄金畅玩服铜币)各服铜价逐时数据采集，通过 GitHub Actions 定时任务在云端跑，本地关机也不影响采集。

## 2026-11-20 起改用 7881

千岛频繁出滑块，定时采集（本机任务和 GitHub Actions）改为抓 7881 黄金畅玩服游戏币列表：
`https://search.7881.com/G6065-100001-G6065P002-0-0.html`，脚本 `scripts/collect-7881.js`，`npm run collect`。
千岛脚本 `scripts/collect.js` 保留，可用 `npm run collect:qiandao` 手动跑。

两边口径不同：

| | 千岛（到 2026-11-20 13 时） | 7881（2026-11-20 14 时起） |
|---|---|---|
| `rmb_per_wan` | 该小时成交均价 | 采集时刻，从该服最便宜的挂单买起、买满 1000 万铜的平均单价 |
| `trading_volume` | 该小时成交量（万铜） | 该服全部挂单的铜钱总量（万铜），是挂单量，不是成交量 |
| `spec_id` | 千岛 specId | 7881 serverId（如 `G6065P002001`） |
| 历史 | 每次返回最近 24 小时，可补采 | 只有当前挂单，错过的小时补不回来 |

7881 的挂单都标“跨区”，各服挂单基本是同一个市场；服名取卖家所在服，「昆仑墟」改写为「昆仑虚」。
单价不在 0.5—50 元/万铜之间、或库存为 0 的挂单不参与计算。
明细在 `data/tongjia-7881.csv`：`server, server_id, bucket_str, min_price（最低挂单价）, price_1000wan, listings（挂单数）, stock_wan, fetched_at`。
`data/status.json` 带 `source: "7881"`，每服记挂单数和价格。

2026-11-20 14 时实测：原 8 个服都有挂单，共 330 条；买满 1000 万铜均价 4.59—4.73 元/万，最低挂单 4.51。千岛同日 12 时成交均价 4.49—4.55。
另有「自在门」1 条挂单（17 万铜，6 元/万）；日报按挂单量加权，这类零星挂单影响很小。

## 数据

`data/tongjia.csv`，列（以下为千岛时期的说明，7881 口径见上节）：

- `server` 服务器名
- `spec_id` 服务器对应的 specId
- `bucket_timestamp` 数据桶时间戳(ms)
- `bucket_str` 数据桶时间(如 `2026-08-14 19`)
- `rmb_per_wan` 1万铜币兑多少人民币
- `trading_volume` 该小时成交量(万币)
- `fetched_at` 本次抓取时间(UTC ISO)

同一 `server+bucket_str` 会被覆盖更新(因为当前进行中的小时数据是滚动更新的，直到该小时结束才是最终值)。

## 采集方式

因为 qiandao.com 的接口请求带前端 JS 计算的签名(HMAC)，无法直接拼 HTTP 请求绕过，所以用 Playwright 跑一个真实(headless)浏览器打开页面，切换服务器下拉框，拦截页面自身发出的 `get-price-line` 接口响应来拿数据。

## 服务器列表

| 服务器 | specId |
|---|---|
| 三清山 | 324996 |
| 云樱岛 | 324997 |
| 桃花坞 | 324998 |
| 水帘洞 | 3211946 |
| 白帝城 | 324999 |
| 花果山 | 3146578 |
| 女儿国 | 3712269 |
| 昆仑虚 | 3865477 |

自在门、谪仙岛(9/25 开服)截至 2026-09-25 千岛下拉框中尚未上架，上架后按同样方式补充。

## 定时任务

`.github/workflows/collect.yml`，每小时第5分钟跑一次，也可以在 Actions 页面手动 `workflow_dispatch` 触发。

GitHub 的定时触发可能延迟，并非每小时准时启动。云端使用虚拟显示器运行完整 Chromium。遇到千岛滑块时，通过页面鼠标操作尝试一次；验证失败或 HTTP 限流后停止，不循环重试。此方式不能保证平台以后一直接受自动采集。

`data/status.json` 记录每个服务器本轮的状态。`ok` 才表示取回有效价格；`no_data` 表示接口成功但价格列表为空；`failed`/`not_collected` 表示本轮未取回数据。空列表不会写成零价，历史 CSV 也不会被伪装成已更新。最新价格超过 6 小时则报错。

2026-11-01 实测：7 个服务器有价格；白帝城接口返回空价格列表，历史数据保留。

## 本地手动跑一次

```bash
npm install
npx playwright install --with-deps chromium
npm run collect
```

本机需要显示浏览器时：`node scripts/collect.js --headed`。需要人工介入时：`npm run collect:interactive`，最多等待 10 分钟。

可设置 `TONGJIA_PROFILE` 为本机专用会话目录。会话包含站点数据，只保留在本机，禁止上传到仓库。默认交互模式使用已忽略的 `.browser-profile/`。

运行 `npm test` 验证空数据、过期数据及验证失败处理。

### Windows 自动备用

`scripts/run-local.ps1` 从 `main` 同步程序，使用本机专用会话运行完整浏览器，再将结果提交到 GitHub。Windows 定时任务 `NSH_TongjiaPriceFetch` 调用此脚本；电脑必须开机且用户已登录。运行日志位于已忽略的 `logs/`。脚本遇到本地未提交改动或 Git 同步错误时停止，保留数据，不强制覆盖。

2026-11-02 起，本机任务将采集器放在独立的 Win32 后台桌面中运行，不切换用户桌面，浏览器不出现在当前桌面或任务栏。完整浏览器模式和千岛采集逻辑保持不变，未改用 headless。
`scripts/isolated-desktop.ps1` 创建并回收后台桌面；`scripts/collect-worker.ps1` 执行采集。采集子进程最长运行 9 分钟，超时只终止该子进程及其后代。任务总时限仍为 10 分钟。
`logs/*-collector.log` 保存采集日志；任务主日志的 `[silent]` 行记录后台桌面、窗口数和退出码。若需人工验证，仍可手动运行 `npm run collect:interactive` 打开可见窗口。

2026-11-01 云端两次实测仍被访问验证拦截。自动拖动滑块尚未通过验证；不能承诺云端已经恢复。完整浏览器的本机采集已成功，作为备用来源。
