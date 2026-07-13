// phaseUtils 純函式單元測試（無 DOM 依賴，用 Node 內建 test runner：node --test）
import test from "node:test";
import assert from "node:assert/strict";
import {
  dropdownPhaseTypeLabel,
  phaseWindowState,
  PHASE_WINDOW_LABEL,
  formatPhaseOptionLabel,
} from "../phaseUtils.js";

// -------------------------------------------------------------- dropdownPhaseTypeLabel
test("dropdownPhaseTypeLabel：0→公開 Public", () => {
  assert.equal(dropdownPhaseTypeLabel(0), "公開 Public");
});

test("dropdownPhaseTypeLabel：1→白名單 Allowlist", () => {
  assert.equal(dropdownPhaseTypeLabel(1), "白名單 Allowlist");
});

test("dropdownPhaseTypeLabel：未知型別顯示原始數字，不亂猜", () => {
  assert.equal(dropdownPhaseTypeLabel(2), "type 2");
  assert.equal(dropdownPhaseTypeLabel(99), "type 99");
});

// -------------------------------------------------------------- phaseWindowState
test("phaseWindowState：now < startTime → upcoming（未開始）", () => {
  const phase = { startTime: 1000, endTime: 2000 };
  assert.equal(phaseWindowState(phase, 500), "upcoming");
});

test("phaseWindowState：startTime <= now < endTime → live（進行中）", () => {
  const phase = { startTime: 1000, endTime: 2000 };
  assert.equal(phaseWindowState(phase, 1500), "live");
  assert.equal(phaseWindowState(phase, 1000), "live"); // 邊界：剛好開始
});

test("phaseWindowState：now >= endTime → ended（已結束）", () => {
  const phase = { startTime: 1000, endTime: 2000 };
  assert.equal(phaseWindowState(phase, 2000), "ended");
  assert.equal(phaseWindowState(phase, 9999), "ended");
});

test("phaseWindowState：startTime=0 且 endTime=0（尚未排程）→ upcoming", () => {
  const phase = { startTime: 0, endTime: 0 };
  assert.equal(phaseWindowState(phase, 500), "upcoming");
});

test("PHASE_WINDOW_LABEL：三態中文標籤齊全", () => {
  assert.equal(PHASE_WINDOW_LABEL.upcoming, "未開始");
  assert.equal(PHASE_WINDOW_LABEL.live, "進行中");
  assert.equal(PHASE_WINDOW_LABEL.ended, "已結束");
});

// -------------------------------------------------------------- formatPhaseOptionLabel
test("formatPhaseOptionLabel：公開 phase、進行中，格式與內容正確", () => {
  const phase = {
    phaseType: 0, startTime: 1000, endTime: 2000,
    maxPerAddress: 5, maxSupply: 1000, mintedInPhase: 42,
  };
  const label = formatPhaseOptionLabel(0, phase, "0.0500", 3, 1500);
  assert.equal(label, "Phase 0 · 公開 Public · 0.0500 ETH · 每址上限 5 · 42/1000 · 進行中");
});

test("formatPhaseOptionLabel：白名單 phase、未開始", () => {
  const phase = {
    phaseType: 1, startTime: 5000, endTime: 6000,
    maxPerAddress: 2, maxSupply: 300, mintedInPhase: 0,
  };
  const label = formatPhaseOptionLabel(1, phase, "0.0000", 3, 1000);
  assert.equal(label, "Phase 1 · 白名單 Allowlist · 0.0000 ETH · 每址上限 2 · 0/300 · 未開始");
});

test("formatPhaseOptionLabel：maxPerAddress=0 顯示「無上限」", () => {
  const phase = {
    phaseType: 0, startTime: 1000, endTime: 2000,
    maxPerAddress: 0, maxSupply: 1000, mintedInPhase: 10,
  };
  const label = formatPhaseOptionLabel(2, phase, "0.0200", 3, 1500);
  assert.match(label, /每址上限 無上限/);
});

test("formatPhaseOptionLabel：maxSupply=0 顯示「?」（沿用既有 UI 慣例）", () => {
  const phase = {
    phaseType: 0, startTime: 1000, endTime: 2000,
    maxPerAddress: 1, maxSupply: 0, mintedInPhase: 10,
  };
  const label = formatPhaseOptionLabel(2, phase, "0.0200", 3, 1500);
  assert.match(label, /10\/\?/);
});

test("formatPhaseOptionLabel：index === currentPhaseId → 附加 ★目前", () => {
  const phase = {
    phaseType: 0, startTime: 1000, endTime: 2000,
    maxPerAddress: 5, maxSupply: 1000, mintedInPhase: 42,
  };
  const label = formatPhaseOptionLabel(3, phase, "0.0500", 3, 1500);
  assert.match(label, /★目前$/);
});

test("formatPhaseOptionLabel：index !== currentPhaseId → 不附加 ★目前", () => {
  const phase = {
    phaseType: 0, startTime: 1000, endTime: 2000,
    maxPerAddress: 5, maxSupply: 1000, mintedInPhase: 42,
  };
  const label = formatPhaseOptionLabel(0, phase, "0.0500", 3, 1500);
  assert.doesNotMatch(label, /★目前/);
});

test("formatPhaseOptionLabel：已結束的 phase", () => {
  const phase = {
    phaseType: 0, startTime: 1000, endTime: 2000,
    maxPerAddress: 5, maxSupply: 1000, mintedInPhase: 1000,
  };
  const label = formatPhaseOptionLabel(0, phase, "0.0500", 3, 5000);
  assert.match(label, /已結束$/);
});
