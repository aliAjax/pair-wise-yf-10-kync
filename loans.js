"use strict";

// 母版借展：纯领域逻辑（借展判定 + 状态流转），不触碰持久化与HTTP。
// 状态机：
//   requested（已登记，待寄出）
//     -> loaned（在展，运输状态变为已送达）
//     -> returned（按时/提前归还，占用释放，可立即再借）
//     -> review（逾期归还，待复核）
//   review -> returned（补齐延迟原因并复核通过，占用释放）
// 运输状态：preparing（备运中）/ inTransit（运输中）/ delivered（已送达）/ returnTransit（回运中）

const LOAN_STATUSES = ["requested", "loaned", "returned", "review"];
const SHIPPING_STATUSES = ["preparing", "inTransit", "delivered", "returnTransit"];
const ACTIVE_LOAN_STATUSES = ["requested", "loaned", "review"];

function toDay(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return value;
  return new Date(`${value}T00:00:00.000Z`);
}

function dayString(date) {
  return date.toISOString().slice(0, 10);
}

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// 半开区间重叠判定：[start, end)，借进/借出当日允许新单衔接。
function rangesOverlap(startA, endA, startB, endB) {
  return startA.getTime() < endB.getTime() && startB.getTime() < endA.getTime();
}

// 仍占用母版的借展单（未归还 或 逾期待复核）。
function activeLoans(db, tuneId) {
  const loans = db.loans || [];
  return loans.filter((loan) => loan.tuneId === tuneId && ACTIVE_LOAN_STATUSES.includes(loan.status));
}

// 给定日期区间是否落在任何占用中的借展期内。
function findOverlappingLoan(db, tuneId, startDate, endDate, excludeLoanId) {
  const start = toDay(startDate);
  const end = toDay(endDate);
  return activeLoans(db, tuneId).find((loan) => {
    if (excludeLoanId && loan.id === excludeLoanId) return false;
    return rangesOverlap(start, end, toDay(loan.startDate), toDay(loan.endDate));
  });
}

// 申请当日母版是否处于借出状态（用于打孔/区间修改拦截）。
function isOnLoanAt(db, tuneId, date = todayUtc()) {
  const day = toDay(date);
  const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  return activeLoans(db, tuneId).some(
    (loan) =>
      loan.status !== "review" &&
      rangesOverlap(day, nextDay, toDay(loan.startDate), toDay(loan.endDate))
  );
}

// 旧曲目无任何借用记录时按可借处理；有历史记录则沿用常规校验。
function loanBlockers(db, tuneId, startDate, endDate) {
  const blockers = [];

  // 逾期归还待复核的单子未闭环前，补齐原因并复核后才能再借。
  const reviewing = (db.loans || []).find(
    (loan) => loan.tuneId === tuneId && loan.status === "review"
  );
  if (reviewing) {
    blockers.push({
      code: "pending_review",
      message: `借用单 ${reviewing.id} 逾期归还待复核，复核通过前不可再借`,
      loanId: reviewing.id
    });
  }

  const openIssue = (db.issues || []).find(
    (issue) => issue.tuneId === tuneId && issue.status !== "resolved"
  );
  if (openIssue) blockers.push({ code: "open_issue", message: "母版存在未解决问题，暂不外借", issueId: openIssue.id });

  const unfinishedSection = (db.sections || []).find(
    (section) => section.tuneId === tuneId && !section.checked
  );
  if (unfinishedSection) {
    blockers.push({
      code: "unfinished_section",
      message: "存在未完成（未校对）区间，暂不外借",
      sectionId: unfinishedSection.id
    });
  }

  const overlap = findOverlappingLoan(db, tuneId, startDate, endDate);
  if (overlap) {
    blockers.push({
      code: "loan_overlap",
      message: `借展区间与借用单 ${overlap.id}（${overlap.startDate} ~ ${overlap.endDate}）重叠`,
      loanId: overlap.id
    });
  }

  return blockers;
}

function canBorrow(db, tuneId, startDate, endDate) {
  const blockers = loanBlockers(db, tuneId, startDate, endDate);
  return { ok: blockers.length === 0, blockers };
}

