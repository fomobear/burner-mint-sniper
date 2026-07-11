# BURNER SNIPER — 燃燒錢包批量搶鑄 dApp

純前端、私鑰本機簽名、零外傳的 NFT 批量搶鑄主控台。對標 hoodie-sniper：貼多把私鑰、設 gas、設數量、一鍵批量自動搶 mint。目標鏈為 Robinhood Chain（chainId 4663），合約地址可切換到未來的 mintbay drop。

線上：**https://mint.harrysontech.xyz**

> 🔒 **只用燃燒錢包（用完即丟）。** 私鑰只在你這台瀏覽器的記憶體、只用來以 ethers 本地簽名，不寫入任何儲存、不經任何 fetch 外送。安全稽核見 [`SECURITY.md`](./SECURITY.md)。
>
> 📌 **公開架站的安全取捨**：本站為純 client-side 靜態站（HTTPS、無後端、程式碼公開可審），私鑰始終不離開你的瀏覽器。但任何「託管的」簽名工具都存在共同殘餘風險——若託管來源被入侵而抽換 JS，理論上可植入外洩碼。**最高安全等級請把本 repo 下載到本機執行**（下方方法 A/B），並只用燃燒錢包。

---

## 怎麼跑

純靜態，無需 build。任選一種：

```bash
# 方法 A：本機起靜態 server（推薦，dialog/module 皆正常）
python3 -m http.server 8799
# 開 http://localhost:8799/index.html

# 方法 B：直接開檔
# 用瀏覽器打開 index.html（ESM 模組在 file:// 下多數瀏覽器可運作）

# 方法 C：線上版 https://mint.harrysontech.xyz
```

離線可用：`ethers` 已內建於 `vendor/ethers.min.js`，不連 CDN。唯一需要連網的是你設定的 RPC（讀鏈 + 送交易）與白名單的 mintbay proof 查詢。

---

## 功能

- **多錢包載入**：文字框一行一把私鑰貼入，去重、格式檢查；即時顯示地址與餘額。
- **產生測試錢包**：`ethers.Wallet.createRandom()` 一鍵產生全新測試錢包，安全試玩 UI（無資產）。
- **即時鏈上狀態**：collection 名稱/供給/是否售罄/暫停、`collectorFee`、`MAX_MINT_PER_TX`；當前 phase 型別/開賣倒數/單價/每址上限/root。
- **Gas 控制**：自動（依鏈上 `baseFee` × 倍率 + priority）或手動指定 `maxFeePerGas`/`maxPriorityFeePerGas`/`gasLimit`。Robinhood Chain 為 EIP-1559。
- **批量開火**：
  - `🔥 立即批量開火` — 所有錢包並發、各自本機簽名並廣播；送出前彈確認框（顯示錢包數與總成本）。
  - `⏻ ARM 待命自動搶` — 進入 2.5s 快輪詢，偵測到 phase 進入 LIVE 立即自動批量開火（每個 phase 只開一次）。
- **白名單**：allowlist phase 自動顯示查詢區，`為所有錢包抓 proof` 逐一向 mintbay 取各地址 merkle proof，走 `allowlistMint(qty, proof)`。
- **逐錢包狀態表**：待命 / 簽名中 / 廣播中 / 上鏈中 / 成功 / 失敗 + tx 連結；活動 log。

---

## 合約參數（鏈上實測，見 SECURITY.md §5）

- Collection（交易發這裡，EIP-1167 proxy）：`0x9Ec6C5b9f572A9B02138E553BC5F5882Da735F45`
- `mint(uint256)` = `0xa0712d68`（公售）／`allowlistMint(uint256,bytes32[])` = `0x7bc9200e`（白名單）
- 每件成本 = `mintPrice + collectorFee`（`collectorFee = 0.0004 ETH`）；`value = 數量 × 每件成本`
- 預設目標 OnChainHoodies 已售罄（6000/6000、`didMintEnd=true`）——拿它可用測試錢包驗流程（會 revert），實戰請把 TARGET 換成未來的 drop。

RPC 預設用交接規格提供的共用 Alchemy key（會限流）。**批量搶鑄請務必到 ⚙ RPC 換成你自己的 key**，否則多錢包並發會被擋。

---

## 安全底線（不可跨）

1. 私鑰／助記詞永不寫入 localStorage / sessionStorage / cookie / URL。
2. 私鑰永不進入任何 fetch / XHR / WebSocket / sendBeacon 參數。
3. 唯一離開瀏覽器的機密相關資料 = 本機簽好的 rawTx。
4. 只用燃燒錢包；程式為單一資料夾純靜態檔，可自行審閱（`app.js` 私鑰相關處皆有 🔒 註解）。

## 免責

自負風險。搶鑄涉及花費真實資產與 gas；請先用測試錢包驗證流程，確認 gas 與數量設定無誤再上真燃燒錢包。
