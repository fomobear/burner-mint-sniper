// ============================================================================
// BURNER SNIPER // 燃燒錢包批量搶鑄主控台
// ----------------------------------------------------------------------------
// 純前端 dApp。私鑰只存在瀏覽器記憶體，只用來以 ethers 在「本機」簽名。
//
// 🔒 安全不變式（全檔遵守）：
//   1. 私鑰／助記詞永不寫入 localStorage / sessionStorage / cookie / URL。
//   2. 私鑰永不進入任何 fetch / XHR / WebSocket / sendBeacon 的參數。
//   3. 唯一離開瀏覽器的機密相關資料 = ethers 在本機簽好的 rawTx 字串，
//      經使用者設定的 RPC 廣播（eth_sendRawTransaction）。
//   4. ethers 為本地內建（./vendor/ethers.min.js，未走 CDN、未改動）。
//   本檔唯二的對外網路行為：(a) JSON-RPC provider（讀鏈 + 廣播已簽 rawTx）；
//   (b) allowlist 的 mintbay merkle-proof GET（只帶「地址」，非私鑰）。
// ============================================================================

import * as ethers from "./vendor/ethers.min.js";

// -------------------------------------------------------------- 常數
const CHAIN_ID = 4663;
const CHAIN_NAME = "Robinhood Chain";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const DEFAULT_RPC = "https://robinhood-mainnet.g.alchemy.com/v2/wshSTTr1LEcj08J6cQCbX";
const DEFAULT_CONTRACT = "0x9Ec6C5b9f572A9B02138E553BC5F5882Da735F45";
const MERKLE_PROOF_API = "https://mintbay.xyz/api/merkle-proof";
const POLL_MS_IDLE = 12000;
const POLL_MS_ARMED = 2500;

