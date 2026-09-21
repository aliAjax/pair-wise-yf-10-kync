const http = require("http");
const { readDb, withTransaction, makeId } = require("./lib/store");
const loanPolicy = require("./lib/loanPolicy");
const {
  STATUS,
  SHIPPING_STATUS,
  createLoan,
  registerReturn,
  reviewLoan,
  updateLoan
} = require("./lib/loanState");

const PORT = Number(process.env.PORT || 3019);

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /loans?tuneId=&status=",
  "GET /tunes/:id/loans",
  "POST /tunes/:id/loans",
  "GET /loans/:id",
  "PATCH /loans/:id",
  "POST /loans/:id/return",
  "POST /loans/:id/review"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) throw httpError(404, "曲目不存在", "TUNE_NOT_FOUND");
  return tune;
}

function findLoan(db, loanId) {
  const loan = db.loans.find((item) => item.id === loanId);
  if (!loan) throw httpError(404, "借用记录不存在", "LOAN_NOT_FOUND");
  return loan;
}

// 借出期间保护：正在借出时禁止打孔（登记试奏问题）和修改/新增纸带区间。
// 在事务内、写盘前调用，整单失败即不写盘，原记录不变。
function assertNotOnLoan(db, tuneId, action) {
  const activeLoan = loanPolicy.findActiveLoanForToday(db, tuneId);
  if (activeLoan) {
    throw httpError(
      409,
      `母版借出期间${action}，当前借用记录：${activeLoan.id}（借出方：${activeLoan.borrower}）`,
      "TUNE_ON_LOAN"
    );
  }
}

function loanSummary(db, tuneId) {
  const records = db.loans.filter((loan) => loan.tuneId === tuneId);
  const activeLoan = loanPolicy.findActiveLoanForToday(db, tuneId);
  const pendingReview = loanPolicy.findPendingReviewLoan(db, tuneId);
  return {
    loanCount: records.length,
    onLoan: Boolean(activeLoan),
    activeLoanId: activeLoan ? activeLoan.id : null,
    pendingReview: Boolean(pendingReview),
    pendingReviewLoanId: pendingReview ? pendingReview.id : null
  };
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0,
    loan: loanSummary(db, tuneId)
  };
}

