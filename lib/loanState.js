"use strict";

// 借用状态流转：只负责记录长什么样、状态如何迁移，不读文件、不做借展判定。
//
// 状态机：
//   active（借出中）
//     ├─ 按期/提前归还 ───────────────> returned（已归还，占用释放）
//     └─ 逾期归还 ───────────────────> pending_review（待复核）
//                                         └─ 补齐延迟原因并复核通过 ─> reviewed（已复核，可再借）
//   运输状态 shippingStatus 与借出状态相互独立，随时可更新。

const STATUS = {
  ACTIVE: "active",
  RETURNED: "returned",
  PENDING_REVIEW: "pending_review",
  REVIEWED: "reviewed"
};

const SHIPPING_STATUS = {
  PENDING: "pending", // 待发货
  IN_TRANSIT: "in_transit", // 在途
  DELIVERED: "delivered", // 已送达
  RETURNED: "returned" // 运回
};

function statusError(message, status = 409, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function createLoan(fields, nowIso) {
  return {
    id: fields.id,
    tuneId: fields.tuneId,
    borrower: fields.borrower,
    startDate: fields.startDate,
    endDate: fields.endDate,
    shippingStatus: fields.shippingStatus || SHIPPING_STATUS.PENDING,
    status: STATUS.ACTIVE,
    note: fields.note || "",
    appliedAt: nowIso,
    returnedDate: null,
    returnedAt: null,
    overdue: false,
    delayReason: "",
    reviewedAt: null,
    reviewedBy: "",
    reviewNote: ""
  };
}

// 登记归还。returnedDate 缺省取今天；晚于 endDate 即逾期，转待复核。
// 提前/按期归还立即释放占用（status=returned，带 returnedDate）。
function registerReturn(loan, body = {}, nowIso, todayDay) {
  if (loan.status !== STATUS.ACTIVE) {
    throw statusError("该借用记录不是借出中状态，不能重复归还", 409, "LOAN_NOT_ACTIVE");
  }

  const returnedDate = todayDay;
  if (!returnedDate) {
    throw statusError("归还日期必须是合法日期（YYYY-MM-DD）", 400, "INVALID_DATE");
  }

  const overdue = returnedDate > loan.endDate;
  loan.returnedDate = returnedDate;
  loan.returnedAt = nowIso;
  loan.overdue = overdue;
  loan.status = overdue ? STATUS.PENDING_REVIEW : STATUS.RETURNED;

  if (body.delayReason !== undefined) {
    loan.delayReason = String(body.delayReason);
  }
  if (body.shippingStatus !== undefined) {
    loan.shippingStatus = String(body.shippingStatus);
  }
  if (body.note !== undefined) {
    loan.note = String(body.note);
  }

  if (overdue && !loan.delayReason.trim()) {
    // 允许先归还、后补原因；但复核前必须补齐，且此期间母版不可再借。
    loan.reviewNote = "逾期归还，请补齐延迟原因后复核";
  }

  return loan;
}

// 逾期复核：必须已有延迟原因（可在本次请求中一并补齐），复核通过后置为 reviewed。
function reviewLoan(loan, body = {}, nowIso) {
  if (loan.status !== STATUS.PENDING_REVIEW) {
    throw statusError("只有待复核的逾期归还记录可以复核", 409, "LOAN_NOT_PENDING_REVIEW");
  }

  if (body.delayReason !== undefined) {
    loan.delayReason = String(body.delayReason);
  }
  if (!loan.delayReason || !loan.delayReason.trim()) {
    throw statusError("请先补齐逾期延迟原因再复核", 400, "DELAY_REASON_REQUIRED");
  }

  if (body.approved === false) {
    loan.reviewedBy = body.reviewedBy !== undefined ? String(body.reviewedBy) : loan.reviewedBy;
    loan.reviewNote = body.note !== undefined ? String(body.note) : loan.reviewNote;
    return loan; // 复核不通过：维持待复核，继续阻断再借
  }

  loan.status = STATUS.REVIEWED;
  loan.reviewedAt = nowIso;
  loan.reviewedBy = body.reviewedBy !== undefined ? String(body.reviewedBy) : "";
  loan.reviewNote = body.note !== undefined ? String(body.note) : loan.reviewNote;
  return loan;
}

// 运输状态 / 延迟原因 / 备注的常规更新，不允许从这里直接改借出状态。
function updateLoan(loan, body = {}) {
  if (body.shippingStatus !== undefined) loan.shippingStatus = String(body.shippingStatus);
  if (body.delayReason !== undefined) loan.delayReason = String(body.delayReason);
  if (body.note !== undefined) loan.note = String(body.note);
  if (body.reviewedBy !== undefined) loan.reviewedBy = String(body.reviewedBy);
  return loan;
}

module.exports = {
  STATUS,
  SHIPPING_STATUS,
  createLoan,
  registerReturn,
  reviewLoan,
  updateLoan
};