// 手建 ABI（機器可讀）。刻意不讀合約 source code 文字；函數簽名來自交接規格，
// selector 由 ethers 自 ABI 精算。
const ABI = [
  "function mint(uint256 quantity) payable",
  "function allowlistMint(uint256 quantity, bytes32[] proof) payable",
  "function phases(uint256) view returns (uint8 phaseType, uint256 startTime, uint256 endTime, uint256 mintPrice, uint256 maxPerAddress, uint256 maxSupply, uint256 mintedInPhase, bytes32 allowlistRoot)",
  "function currentPhaseId() view returns (uint256)",
  "function phaseCount() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function didMintEnd() view returns (bool)",
  "function mintingPaused() view returns (bool)",
  "function MAX_MINT_PER_TX() view returns (uint256)",
  "function collectorFee() view returns (uint256)",
  "function phaseMinted(uint256, address) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];
const iface = new ethers.Interface(ABI);
const PHASE_TYPE_LABEL = { 0: "PUBLIC 免費", 1: "ALLOWLIST 白名單", 2: "PUBLIC 付費" };

// -------------------------------------------------------------- DOM
const el = (id) => document.getElementById(id);
const dom = {
  chainBadge: el("chainBadge"), chainBadgeText: el("chainBadgeText"),
  settingsBtn: el("settingsBtn"), settingsDialog: el("settingsDialog"),
  rpcInput: el("rpcInput"), resetRpcBtn: el("resetRpcBtn"),
  settingsForm: document.querySelector(".settings-form"),
  contractInput: el("contractInput"), loadBtn: el("loadBtn"), targetStatus: el("targetStatus"),
  collectionBadges: el("collectionBadges"), collectionName: el("collectionName"), collectionSymbol: el("collectionSymbol"),
  supplyNumbers: el("supplyNumbers"), supplyFill: el("supplyFill"),
  pausedVal: el("pausedVal"), endedVal: el("endedVal"), maxTxVal: el("maxTxVal"), feeVal: el("feeVal"),
  phaseCard: el("phaseCard"), phaseIdVal: el("phaseIdVal"), phaseTypeBadge: el("phaseTypeBadge"),
  phaseStateBadge: el("phaseStateBadge"), countdownLabel: el("countdownLabel"), countdownDigits: el("countdownDigits"),
  priceVal: el("priceVal"), maxAddrVal: el("maxAddrVal"), phaseMintedVal: el("phaseMintedVal"), rootVal: el("rootVal"),
  pkInput: el("pkInput"), loadWalletsBtn: el("loadWalletsBtn"), genTestBtn: el("genTestBtn"),
  refreshBalBtn: el("refreshBalBtn"), clearWalletsBtn: el("clearWalletsBtn"),
  walletCount: el("walletCount"), walletTbody: el("walletTbody"),
  qtyMinus: el("qtyMinus"), qtyPlus: el("qtyPlus"), qtyInput: el("qtyInput"), qtyMaxHint: el("qtyMaxHint"),
  gasMode: el("gasMode"), autoMult: el("autoMult"), autoMultField: el("autoMultField"),
  maxFeeInput: el("maxFeeInput"), prioFeeInput: el("prioFeeInput"), gasLimitInput: el("gasLimitInput"),
  allowlistBox: el("allowlistBox"), phaseNameInput: el("phaseNameInput"), fetchProofsBtn: el("fetchProofsBtn"), allowlistStatus: el("allowlistStatus"),
  sumWallets: el("sumWallets"), sumPerWallet: el("sumPerWallet"), sumTotal: el("sumTotal"),
  armBtn: el("armBtn"), fireBtn: el("fireBtn"), fireHint: el("fireHint"),
  logBody: el("logBody"), clearLogBtn: el("clearLogBtn"), toast: el("toast"),
};

// -------------------------------------------------------------- state
// 🔒 state.wallets 內含 ethers.Wallet（帶私鑰）。此物件只活在記憶體，
//    永不被序列化、儲存或送出。清除頁面 / 按「清除」即消失。
const state = {
  rpcUrl: DEFAULT_RPC,          // 非機密，可自由更改；不落地儲存
  contractAddress: DEFAULT_CONTRACT,
  readProvider: null,
  readContract: null,
  wallets: [],                  // { id, wallet, address, balance, proof, proofFor, status, txHash, error }
  quantity: 1,
  data: null,                   // 最新鏈上快照
  pollTimer: null,
  tickTimer: null,
  loadSeq: 0,
  armed: false,
  firedForPhase: null,          // 已對哪個 phaseId 自動開火過，避免重複
  firing: false,
};

let walletSeq = 0;

// -------------------------------------------------------------- 小工具
function shortAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—"; }
function fmtEth(wei) { try { return Number(ethers.formatEther(wei)).toFixed(4) + " ETH"; } catch { return "—"; } }
function nowSec() { return Math.floor(Date.now() / 1000); }
function shortErr(err) {
  const m = err?.shortMessage || err?.info?.error?.message || err?.message || String(err);
  return m.length > 140 ? m.slice(0, 140) + "…" : m;
}

let toastTimer = null;
function showToast(msg) {
  dom.toast.textContent = msg; dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 4200);
}

function log(msg, tone = "") {
  const line = document.createElement("div");
  line.className = "log-line" + (tone ? ` tone-${tone}` : "");
  const t = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  line.textContent = `[${t}] ${msg}`;
  dom.logBody.prepend(line);
  while (dom.logBody.childElementCount > 200) dom.logBody.lastElementChild.remove();
}

function normalizeAddress(input) {
  const t = (input || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error("合約地址格式錯誤（需 0x + 40 hex）");
  return ethers.getAddress(t);
}

// -------------------------------------------------------------- provider / 讀鏈
function initReadProvider() {
  state.readProvider = new ethers.JsonRpcProvider(state.rpcUrl, { chainId: CHAIN_ID, name: "robinhood" }, { staticNetwork: true });
}

async function loadContract() {
  const mySeq = ++state.loadSeq;
  try { state.contractAddress = normalizeAddress(dom.contractInput.value || state.contractAddress); }
  catch (e) { setTargetStatus(e.message, "error"); return; }
  dom.contractInput.value = state.contractAddress;
  setTargetStatus("讀取中…", "");

  initReadProvider();
  state.readContract = new ethers.Contract(state.contractAddress, ABI, state.readProvider);
  // 目標切換：重掛所有錢包到新 provider、清白名單快取
  for (const w of state.wallets) { w.wallet = w.wallet.connect(state.readProvider); w.proof = null; w.proofFor = null; }
  disarm("目標合約已切換");

  stopPolling();
  await pollOnce(mySeq);
  if (mySeq !== state.loadSeq) return;
  startPolling();
}

function setTargetStatus(msg, tone) {
  dom.targetStatus.textContent = msg;
  if (tone) dom.targetStatus.dataset.tone = tone; else delete dom.targetStatus.dataset.tone;
}

function stopPolling() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }
function startPolling() {
  stopPolling();
  const ms = state.armed ? POLL_MS_ARMED : POLL_MS_IDLE;
  state.pollTimer = setInterval(() => pollOnce(state.loadSeq), ms);
}

