# nsh-tongjia

逆水寒(黄金畅玩服铜币)各服铜价逐时数据采集，通过 GitHub Actions 定时任务在云端跑，本地关机也不影响采集。

## 数据

`data/tongjia.csv`，列：

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

## 定时任务

`.github/workflows/collect.yml`，每小时第5分钟跑一次，也可以在 Actions 页面手动 `workflow_dispatch` 触发。

## 本地手动跑一次

```bash
npm install
npx playwright install --with-deps chromium
npm run collect
```
