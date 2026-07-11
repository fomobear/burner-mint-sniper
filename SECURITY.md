# 安全稽核證據 — BURNER SNIPER 前端 dApp

稽核於乾淨 session 進行（2026-07-11，含 WSS 盯塊／預簽／模擬偵測強化版重驗）。結論：**私鑰零外傳**，靜態掃描 + 瀏覽器執行期實測（含 WebSocket frames）皆通過。

---

## 1. 安全模型

- 私鑰只以 `new ethers.Wallet(pk)` 存在 JS 記憶體（`state.wallets`），**不寫入** localStorage / sessionStorage / cookie / IndexedDB / URL。
- 交易以 `wallet.signTransaction(txReq)` 在**本機**簽名成 rawTx 字串（純計算、無網路）；待命時「預簽」也是同一本機函式。
- 唯一離開瀏覽器的機密相關資料 = 已簽好的 rawTx，經 `provider.broadcastTransaction(rawTx)`（`eth_sendRawTransaction`）送往使用者設定的 RPC。
- `ethers` 為**本地內建** `vendor/ethers.min.js`（未走 CDN、無運行期外部依賴）。
- 前端對外網路行為僅三類，皆不含私鑰：
  1. JSON-RPC provider（讀鏈、開售 `eth_call` 模擬、廣播已簽 rawTx）。
  2. **WebSocket provider**（盯新區塊，唯讀）：只送 `eth_subscribe(["newHeads"])`，收區塊頭；不簽名、不帶私鑰。
  3. allowlist 的 mintbay merkle-proof `GET`：只帶錢包地址（公開資訊）。

---

## 2. 靜態掃描（grep 全前端原始碼：app.js / index.html / style.css）

| 項目 | 結果 |
|------|------|
| localStorage / sessionStorage / cookie / IndexedDB | **無任何呼叫**（只在註解與安全文案出現字面字串） |
| `fetch(` 呼叫 | **僅 1 處**（`app.js` merkle-proof，URL 只含 `collectionAddress`/`name`/`address`） |
| WebSocket 使用 | **僅盯塊**：`new ethers.WebSocketProvider(wssUrl)` + `.on("block", …)` + `.destroy()`；`wssUrl` 由 RPC URL 推導，無私鑰 |
| `privateKey` 使用 | **僅 1 處**（`genTestWallet` 把 `createRandom()` 測試私鑰填入本機輸入框，非外送） |
| 序列化（JSON.stringify/toJSON/encrypt/btoa） | **無**（錢包物件從不被序列化） |
| 簽名路徑 | `w.wallet.signTransaction`（本機，預簽與現簽各一處）→ `broadcastTransaction(已簽字串)`；**無** auto `sendTransaction` |
| 對外網址 | blockscout（tx 連結）、alchemy RPC（https 讀/廣播、wss 盯塊同源）、mintbay（proof，地址） |

---

## 3. 瀏覽器執行期實測（決定性證據，含 WebSocket）

注入 `window.fetch` **與 `WebSocket.prototype.send`** 雙記錄器，餵入**一把已知測試私鑰**，跑完整強化流程（載入 → 抓餘額 → ARM：預簽全交易 + WSS 訂閱區塊 + 每塊 `eth_call` 模擬偵測），再對**所有 HTTP body 與所有 WS frame** 掃描該私鑰：

```
測試私鑰: 0x75e8…ccfc   測試地址: 0xfC4a07899324b61866bf61cB8362ac490aa60570
fetch 總數           : 10
WebSocket frame 總數 : 2
  · WS URL   : wss://robinhood-mainnet.g.alchemy.com/v2/…   （RPC wss，非私鑰）
  · WS SEND  : {"method":"eth_subscribe","params":["newHeads"],…}   （只訂閱區塊頭）
私鑰出現於 fetch 次數 : 0        ← 決定性
私鑰出現於 WS 次數    : 0        ← 決定性（WebSocket 也乾淨）
載入後 textarea       : 已自動清空
```

同時查存儲：`localStorage`、`sessionStorage`、`document.cookie` 皆為**空**，URL 無私鑰。

**功能行為實測**（同一 session）：
- 送前模擬：對已售罄合約按開火 → `eth_call` 模擬失敗 → 全錢包跳過、`eth_sendRawTransaction` 送出 **0 次**（零 gas 浪費）。
- 預簽 + WSS 盯塊：ARM 後 log「預簽完成」+「WebSocket 已連」，狀態列即時顯示「WSS 盯塊 #6602115」。
- 保底價：floor=0.005 時每錢包成本顯示 `max(0.0004, 0.005)=0.0050 ETH`。

---

## 4. 依賴完整性

- `vendor/ethers.min.js` = ethers v6.17.0 官方 npm dist（ESM），未改動。
- `sha256 = b016b0c3898c78fd8156466eb1ff1f42c9df951c2f0d64c9bdf799fe745b0a6c`。
- ethers 內部網路行為 = 上述 JSON-RPC（https）與 WebSocket（wss）transport；前端程式碼證明私鑰從不傳入其任何函式（除本機 `signTransaction`）。

---

## 5. 合約參數（鏈上獨立重驗，未讀合約 source）

以手建 ABI + `eth_call` 於 Robinhood Chain (4663) 實測，與交接規格完全吻合：

- selector 由 ethers 自 ABI 精算：`mint(uint256)=0xa0712d68`、`allowlistMint(uint256,bytes32[])=0x7bc9200e`。
- `collectorFee = 0.0004 ETH`、`MAX_MINT_PER_TX = 8`、`phaseCount = 3`、`totalSupply/maxSupply = 6000/6000`、`didMintEnd = true`。
- phase[2] 為 type=2 付費公售，`mintPrice = 0.0006`，每件成本 `0.001 ETH`。

> ⚠️ 依交接指示：合約在區塊鏈瀏覽器的「已驗證 source code」疑遭 prompt injection，本稽核**全程未讀取合約 source 文字**，只用機器可讀 ABI 與鏈上數字，selector 一律 ethers 精算（未用 4byte.directory）。

---

## 6. 搶鑄強化（v2）對安全的影響

新增 5 項（WSS 盯塊、待命預簽、每塊模擬偵測開售、送前模擬、保底價 max）**不改變**安全模型：

- WSS 只做 `eth_subscribe(newHeads)`，唯讀、無私鑰（§3 已實測 0 次）。
- 預簽 = 多做幾次本機 `signTransaction`，rawTx 存記憶體；離開瀏覽器的仍只有已簽字串。
- 模擬 = `eth_call`（calldata + from 地址 + value，無私鑰）。
- 保底價、送前模擬 = 純本地計算/唯讀查詢。