async function safeCall(p, fb = null) { try { return await p; } catch { return fb; } }

async function pollOnce(mySeq) {
  const c = state.readContract;
  if (!c) return;
  try {
    const [name, symbol, totalSupply, maxSupply, didMintEnd, mintingPaused,
      currentPhaseId, phaseCount, maxPerTx, collectorFee] = await Promise.all([
      safeCall(c.name(), "UNKNOWN"), safeCall(c.symbol(), ""),
      safeCall(c.totalSupply(), 0n), safeCall(c.maxSupply(), 0n),
      safeCall(c.didMintEnd(), false), safeCall(c.mintingPaused(), false),
      safeCall(c.currentPhaseId(), 0n), safeCall(c.phaseCount(), 0n),
      safeCall(c.MAX_MINT_PER_TX(), 0n), safeCall(c.collectorFee(), 0n),
    ]);
    if (mySeq !== state.loadSeq) return;

    let phase = null;
    try {
      const raw = await c.phases(currentPhaseId);
      phase = {
        phaseType: Number(raw[0]), startTime: Number(raw[1]), endTime: Number(raw[2]),
        mintPrice: raw[3], maxPerAddress: Number(raw[4]), maxSupply: Number(raw[5]),
        mintedInPhase: Number(raw[6]), allowlistRoot: raw[7],
      };
    } catch { /* 尚未設定 phase */ }

    state.data = {
      name, symbol, totalSupply: Number(totalSupply), maxSupply: Number(maxSupply),
      didMintEnd: Boolean(didMintEnd), mintingPaused: Boolean(mintingPaused),
      currentPhaseId: Number(currentPhaseId), phaseCount: Number(phaseCount),
      maxPerTx: Number(maxPerTx), collectorFee, phase, fetchedAt: Date.now(),
    };
    setTargetStatus(`已連線 · ${new Date().toLocaleTimeString("zh-TW", { hour12: false })}`, "ok");
    dom.chainBadge.dataset.state = "ok";
    dom.chainBadgeText.textContent = `${CHAIN_NAME} (${CHAIN_ID})`;
    render();
    maybeAutoFire();
  } catch (err) {
    setTargetStatus("讀取失敗：" + shortErr(err), "error");
    dom.chainBadge.dataset.state = "bad";
    dom.chainBadgeText.textContent = "RPC 錯誤";
  }
}

// -------------------------------------------------------------- render 鏈上
function computeIsActive(phase, data) {
  if (!phase || !data) return false;
  if (data.mintingPaused || data.didMintEnd) return false;
  const n = nowSec();
  return n >= phase.startTime && n < phase.endTime && phase.startTime > 0;
}

function formatCountdown(s) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return d > 0 ? `${d}d ${p(h)}:${p(m)}:${p(ss)}` : `${p(h)}:${p(m)}:${p(ss)}`;
}

