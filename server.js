const http = require("http");
const store = require("./store");
const loans = require("./loans");

const PORT = Number(process.env.PORT || 3019);

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: new Date().toISOString()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
  ],
  // 新集合：旧 db.json 没有该字段时，读取阶段自动补空数组（老曲目按可借处理）。
  loans: []
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "GET /tunes/:id/loans",
  "POST /tunes/:id/loans",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /loans",
  "PATCH /loans/:id/shipping",
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

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

function findLoan(db, loanId) {
  const loan = (db.loans || []).find((item) => item.id === loanId);
  if (!loan) {
    const error = new Error("借用单不存在");
    error.status = 404;
    throw error;
  }
  return loan;
}

// 借出期间禁止打孔与修改区间。
function assertNotOnLoan(db, tuneId) {
  if (loans.isOnLoanAt(db, tuneId)) {
    const error = new Error("母版借出中，暂停打孔与区间修改");
    error.status = 409;
    throw error;
  }
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
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const db = await store.readRaw(initialData);
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = await store.withTransaction(initialData, (db) => {
      const created = {
        id: makeId("tune"),
        title: body.title,
        composer: body.composer || "",
        stripSpec: body.stripSpec,
        createdAt: new Date().toISOString()
      };
      db.tunes.push(created);
      return created;
    });
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    const db = await store.readRaw(initialData);
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = await store.withTransaction(initialData, (db) => {
      findTune(db, tuneId);
      assertNotOnLoan(db, tuneId);
      const created = {
        id: makeId("section"),
        tuneId,
        startBeat: Number(body.startBeat),
        endBeat: Number(body.endBeat),
        laneRange: body.laneRange,
        checked: Boolean(body.checked),
        note: body.note || ""
      };
      db.sections.push(created);
      return created;
    });
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    const db = await store.readRaw(initialData);
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    const db = await store.readRaw(initialData);
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const section = await store.withTransaction(initialData, (db) => {
      const found = db.sections.find((item) => item.id === checkMatch[1]);
      if (!found) {
        const error = new Error("区间不存在");
        error.status = 404;
        throw error;
      }
      assertNotOnLoan(db, found.tuneId);
      found.checked = body.checked !== undefined ? Boolean(body.checked) : true;
      found.note = body.note ?? found.note;
      return found;
    });
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const db = await store.readRaw(initialData);
    const result = db.issues.filter(
      (item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status)
    );
    return send(res, 200, { data: result });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    const issue = await store.withTransaction(initialData, (db) => {
      findTune(db, body.tuneId);
      const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
      if (!section) {
        const error = new Error("区间不存在或不属于该曲目");
        error.status = 400;
        throw error;
      }
      const created = {
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
      db.issues.push(created);
      return created;
    });
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    required(body, ["status"]);
    const issue = await store.withTransaction(initialData, (db) => {
      const found = db.issues.find((item) => item.id === issueStatusMatch[1]);
      if (!found) {
        const error = new Error("问题不存在");
        error.status = 404;
        throw error;
      }
      found.status = body.status;
      found.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
      found.note = body.note ?? found.note;
      return found;
    });
    return send(res, 200, { data: issue });
  }

  // ---- 母版外借与归还 ----

  const tuneLoansMatch = pathname.match(/^\/tunes\/([^/]+)\/loans$/);
  if (tuneLoansMatch && req.method === "GET") {
    const tuneId = tuneLoansMatch[1];
    const db = await store.readRaw(initialData);
    findTune(db, tuneId);
    const list = (db.loans || []).filter((item) => item.tuneId === tuneId);
    return send(res, 200, { data: list });
  }

  // 申请登记：借出方、起止日期、运输状态。任一拒绝条件命中则整单拒绝，原记录不变。
  if (tuneLoansMatch && req.method === "POST") {
    const tuneId = tuneLoansMatch[1];
    const body = await parseBody(req);
    const result = await store.withTransaction(initialData, (db) => {
      findTune(db, tuneId);
      const validated = loans.validateApplication({ ...body, tuneId });
      if (validated.errors.length) {
        const error = new Error(`借用申请字段无效：${validated.errors.join(", ")}`);
        error.status = 400;
        throw error;
      }
      const check = loans.canBorrow(db, tuneId, body.startDate, body.endDate);
      if (!check.ok) {
        const error = new Error("借用申请被拒绝，原记录未改动");
        error.status = 409;
        error.blockers = check.blockers;
        throw error;
      }
      const created = loans.buildLoan(makeId("loan"), { ...body, tuneId }, validated);
      db.loans.push(created);
      return created;
    }).catch((error) => {
      if (error.blockers) error.body = { error: error.message, blockers: error.blockers };
      throw error;
    });
    return send(res, 201, { data: result });
  }

  if (req.method === "GET" && pathname === "/loans") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const borrower = searchParams.get("borrower");
    const db = await store.readRaw(initialData);
    const list = (db.loans || []).filter(
      (item) =>
        (!tuneId || item.tuneId === tuneId) &&
        (!status || item.status === status) &&
        (!borrower || item.borrower === borrower)
    );
    return send(res, 200, { data: list });
  }

  const loanShippingMatch = pathname.match(/^\/loans\/([^/]+)\/shipping$/);
  if (loanShippingMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const updated = await store.withTransaction(initialData, (db) => {
      const loan = findLoan(db, loanShippingMatch[1]);
      return loans.markShipped(loan, body);
    });
    return send(res, 200, { data: updated });
  }

  const loanReturnMatch = pathname.match(/^\/loans\/([^/]+)\/return$/);
  if (loanReturnMatch && req.method === "POST") {
    const body = await parseBody(req);
    const updated = await store.withTransaction(initialData, (db) => {
      const loan = findLoan(db, loanReturnMatch[1]);
      if (body.returnDate) {
        const returnDate = loans.toDay(body.returnDate);
        if (Number.isNaN(returnDate.getTime())) {
          const error = new Error("returnDate 必须是 YYYY-MM-DD");
          error.status = 400;
          throw error;
        }
        return loans.returnLoan(loan, body, returnDate);
      }
      return loans.returnLoan(loan, body);
    });
    return send(res, 200, { data: updated });
  }

  const loanReviewMatch = pathname.match(/^\/loans\/([^/]+)\/review$/);
  if (loanReviewMatch && req.method === "POST") {
    const body = await parseBody(req);
    const updated = await store.withTransaction(initialData, (db) => {
      const loan = findLoan(db, loanReviewMatch[1]);
      return loans.reviewLoan(loan, body);
    });
    return send(res, 200, { data: updated });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, error.body || { error: error.message || "服务器错误" })
  );
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
