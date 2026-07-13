// ============================================================================
// phaseUtils — 「選擇 Phase」模式的純函式（下拉選單標籤 / 時間窗狀態判定）。
// 刻意與 DOM / ethers / 網路完全無關，方便用 `node --test` 直接單元測試，
// 也讓 app.js 的 render 邏輯保持單一事實來源（不重複判斷式）。
// ============================================================================

// phaseType 映射（僅供「選擇 Phase」下拉選單用；ACTIVE PHASE 卡沿用既有 PHASE_TYPE_LABEL，
// 兩者刻意分開，避免互相牽動造成回歸風險）。
// 未知型別一律顯示原始數字，不亂猜語意。
export function dropdownPhaseTypeLabel(phaseType) {
  if (phaseType === 0) return "公開 Public";
  if (phaseType === 1) return "白名單 Allowlist";
  return `type ${phaseType}`;
}

// phase 時間窗狀態：未開始 / 進行中 / 已結束。
// startTime===0 且 endTime===0 代表合約尚未排程此 phase 時間 → 視為「未開始」。
export function phaseWindowState(phase, nowSec) {
  if (!phase) return "ended";
  if (phase.startTime === 0 && phase.endTime === 0) return "upcoming";
  if (nowSec < phase.startTime) return "upcoming";
  if (nowSec < phase.endTime) return "live";
  return "ended";
}

export const PHASE_WINDOW_LABEL = {
  upcoming: "未開始",
  live: "進行中",
  ended: "已結束",
};

// 下拉選單單一 option 的顯示文字。
// priceEthStr：呼叫端先用 ethers.formatEther 算好的字串（此檔不碰 ethers，維持純函式）。
export function formatPhaseOptionLabel(index, phase, priceEthStr, currentPhaseId, nowSec) {
  const typeLabel = dropdownPhaseTypeLabel(phase.phaseType);
  const capLabel = phase.maxPerAddress > 0 ? String(phase.maxPerAddress) : "無上限";
  const supplyLabel = phase.maxSupply || "?";
  const windowLabel = PHASE_WINDOW_LABEL[phaseWindowState(phase, nowSec)];
  const current = index === currentPhaseId ? " ★目前" : "";
  return `Phase ${index} · ${typeLabel} · ${priceEthStr} ETH · 每址上限 ${capLabel} · ${phase.mintedInPhase}/${supplyLabel} · ${windowLabel}${current}`;
}