function validateApplication(body) {
  const errors = [];
  const borrower = (body.borrower || "").toString().trim();
  if (!borrower) errors.push("borrower");

  const start = toDay(body.startDate);
  const end = toDay(body.endDate);
  if (!body.startDate || Number.isNaN(start.getTime())) errors.push("startDate");
  if (!body.endDate || Number.isNaN(end.getTime())) errors.push("endDate");
  if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end.getTime() < start.getTime()) {
    errors.push("dateRange");
  }

  let shippingStatus = body.shippingStatus || "preparing";
  if (!SHIPPING_STATUSES.includes(shippingStatus)) {
    errors.push("shippingStatus");
    shippingStatus = "preparing";
  }
  return { errors, borrower, start, end, shippingStatus };
}

// 状态流转：登记借出。
function buildLoan(id, body, validated) {
  return {
    id,
    tuneId: body.tuneId,
    borrower: validated.borrower,
    startDate: dayString(validated.start),
    endDate: dayString(validated.end),
    shippingStatus: validated.shippingStatus,
    status: "requested",
    note: body.note || "",
    createdAt: new Date().toISOString(),
    loanedAt: null,
    returnedAt: null,
    overdue: false,
    delayReason: null,
    reviewedAt: null,
    reviewedBy: null
  };
}

// 状态流转：寄出/送达等运输与借出状态更新。
function markShipped(loan, body) {
  if (body.shippingStatus !== undefined) {
    if (!SHIPPING_STATUSES.includes(body.shippingStatus)) {
      const error = new Error(`运输状态无效，可选：${SHIPPING_STATUSES.join(", ")}`);
      error.status = 400;
      throw error;
    }
    loan.shippingStatus = body.shippingStatus;
  }
  if (loan.status === "requested" && (body.status === "loaned" || loan.shippingStatus === "delivered")) {
    loan.status = "loaned";
    loan.loanedAt = loan.loanedAt || new Date().toISOString();
  }
  if (body.note !== undefined) loan.note = body.note;
  return loan;
}

// 状态流转：归还。提前/按时 -> returned 立即释放；逾期 -> review 待复核。
function returnLoan(loan, body, date = todayUtc()) {
  if (loan.status === "returned") {
    const error = new Error("该借用单已归还");
    error.status = 409;
    throw error;
  }
  const returnDay = toDay(date);
  const overdue = returnDay.getTime() > toDay(loan.endDate).getTime();

  loan.returnedAt = new Date().toISOString();
  loan.shippingStatus = "returnTransit";

  if (overdue) {
    loan.overdue = true;
    loan.status = "review";
    loan.delayReason = body.delayReason || null;
  } else {
    loan.status = "returned";
    loan.overdue = false;
  }
  if (body.note !== undefined) loan.note = body.note;
  return loan;
}

// 状态流转：逾期单补齐延迟原因并复核；通过后释放占用，母版可再借。
function reviewLoan(loan, body) {
  if (loan.status !== "review") {
    const error = new Error("仅待复核的借用单可以复核");
    error.status = 409;
    throw error;
  }
  const delayReason = (body.delayReason ?? loan.delayReason ?? "").toString().trim();
  if (!delayReason) {
    const error = new Error("复核前必须补齐延迟原因");
    error.status = 400;
    throw error;
  }
  const approved = body.approved !== undefined ? Boolean(body.approved) : true;
  if (!approved) {
    const error = new Error("复核未通过，借用单仍处于待复核状态");
    error.status = 400;
    throw error;
  }
  loan.delayReason = delayReason;
  loan.status = "returned";
  loan.reviewedAt = new Date().toISOString();
  loan.reviewedBy = body.reviewedBy || null;
  if (body.note !== undefined) loan.note = body.note;
  return loan;
}

module.exports = {
  LOAN_STATUSES,
  SHIPPING_STATUSES,
  ACTIVE_LOAN_STATUSES,
  toDay,
  dayString,
  todayUtc,
  rangesOverlap,
  activeLoans,
  findOverlappingLoan,
  isOnLoanAt,
  loanBlockers,
  canBorrow,
  validateApplication,
  buildLoan,
  markShipped,
  returnLoan,
  reviewLoan
};