function render() {
  const data = state.data;
  if (!data) return;

  dom.collectionName.textContent = data.name || "UNKNOWN";
  dom.collectionSymbol.textContent = data.symbol ? `$${data.symbol}` : "";
  dom.supplyNumbers.textContent = `${data.totalSupply} / ${data.maxSupply || "?"}`;
  const pct = data.maxSupply > 0 ? Math.min(100, (data.totalSupply / data.maxSupply) * 100) : 0;
  dom.supplyFill.style.width = pct + "%";
  dom.supplyFill.dataset.full = String(data.didMintEnd || pct >= 100);
  dom.pausedVal.textContent = data.mintingPaused ? "TRUE" : "false";
  dom.endedVal.textContent = data.didMintEnd ? "TRUE" : "false";
  dom.maxTxVal.textContent = data.maxPerTx > 0 ? String(data.maxPerTx) : "—";
  dom.feeVal.textContent = fmtEth(data.collectorFee);

  dom.collectionBadges.innerHTML = "";
  const addBadge = (text, tone) => {
    const s = document.createElement("span");
    s.className = `badge tone-${tone}`; s.textContent = text;
    dom.collectionBadges.appendChild(s);
  };
  if (data.didMintEnd) addBadge("SOLD OUT", "danger");
  else if (data.mintingPaused) addBadge("PAUSED", "warn");
  else addBadge("OPERATIONAL", "ok");

  const phase = data.phase;
  const isActive = computeIsActive(phase, data);
  dom.phaseCard.dataset.active = String(isActive);

  if (!phase) {
    dom.phaseIdVal.textContent = "PHASE —";
    dom.phaseTypeBadge.textContent = "無 PHASE";
    dom.phaseStateBadge.textContent = "—"; dom.phaseStateBadge.dataset.state = "ended";
    dom.countdownLabel.textContent = "尚未設定任何 phase"; dom.countdownDigits.textContent = "--:--:--";
    dom.priceVal.textContent = "—"; dom.maxAddrVal.textContent = "—"; dom.phaseMintedVal.textContent = "—"; dom.rootVal.textContent = "—";
    dom.allowlistBox.hidden = true;
  } else {
    dom.phaseIdVal.textContent = `PHASE ${data.currentPhaseId} / ${data.phaseCount}`;
    dom.phaseTypeBadge.textContent = PHASE_TYPE_LABEL[phase.phaseType] ?? `TYPE ${phase.phaseType}`;
    dom.priceVal.textContent = fmtEth(phase.mintPrice + data.collectorFee);
    dom.maxAddrVal.textContent = phase.maxPerAddress > 0 ? String(phase.maxPerAddress) : "無上限";
    dom.phaseMintedVal.textContent = `${phase.mintedInPhase} / ${phase.maxSupply || "?"}`;
    dom.rootVal.textContent = phase.allowlistRoot && !/^0x0+$/.test(phase.allowlistRoot) ? phase.allowlistRoot.slice(0, 10) + "…" : "無（公售）";
    dom.allowlistBox.hidden = phase.phaseType !== 1;

    const n = nowSec();
    const setState = (txt, st, label, digits) => {
      dom.phaseStateBadge.textContent = txt; dom.phaseStateBadge.dataset.state = st;
      dom.countdownLabel.textContent = label; dom.countdownDigits.textContent = digits;
    };
    if (data.mintingPaused) setState("PAUSED", "paused", "鑄造已暫停", "--:--:--");
    else if (data.didMintEnd) setState("ENDED", "ended", "已售罄結束", "--:--:--");
    else if (phase.startTime === 0) setState("未定", "upcoming", "phase 尚未排程", "--:--:--");
    else if (n < phase.startTime) setState("UPCOMING", "upcoming", "距離開賣", formatCountdown(phase.startTime - n));
    else if (n < phase.endTime) setState("LIVE", "live", "剩餘時間", formatCountdown(phase.endTime - n));
    else setState("PHASE ENDED", "ended", "此 phase 已過期", "--:--:--");
  }

  renderWallets();
  updateQuantityBounds();
  updateSummary();
  updateFireButtons();
}

// -------------------------------------------------------------- 錢包管理
// 🔒 解析私鑰：字串 → ethers.Wallet。私鑰只在本函式的區域變數與 state.wallets 記憶體內流轉，
//    絕不寫入任何儲存或送出。
function loadWalletsFromTextarea() {
  const lines = dom.pkInput.value.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) { showToast("沒有偵測到私鑰。"); return; }
  if (!state.readProvider) initReadProvider();

  let added = 0, dup = 0, bad = 0;
  const existing = new Set(state.wallets.map((w) => w.address.toLowerCase()));
  for (const line of lines) {
    let pk = line;
    if (!pk.startsWith("0x")) pk = "0x" + pk;
    let w;
    try { w = new ethers.Wallet(pk, state.readProvider); }
    catch { bad++; continue; }
    if (existing.has(w.address.toLowerCase())) { dup++; continue; }
    existing.add(w.address.toLowerCase());
    state.wallets.push({
      id: ++walletSeq, wallet: w, address: w.address, balance: null,
      proof: null, proofFor: null, status: "idle", txHash: null, error: null,
    });
    added++;
  }
  // 🔒 立即清空輸入框，避免私鑰明文停留在 DOM。
  dom.pkInput.value = "";
  log(`載入錢包：新增 ${added}、重複略過 ${dup}、格式錯誤 ${bad}`, added ? "ok" : "warn");
  showToast(`已載入 ${added} 個錢包${dup ? `（略過 ${dup} 重複）` : ""}${bad ? `（${bad} 個格式錯誤）` : ""}`);
  renderWallets(); updateSummary(); updateFireButtons();
  refreshBalances();
}

