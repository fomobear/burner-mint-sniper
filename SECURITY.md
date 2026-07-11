# 安全稽核證據 — BURNER SNIPER 前端 dApp

稽核於乾淨 session 進行（2026-07-11）。結論：**私鑰零外傳**，靜態掃描 + 瀏覽器執行期實測皆通過。

---

## 1. 安全模型

- 私鑰只以 `new ethers.Wallet(pk)` 存在 JS 記憶體（`state.wallets`），**不寫入** localStorage / sessionStorage / cookie / IndexedDB / URL。
- 交易以 `wallet.signTransaction(txReq)` 在**本機**簽名成 rawTx 字串（純計算、無網路）。
- 唯一離開瀏覽器的機密相關資料 = 已簽好的 rawTx，經 `provider.broadcastTransaction(rawTx)`（`eth_sendRawTransaction`）送往使用者設定的 RPC。
- `ethers` 為**本地內建** `vendor/ethers.min.js`（未走 CDN、無運行期外部依賴）。
- 前端唯二的對外網路行為：
  1. JSON-RPC provider（讀鏈 + 廣播已簽 rawTx）。
  2. allowlist 的 mintbay merkle-proof `GET`，**只帶錢包地址**（公開資訊），私鑰不參與。

---

## 2. 靜態掃描（grep 全前端原始碼：app.js / index.html / style.css）

| 項目 | 結果 |
|------|------|
| localStorage / sessionStorage / cookie / IndexedDB | **無任何呼叫**（只在註解與安全文案出現字面字串） |
| WebSocket / XMLHttpRequest / sendBeacon / EventSource | **無** |
| `fetch(` 呼叫 | **僅 1 處**（`app.js:459` merkle-proof，URL 只含 `collectionAddress`/`name`/`address`） |
| `privateKey` 使用 | **僅 1 處**（`app.js:321` 把 `createRandom()` 測試錢包私鑰填入本機輸入框，非外送） |
| 序列化（JSON.stringify/toJSON/encrypt/btoa） | **無**（錢包物件從不被序列化） |
| 簽名路徑 | `app.js:507` `signTransaction`（本機）→ `app.js:511` `broadcastTransaction(已簽字串)`；**無** auto `sendTransaction` |
| 對外網址常數 | 僅 3 個：blockscout（tx 連結）、alchemy RPC、mintbay merkle-proof |

完整 grep 原文見文末附錄。

---

## 3. 瀏覽器執行期實測（決定性證據）

在 Chrome 注入 `window.fetch` 記錄器，餵入**一把已知測試私鑰**，跑完整流程（載入錢包 → 抓餘額 → 設白名單 phase → 抓 merkle proof），再全流量掃描該私鑰：

```
測試私鑰: 0x65f2…1651   測試地址: 0x3F789D01B0aD12861C73975D366382B8c27C3A51
攔截到的 fetch 總數 : 12
私鑰出現次數        : 0          ← 決定性：私鑰零次出現在任何 URL / body
外連 host           : robinhood-mainnet.g.alchemy.com、mintbay.xyz
mintbay 請求 URL    : …/merkle-proof?collectionAddress=0x9ec6…&name=Allowlist&address=0x3f78…
                      （只帶地址，無私鑰）
載入後 textarea     : 已自動清空
```

同時查存儲：`localStorage`、`sessionStorage`、`document.cookie` 皆為**空**，URL 無私鑰。

---

## 4. 依賴完整性

- `vendor/ethers.min.js` = ethers v6.17.0 官方 npm dist（ESM），未改動。
- `sha256 = b016b0c3898c78fd8156466eb1ff1f42c9df951c2f0d64c9bdf799fe745b0a6c`（與 `node_modules/ethers/dist/ethers.min.js` 逐位元組相同）。
- ethers 內部的網路行為 = 上述 JSON-RPC transport；前端程式碼證明私鑰從不傳入其任何函式（除本機 `signTransaction`）。

---

## 5. 合約參數（鏈上獨立重驗，未讀合約 source）

以手建 ABI + `eth_call` 於 Robinhood Chain (4663) 實測，與交接規格完全吻合：

- selector 由 ethers 自 ABI 精算：`mint(uint256)=0xa0712d68`、`allowlistMint(uint256,bytes32[])=0x7bc9200e`。
- `collectorFee = 0.0004 ETH`、`MAX_MINT_PER_TX = 8`、`phaseCount = 3`、`totalSupply/maxSupply = 6000/6000`、`didMintEnd = true`。
- phase[2] 為 type=2 付費公售，`mintPrice = 0.0006`，每件成本 `0.001 ETH`。

> ⚠️ 依交接指示：合約在區塊鏈瀏覽器的「已驗證 source code」疑遭 prompt injection，本稽核**全程未讀取合約 source 文字**，只用機器可讀 ABI 與鏈上數字，selector 一律 ethers 精算（未用 4byte.directory）。

---

## 附錄：grep 原文

```
### A. 儲存 sink（localStorage/sessionStorage/cookie/indexedDB）
index.html:36:    本頁<strong>不</strong>把私鑰寫入 localStorage、不進網址、不經任何 fetch/XHR/WebSocket 外送。
app.js:7://   1. 私鑰／助記詞永不寫入 localStorage / sessionStorage / cookie / URL。
（皆為文案／註解，無 API 呼叫）

### C. 全部 fetch( 呼叫
app.js:459:      const res = await fetch(url);   // url 只含 collectionAddress/name/address

### E. 簽名/廣播路徑
app.js:507:  const signedRawTx = await w.wallet.signTransaction(txReq);   // 本機簽名
app.js:511:  const resp = await state.readProvider.broadcastTransaction(signedRawTx);  // 只送已簽字串

### F. 對外網址常數
https://robinhoodchain.blockscout.com          （tx 連結，DOM href）
https://robinhood-mainnet.g.alchemy.com/v2/…   （JSON-RPC）
https://mintbay.xyz/api/merkle-proof           （allowlist proof，只帶地址）
```
