"use strict";

// 借展判定：纯函数模块，只负责“能不能借 / 是否在借 / 时间是否重叠”，
// 不负责状态如何流转，也不负责落盘保存。

// 借出状态与 lib/loanState.js 中的 STATUS 保持一致；此处只取判定用到的两个。
const ACTIVE = "active";
const PENDING_REVIEW = "pending_review";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 统一成 YYYY-MM-DD（兼容传入完整 ISO 字符串）；非法日期返回 null。
function toDay(value) {
  if (value === undefined || value === null || value === "") return null;
  const head = String(value).slice(0, 10);
  if (!DATE_RE.test(head)) return null;
  const date = new Date(`${head}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== head) return null;
  return head;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// 闭区间判定：两个借展日期区间只要有一天重合就算重叠。
function rangesOverlap(startA, endA, startB, endB) {
  return startA <= endB && startB <= endA;
}

// 占用母版的记录：已借出且未登记归还（提前归还后不再占用）。
function isOccupying(loan) {
  return loan.status === ACTIVE && !loan.returnedDate;
}

function occupyingLoans(db, tuneId) {
  return (db.loans || []).filter((loan) => loan.tuneId === tuneId && isOccupying(loan));
}

function hasOpenIssues(db, tuneId) {
  return db.issues.some((item) => item.tuneId === tuneId && item.status !== "resolved");
}

function hasUnfinishedSections(db, tuneId) {
  return db.sections.some((item) => item.tuneId === tuneId && !item.checked);
}

// 逾期归还后尚未复核通过的记录：复核前不允许再次外借。
function findPendingReviewLoan(db, tuneId) {
  return (db.loans || []).find((loan) => loan.tuneId === tuneId && loan.status === PENDING_REVIEW) || null;
}

// 借出期间判定：已生效（已到起始日）且尚未归还的外借记录会锁住母版。
// 起始日在未来的预约不拦当前打孔；超过应还日仍未归还的，依然视为借出中。
function findActiveLoanForToday(db, tuneId, day = today()) {
  return (
    occupyingLoans(db, tuneId).find((loan) => loan.startDate <= day) || null
  );
}

// 借展申请整单判定：返回 { ok, reasons, startDate, endDate }。
// 旧曲目没有任何借用记录时，下面与借用相关的检查自然全部通过，即按可借处理。
function evaluateLoanApplication(db, tuneId, input) {
  const reasons = [];
  const startDate = toDay(input.startDate);
  const endDate = toDay(input.endDate);

  if (!startDate || !endDate) {
    reasons.push({ code: "INVALID_DATE", message: "起止日期必须是合法日期（YYYY-MM-DD）" });
  } else if (startDate > endDate) {
    reasons.push({ code: "INVALID_DATE_RANGE", message: "起始日期不能晚于截止日期" });
  }

  if (hasOpenIssues(db, tuneId)) {
    reasons.push({ code: "OPEN_ISSUES", message: "母版仍有未解决的试奏问题" });
  }

  if (hasUnfinishedSections(db, tuneId)) {
    reasons.push({ code: "UNFINISHED_SECTIONS", message: "母版仍有未完成（未校对）的纸带区间" });
  }

  const pendingReview = findPendingReviewLoan(db, tuneId);
  if (pendingReview) {
    reasons.push({
      code: "PENDING_REVIEW",
      message: "上一次逾期归还尚待复核，补齐延迟原因并复核后才能再借",
      loanId: pendingReview.id
    });
  }

  if (startDate && endDate) {
    const conflict = occupyingLoans(db, tuneId).find((loan) =>
      rangesOverlap(startDate, endDate, loan.startDate, loan.endDate)
    );
    if (conflict) {
      reasons.push({
        code: "LOAN_OVERLAP",
        message: `借展日期与借用记录 ${conflict.id} 重叠`,
        loanId: conflict.id
      });
    }
  }

  return { ok: reasons.length === 0, reasons, startDate, endDate };
}

module.exports = {
  toDay,
  today,
  rangesOverlap,
  isOccupying,
  occupyingLoans,
  hasOpenIssues,
  hasUnfinishedSections,
  findPendingReviewLoan,
  findActiveLoanForToday,
  evaluateLoanApplication
};