function genTestWallet() {
  // 依安全底線：開發驗證只用 createRandom() 產生的測試私鑰。
  const w = ethers.Wallet.createRandom();
  dom.pkInput.value = (dom.pkInput.value ? dom.pkInput.value.replace(/\s*$/, "") + "\n" : "") + w.privateKey;
  log(`產生測試錢包 ${shortAddr(w.address)}（createRandom，僅供試玩，無資產）`, "");
  showToast("已把一個全新測試錢包私鑰貼入輸入框，按「載入錢包」即可。");
}

async function refreshBalances() {
  if (!state.readProvider || state.wallets.length === 0) return;
  await Promise.all(state.wallets.map(async (w) => {
    w.balance = await safeCall(state.readProvider.getBalance(w.address), null);
  }));
  renderWallets(); updateFireButtons();
}

function clearWallets() {
  if (state.wallets.length && !confirm("確定清除所有已載入的私鑰？此動作會把它們從記憶體移除。")) return;
  // 🔒 直接丟棄含私鑰的物件，交給 GC 回收。
  state.wallets = [];
  dom.pkInput.value = "";
  disarm("已清除所有錢包");
  log("已清除所有私鑰（記憶體移除）", "warn");
  renderWallets(); updateSummary(); updateFireButtons();
}

function statusBadge(w) {
  const map = {
    idle: ["待命", "idle"], signing: ["簽名中", "pending"], pending: ["廣播中", "pending"],
    mining: ["上鏈中", "pending"], success: ["成功", "ok"], fail: ["失敗", "danger"],
  };
  const [txt, cls] = map[w.status] || ["—", ""];
  return `<span class="wstatus tone-${cls}">${txt}</span>`;
}

function renderWallets() {
  const tb = dom.walletTbody;
  dom.walletCount.textContent = `${state.wallets.length} 錢包`;
  if (state.wallets.length === 0) {
    tb.innerHTML = `<tr class="empty-row"><td colspan="6">尚未載入任何錢包。貼私鑰或按「產生測試錢包」。</td></tr>`;
    return;
  }
  const data = state.data;
  const allowlistPhase = data?.phase?.phaseType === 1;
  tb.innerHTML = "";
  state.wallets.forEach((w, i) => {
    const tr = document.createElement("tr");
    let alCell = "—";
    if (allowlistPhase) {
      if (w.proof && w.proofFor === proofKeyFor(w)) alCell = `<span class="wstatus tone-ok">✓ ${w.proof.length}</span>`;
      else if (w.proofFor === proofKeyFor(w) && w.proof === null) alCell = `<span class="wstatus tone-danger">不在名單</span>`;
      else alCell = `<span class="wstatus">未查</span>`;
    }
    let txCell = "—";
    if (w.txHash) txCell = `<a href="${EXPLORER}/tx/${w.txHash}" target="_blank" rel="noopener noreferrer">${w.txHash.slice(0, 8)}… ↗</a>`;
    else if (w.error) txCell = `<span class="err-cell" title="${w.error.replace(/"/g, "'")}">${w.error}</span>`;
    tr.innerHTML = `<td class="mono">${i + 1}</td>` +
      `<td class="mono">${shortAddr(w.address)}</td>` +
      `<td class="mono">${w.balance != null ? fmtEth(w.balance) : "…"}</td>` +
      `<td>${alCell}</td>` +
      `<td>${statusBadge(w)}</td>` +
      `<td class="mono">${txCell}</td>`;
    tb.appendChild(tr);
  });
}

// -------------------------------------------------------------- 數量 / 成本
function perAddressCap(data) {
  const caps = [];
  if (data.maxPerTx > 0) caps.push(data.maxPerTx);
  if (data.phase && data.phase.maxPerAddress > 0) caps.push(data.phase.maxPerAddress);
  return caps.length ? Math.min(...caps) : 99;
}

function updateQuantityBounds() {
  const data = state.data;
  const cap = data ? perAddressCap(data) : 99;
  dom.qtyMaxHint.textContent = `每錢包上限 ${cap}`;
  dom.qtyInput.max = String(cap);
  if (state.quantity > cap) state.quantity = cap;
  if (state.quantity < 1) state.quantity = 1;
  dom.qtyInput.value = String(state.quantity);
}