// 字段兼容：接受历史/别名字段，统一映射到当前字段名。
function normalizeLoanInput(body) {
  return {
    borrower: body.borrower ?? body.borrowerName ?? body.lender ?? "",
    startDate: body.startDate ?? body.from ?? body.borrowDate,
    endDate: body.endDate ?? body.to ?? body.dueDate,
    shippingStatus: body.shippingStatus ?? body.transportStatus ?? SHIPPING_STATUS.PENDING,
    note: body.note ?? ""
  };
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const db = await readDb();
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = await withTransaction((db) => {
      const record = {
        id: makeId("tune"),
        title: body.title,
        composer: body.composer || "",
        stripSpec: body.stripSpec,
        createdAt: new Date().toISOString()
      };
      db.tunes.push(record);
      return record;
    });
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    const db = await readDb();
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = await withTransaction((db) => {
      findTune(db, tuneId);
      assertNotOnLoan(db, tuneId, "禁止新增纸带区间");
      const record = {
        id: makeId("section"),
        tuneId,
        startBeat: Number(body.startBeat),
        endBeat: Number(body.endBeat),
        laneRange: body.laneRange,
        checked: Boolean(body.checked),
        note: body.note || ""
      };
      db.sections.push(record);
      return record;
    });
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    const db = await readDb();
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const tuneLoansMatch = pathname.match(/^\/tunes\/([^/]+)\/loans$/);
  if (tuneLoansMatch && req.method === "GET") {
    const tuneId = tuneLoansMatch[1];
    const db = await readDb();
    findTune(db, tuneId);
    return send(res, 200, { data: db.loans.filter((item) => item.tuneId === tuneId) });
  }

  // 母版外借申请：任何一项条件不满足都整单拒绝，不写盘，原记录不变。
  if (tuneLoansMatch && req.method === "POST") {
    const tuneId = tuneLoansMatch[1];
    const body = normalizeLoanInput(await parseBody(req));
    required(body, ["borrower", "startDate", "endDate"]);
    try {
      const loan = await withTransaction((db) => {
        findTune(db, tuneId);
        const decision = loanPolicy.evaluateLoanApplication(db, tuneId, body);
        if (!decision.ok) {
          // 抛出即放弃本事务，不会写盘：原记录保持不变。
          const error = httpError(
            409,
            "借用申请被拒绝：" + decision.reasons.map((reason) => reason.message).join("；"),
            "LOAN_REJECTED"
          );
          error.reasons = decision.reasons;
          throw error;
        }
        const record = createLoan(
          {
            id: makeId("loan"),
            tuneId,
            borrower: body.borrower,
            startDate: decision.startDate,
            endDate: decision.endDate,
            shippingStatus: body.shippingStatus,
            note: body.note
          },
          new Date().toISOString()
        );
        db.loans.push(record);
        return record;
      });
      return send(res, 201, { data: loan });
    } catch (error) {
      if (error.code === "LOAN_REJECTED") {
        return send(res, 409, { error: error.message, code: error.code, reasons: error.reasons });
      }
      throw error;
    }
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    const db = await readDb();
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const sectionId = checkMatch[1];
    const body = await parseBody(req);
    const section = await withTransaction((db) => {
      const record = db.sections.find((item) => item.id === sectionId);
      if (!record) throw httpError(404, "区间不存在", "SECTION_NOT_FOUND");
      assertNotOnLoan(db, record.tuneId, "禁止修改纸带区间");
      record.checked = body.checked !== undefined ? Boolean(body.checked) : true;
      record.note = body.note ?? record.note;
      return record;
    });
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const db = await readDb();
    const issues = db.issues.filter(
      (item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status)
    );
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    const issue = await withTransaction((db) => {
      findTune(db, body.tuneId);
      const section = db.sections.find(
        (item) => item.id === body.sectionId && item.tuneId === body.tuneId
      );
      if (!section) throw httpError(400, "区间不存在或不属于该曲目", "SECTION_MISMATCH");
      assertNotOnLoan(db, body.tuneId, "禁止打孔（登记试奏问题）");
      const record = {
        id: makeId("issue"),
        tuneId: body.tuneId,
        sectionId: body.sectionId,
        type: body.type,
        beat: body.beat === undefined ? null : Number(body.beat),
        lane: body.lane === undefined ? null : Number(body.lane),
        description: body.description,
        status: "open",
        createdAt: new Date().toISOString(),
        resolvedAt: null
      };
      db.issues.push(record);
      return record;
    });
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issueId = issueStatusMatch[1];
    const body = await parseBody(req);
    required(body, ["status"]);
    const issue = await withTransaction((db) => {
      const record = db.issues.find((item) => item.id === issueId);
      if (!record) throw httpError(404, "问题不存在", "ISSUE_NOT_FOUND");
      record.status = body.status;
      record.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
      record.note = body.note ?? record.note;
      return record;
    });
    return send(res, 200, { data: issue });
  }

  if (req.method === "GET" && pathname === "/loans") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const db = await readDb();
    const loans = db.loans.filter(
      (item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status)
    );
    return send(res, 200, { data: loans });
  }

  const loanDetailMatch = pathname.match(/^\/loans\/([^/]+)$/);
  if (loanDetailMatch && req.method === "GET") {
    const db = await readDb();
    return send(res, 200, { data: findLoan(db, loanDetailMatch[1]) });
  }

  // 运输状态 / 延迟原因 / 备注的常规更新（状态流转不允许从这里改）。
  if (loanDetailMatch && req.method === "PATCH") {
    const loanId = loanDetailMatch[1];
    const body = await parseBody(req);
    const loan = await withTransaction((db) => {
      const record = findLoan(db, loanId);
      return updateLoan(record, body);
    });
    return send(res, 200, { data: loan });
  }

  const loanReturnMatch = pathname.match(/^\/loans\/([^/]+)\/return$/);
  if (loanReturnMatch && req.method === "POST") {
    const loanId = loanReturnMatch[1];
    const body = await parseBody(req);
    const returnedDate = loanPolicy.toDay(body.returnedDate) || loanPolicy.today();
    const loan = await withTransaction((db) => {
      const record = findLoan(db, loanId);
      return registerReturn(record, body, new Date().toISOString(), returnedDate);
    });
    return send(res, 200, { data: loan });
  }

  const loanReviewMatch = pathname.match(/^\/loans\/([^/]+)\/review$/);
  if (loanReviewMatch && req.method === "POST") {
    const loanId = loanReviewMatch[1];
    const body = await parseBody(req);
    const loan = await withTransaction((db) => {
      const record = findLoan(db, loanId);
      return reviewLoan(record, body, new Date().toISOString());
    });
    return send(res, 200, { data: loan });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, {
      error: error.message || "服务器错误",
      code: error.code || "INTERNAL_ERROR"
    })
  );
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});

module.exports = { server, STATUS, SHIPPING_STATUS };