function setQuantity(q) {
  const data = state.data;
  const cap = data ? perAddressCap(data) : 99;
  state.quantity = Math.min(Math.max(q, 1), cap);
  dom.qtyInput.value = String(state.quantity);
  updateSummary();
}

function unitCost() {
  const data = state.data;
  if (!data || !data.phase) return 0n;
  return data.phase.mintPrice + data.collectorFee;
}

function updateSummary() {
  const n = state.wallets.length;
  const per = unitCost() * BigInt(Math.max(state.quantity, 0));
  dom.sumWallets.textContent = String(n);
  dom.sumPerWallet.textContent = fmtEth(per);
  dom.sumTotal.textContent = fmtEth(per * BigInt(n));
}

// -------------------------------------------------------------- gas
async function buildGasParams() {
  const gasLimit = BigInt(Math.max(parseInt(dom.gasLimitInput.value, 10) || 250000, 21000));
  if (dom.gasMode.value === "manual") {
    return {
      gasLimit,
      maxFeePerGas: ethers.parseUnits(String(dom.maxFeeInput.value || "0.2"), "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits(String(dom.prioFeeInput.value || "0"), "gwei"),
    };
  }
  // auto：讀鏈上 baseFee，maxFee = baseFee × 倍率 + priority
  const mult = Math.max(parseFloat(dom.autoMult.value) || 2, 1);
  const block = await state.readProvider.getBlock("latest");
  const base = block?.baseFeePerGas ?? ethers.parseUnits("0.1", "gwei");
  const prio = ethers.parseUnits(String(dom.prioFeeInput.value || "0"), "gwei");
  // 用 ×100 定點乘法支援小數倍率
  const maxFee = (base * BigInt(Math.round(mult * 100))) / 100n + prio;
  return { gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio };
}

// -------------------------------------------------------------- allowlist proof
function proofKeyFor(w) {
  return `${state.contractAddress}|${dom.phaseNameInput.value.trim()}|${w.address.toLowerCase()}`;
}

async function fetchAllProofs() {
  const phaseName = dom.phaseNameInput.value.trim();
  if (!phaseName) { dom.allowlistStatus.textContent = "請先輸入 phase 名稱。"; dom.allowlistStatus.dataset.tone = "error"; return; }
  if (state.wallets.length === 0) { dom.allowlistStatus.textContent = "尚未載入錢包。"; dom.allowlistStatus.dataset.tone = "error"; return; }
  dom.allowlistStatus.textContent = "查詢中…"; dom.allowlistStatus.dataset.tone = "pending";
  let ok = 0, no = 0;
  await Promise.all(state.wallets.map(async (w) => {
    // 只把「地址」帶進 URL 查 merkle proof；私鑰不參與。
    const url = `${MERKLE_PROOF_API}?collectionAddress=${state.contractAddress.toLowerCase()}&name=${encodeURIComponent(phaseName)}&address=${w.address.toLowerCase()}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const proof = json?.proof ?? json?.data?.proof ?? (Array.isArray(json) ? json : null);
      w.proofFor = proofKeyFor(w);
      if (Array.isArray(proof)) { w.proof = proof; ok++; } else { w.proof = null; no++; }
    } catch { w.proof = null; w.proofFor = proofKeyFor(w); no++; }
  }));
  dom.allowlistStatus.textContent = `完成：${ok} 個在名單、${no} 個不在/失敗。`;
  dom.allowlistStatus.dataset.tone = ok ? "ok" : "error";
  log(`白名單 proof 抓取：${ok} 成功 / ${no} 失敗`, ok ? "ok" : "warn");
  renderWallets();
}

// -------------------------------------------------------------- 開火（核心）
// 對單一錢包：本機組交易 → 本機簽名 → 廣播已簽 rawTx。
// gas 由 fireAll 一次算好傳入（避免每個錢包各打一次 getBlock，搶鑄時省 RPC、更快）。
async function fireOne(w, gas) {
  const data = state.data;
  const qty = state.quantity;
  const value = unitCost() * BigInt(qty);
  const isAllowlist = data.phase.phaseType === 1;

  let calldata;
  if (isAllowlist) {
    if (!w.proof || w.proofFor !== proofKeyFor(w)) throw new Error("無有效 merkle proof");
    calldata = iface.encodeFunctionData("allowlistMint", [qty, w.proof]);
  } else {
    calldata = iface.encodeFunctionData("mint", [qty]);
  }

  const nonce = await state.readProvider.getTransactionCount(w.address, "pending");

  // 完整組好的 EIP-1559 交易（不含 from，簽名時由私鑰推導）
  const txReq = {
    to: state.contractAddress,
    data: calldata,
    value,
    nonce,
    gasLimit: gas.gasLimit,
    maxFeePerGas: gas.maxFeePerGas,
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    chainId: CHAIN_ID,
    type: 2,
  };

  w.status = "signing"; w.error = null; renderWallets();
  // 🔒 本機簽名：ethers 用記憶體中的私鑰把交易簽成 rawTx 字串。純本機計算，無網路。
  const signedRawTx = await w.wallet.signTransaction(txReq);

  w.status = "pending"; renderWallets();
  // 🔒 唯一離開瀏覽器的機密相關資料：已簽好的 rawTx，送往使用者設定的 RPC。
  const resp = await state.readProvider.broadcastTransaction(signedRawTx);
  w.txHash = resp.hash;
  w.status = "mining"; renderWallets();
  log(`${shortAddr(w.address)} 已廣播 tx ${resp.hash.slice(0, 10)}…`, "");

  const receipt = await resp.wait();
  if (receipt && receipt.status === 1) { w.status = "success"; log(`${shortAddr(w.address)} 鑄造成功 ✓`, "ok"); }
  else { w.status = "fail"; w.error = "reverted"; log(`${shortAddr(w.address)} 交易 revert`, "danger"); }
  renderWallets();
}

async function fireAll(reason) {
  const data = state.data;
  if (!data || !data.phase) { showToast("尚無可鑄造的 phase。"); return; }
  if (state.wallets.length === 0) { showToast("尚未載入任何錢包。"); return; }
  if (state.firing) return;
  state.firing = true;
  updateFireButtons();
  log(`🔥 批量開火（${reason}）：${state.wallets.length} 錢包 × 數量 ${state.quantity}`, "warn");

  // gas 只算一次，全錢包共用。
  let gas;
  try { gas = await buildGasParams(); }
  catch (e) { log("gas 參數計算失敗：" + shortErr(e), "danger"); state.firing = false; updateFireButtons(); return; }

  // 全錢包並發：各自獨立簽名 + 廣播，一個失敗不影響其他。
  const results = await Promise.allSettled(state.wallets.map((w) => fireOne(w, gas).catch((e) => {
    w.status = "fail"; w.error = shortErr(e); renderWallets();
    log(`${shortAddr(w.address)} 失敗：${w.error}`, "danger");
    throw e;
  })));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  log(`批量開火結束：${ok}/${state.wallets.length} 成功送出`, ok ? "ok" : "danger");
  showToast(`開火結束：${ok}/${state.wallets.length} 成功`);
  state.firing = false;
  updateFireButtons();
}

function maybeAutoFire() {
  if (!state.armed || state.firing) return;
  const data = state.data;
  if (!computeIsActive(data.phase, data)) return;
  if (state.firedForPhase === data.currentPhaseId) return; // 此 phase 已開過火
  state.firedForPhase = data.currentPhaseId;
  log(`🎯 偵測到 PHASE ${data.currentPhaseId} 進入 LIVE → 自動開火`, "ok");
  showToast("🎯 開賣偵測到，自動批量開火！");
  fireAll("自動偵測");
}

// -------------------------------------------------------------- ARM / DISARM
function arm() {
  const data = state.data;
  if (state.wallets.length === 0) { showToast("先載入錢包再待命。"); return; }
  if (!data || !data.phase) { showToast("尚無 phase，無法待命。"); return; }
  state.armed = true;
  state.firedForPhase = null;
  log(`⏻ 已進入待命：偵測到 PHASE ${data.currentPhaseId} 開賣即自動批量開火（輪詢 ${POLL_MS_ARMED / 1000}s）`, "warn");
  startPolling();          // 切到較快輪詢
  updateFireButtons();
  maybeAutoFire();         // 若當下已 LIVE，立即開火
}

function disarm(reason) {
  if (!state.armed) { updateFireButtons?.(); return; }
  state.armed = false;
  log(`⏹ 解除待命${reason ? "（" + reason + "）" : ""}`, "");
  startPolling();          // 回到慢輪詢
  updateFireButtons();
}

// -------------------------------------------------------------- 按鈕狀態
function updateFireButtons() {
  const data = state.data;
  const hasWallets = state.wallets.length > 0;
  const hasPhase = !!(data && data.phase);
  const isActive = data ? computeIsActive(data.phase, data) : false;

  dom.armBtn.disabled = !hasWallets || !hasPhase || state.firing;
  dom.armBtn.textContent = state.armed ? "⏹ DISARM 解除待命" : "⏻ ARM 待命自動搶";
  dom.armBtn.dataset.armed = String(state.armed);

  dom.fireBtn.disabled = !hasWallets || !hasPhase || state.firing;
  dom.fireBtn.textContent = state.firing ? "開火中…" : "🔥 立即批量開火";

  let hint = "";
  if (!hasWallets) hint = "先載入至少一個燃燒錢包。";
  else if (!hasPhase) hint = "先 LOAD 目標合約、等待鏈上 phase 讀取。";
  else if (data.didMintEnd) hint = "此合約已售罄結束——開火會 revert（適合拿測試錢包驗流程）。";
  else if (data.phase.phaseType === 1) hint = "白名單 phase：先為所有錢包抓 proof 再開火。";
  else if (!isActive) hint = "目前非 LIVE。可先『ARM 待命』，開賣自動開火；或『立即開火』手動測試。";
  else hint = "🟢 LIVE！可立即批量開火。";
  dom.fireHint.textContent = hint;
}

// -------------------------------------------------------------- 事件綁定
function wire() {
  dom.settingsBtn.addEventListener("click", () => { dom.rpcInput.value = state.rpcUrl; dom.settingsDialog.showModal(); });
  dom.resetRpcBtn.addEventListener("click", () => { dom.rpcInput.value = DEFAULT_RPC; });
  dom.settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    state.rpcUrl = dom.rpcInput.value.trim() || DEFAULT_RPC;
    dom.settingsDialog.close();
    loadContract();
  });

  dom.loadBtn.addEventListener("click", loadContract);
  dom.contractInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadContract(); });

  dom.loadWalletsBtn.addEventListener("click", loadWalletsFromTextarea);
  dom.genTestBtn.addEventListener("click", genTestWallet);
  dom.refreshBalBtn.addEventListener("click", refreshBalances);
  dom.clearWalletsBtn.addEventListener("click", clearWallets);

  dom.qtyMinus.addEventListener("click", () => setQuantity(state.quantity - 1));
  dom.qtyPlus.addEventListener("click", () => setQuantity(state.quantity + 1));
  dom.qtyInput.addEventListener("change", () => setQuantity(parseInt(dom.qtyInput.value, 10) || 1));

  dom.gasMode.addEventListener("change", () => {
    const manual = dom.gasMode.value === "manual";
    document.querySelectorAll(".manual-gas").forEach((n) => n.dataset.manual = manual ? "1" : "0");
    dom.autoMultField.style.display = manual ? "none" : "";
  });

  dom.fetchProofsBtn.addEventListener("click", fetchAllProofs);

  dom.armBtn.addEventListener("click", () => { state.armed ? disarm("手動") : arm(); });
  dom.fireBtn.addEventListener("click", () => {
    const data = state.data;
    const per = unitCost() * BigInt(state.quantity);
    const total = per * BigInt(state.wallets.length);
    const msg = `即將用 ${state.wallets.length} 個錢包各鑄 ${state.quantity} 個。\n` +
      `每錢包成本 ${fmtEth(per)}，總計約 ${fmtEth(total)}（不含 gas）。\n` +
      (data?.didMintEnd ? "⚠ 此合約已售罄，交易會 revert。\n" : "") + "確定送出？";
    if (!confirm(msg)) return;
    fireAll("手動");
  });

  dom.clearLogBtn.addEventListener("click", () => { dom.logBody.innerHTML = ""; });
}

function startTicking() {
  state.tickTimer = setInterval(() => { if (state.data) render(); }, 1000);
}

function boot() {
  dom.rpcInput.value = state.rpcUrl;
  dom.contractInput.value = state.contractAddress;
  dom.autoMultField.style.display = "";
  wire();
  startTicking();
  loadContract();
  log("主控台就緒。私鑰只在本機記憶體，零外傳。", "ok");
}

boot();
