"use strict";

// 端到端验证：启动一个使用临时 DB 的服务实例，通过 HTTP 覆盖全部业务规则。
const { spawn } = require("child_process");
const { mkdtempSync, existsSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");

const PORT = 3917;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(path.join(tmpdir(), "organ-loan-"));
const dbFile = path.join(dir, "db.json");

const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile },
  stdio: ["ignore", "pipe", "inherit"]
});

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

function offsetDate(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch(BASE + "/health");
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server failed to start");
}

async function createCleanTune(title) {
  const r = await req("POST", "/tunes", { title: title || "可借母版", stripSpec: { widthMm: 70 } });
  const tuneId = r.json.data.id;
  // 单个已校对区间 => 无未完成区间；不建问题 => 无未解决问题。
  await req("POST", `/tunes/${tuneId}/sections`, {
    startBeat: 1,
    endBeat: 16,
    laneRange: "1-8",
    checked: true
  });
  return tuneId;
}

async function main() {
  await waitForServer();

  // 1. 旧数据字段兼容：初始 DB 无 loans，旧曲目进度正常且按可借呈现
  {
    const demo = await req("GET", "/tunes/tune_demo/progress");
    check("旧曲目进度可读", demo.status === 200);
    check("旧曲目 loan 摘要存在（无借用记录按可借）", Boolean(demo.json.data.loan));
    check("旧曲目 onLoan=false", demo.json.data.loan.onLoan === false);
  }

  // 2. 拒绝规则：未解决问题 / 未完成区间 / 日期重叠，整单拒绝且原记录不变
  {
    const tune = await createCleanTune("干净母版");
    const ok = await req("POST", `/tunes/${tune}/loans`, {
      borrower: "市立风琴馆",
      startDate: offsetDate(1),
      endDate: offsetDate(10),
      shippingStatus: "pending"
    });
    check("干净母版可借出", ok.status === 201 && ok.json.data.status === "active");
    const loanId = ok.json.data.id;

    const before = await req("GET", `/tunes/${tune}/loans`);
    const beforeCount = before.json.data.length;

    const overlap = await req("POST", `/tunes/${tune}/loans`, {
      borrower: "第二博物馆",
      startDate: offsetDate(5),
      endDate: offsetDate(20)
    });
    check("借展重叠整单拒绝 409", overlap.status === 409);
    check("拒绝原因含 LOAN_OVERLAP", (overlap.json.reasons || []).some((r) => r.code === "LOAN_OVERLAP"));

    const after = await req("GET", `/tunes/${tune}/loans`);
    check("拒绝后原记录不变（数量不变）", after.json.data.length === beforeCount);

    // 首尾相接（一天之差、闭区间外）：新借从归还次日开始 => 不重叠
    const back2back = await req("POST", `/tunes/${tune}/loans`, {
      borrower: "邻镇文化馆",
      startDate: offsetDate(11),
      endDate: offsetDate(12)
    });
    check("归还次日开始的借展不算重叠", back2back.status === 201);

    const dirty = await createCleanTune("有问题母版");
    await req("POST", `/tunes/${dirty}/sections`, {
      startBeat: 17,
      endBeat: 32,
      laneRange: "1-8",
      checked: false
    });
    const secs = (await req("GET", `/tunes/${dirty}/sections`)).json.data;
    const sec = secs[0];
    await req("POST", "/issues", {
      tuneId: dirty,
      sectionId: sec.id,
      type: "漏孔",
      beat: 3,
      lane: 2,
      description: "漏孔"
    });
    const reject = await req("POST", `/tunes/${dirty}/loans`, {
      borrower: "谁",
      startDate: offsetDate(0),
      endDate: offsetDate(2)
    });
    check("有未解决问题+未完成区间 => 409", reject.status === 409);
    const codes = (reject.json.reasons || []).map((r) => r.code).sort().join(",");
    check("同时给出 OPEN_ISSUES 与 UNFINISHED_SECTIONS", codes === "OPEN_ISSUES,UNFINISHED_SECTIONS", codes);
    const dirtyLoans = await req("GET", `/tunes/${dirty}/loans`);
    check("被拒母版无任何借用记录", dirtyLoans.json.data.length === 0);

    // 非法日期
    const badDate = await req("POST", `/tunes/${(await createCleanTune("日期母版"))}/loans`, {
      borrower: "X",
      startDate: "2026-13-40",
      endDate: "明天"
    });
    check("非法日期拒绝", badDate.status === 409 && badDate.json.reasons.some((r) => r.code === "INVALID_DATE"));

    // 缺字段
    const missing = await req("POST", `/tunes/${tune}/loans`, { borrower: "X" });
    check("缺少起止日期 400", missing.status === 400);

    // 别名字段兼容
    const alias = await createCleanTune("别名母版");
    const aliasRes = await req("POST", `/tunes/${alias}/loans`, {
      borrowerName: "别名借出方",
      from: offsetDate(1),
      to: offsetDate(3),
      transportStatus: "in_transit"
    });
    check("borrowerName/from/to/transportStatus 别名可用", aliasRes.status === 201);
    check("别名映射到 shippingStatus", aliasRes.json.data.shippingStatus === "in_transit");
  }

  // 3. 借出期间禁止打孔和修改区间
  {
    const tune = await createCleanTune("借出锁母版");
    const loan = await req("POST", `/tunes/${tune}/loans`, {
      borrower: "馆A",
      startDate: offsetDate(-1),
      endDate: offsetDate(5)
    });
    check("跨今天的借展建立成功", loan.status === 201);
    const progress = (await req("GET", `/tunes/${tune}/progress`)).json.data;
    check("进度显示 onLoan=true", progress.loan.onLoan === true);

    const addSec = await req("POST", `/tunes/${tune}/sections`, {
      startBeat: 1,
      endBeat: 8,
      laneRange: "1-4"
    });
    check("借出期间新增区间被拦 409", addSec.status === 409 && addSec.json.code === "TUNE_ON_LOAN");

    const secs = (await req("GET", `/tunes/${tune}/sections`)).json.data;
    const patch = await req("PATCH", `/sections/${secs[0].id}/check`, { checked: false });
    check("借出期间修改区间被拦 409", patch.status === 409 && patch.json.code === "TUNE_ON_LOAN");

    const issue = await req("POST", "/issues", {
      tuneId: tune,
      sectionId: secs[0].id,
      type: "漏孔",
      description: "x"
    });
    check("借出期间打孔（登记问题）被拦 409", issue.status === 409 && issue.json.code === "TUNE_ON_LOAN");

    // 未来预约不拦今天
    const future = await createCleanTune("预约母版");
    await req("POST", `/tunes/${future}/loans`, {
      borrower: "馆B",
      startDate: offsetDate(10),
      endDate: offsetDate(20)
    });
    const addNow = await req("POST", `/tunes/${future}/sections`, {
      startBeat: 9,
      endBeat: 12,
      laneRange: "1-2",
      checked: true
    });
    check("未来借展预约不拦当前打孔", addNow.status === 201);
  }

  // 4. 提前/按期归还释放占用
  {
    const tune = await createCleanTune("归还母版");
    const loan = (await req("POST", `/tunes/${tune}/loans`, {
      borrower: "馆C",
      startDate: offsetDate(-5),
      endDate: offsetDate(5)
    })).json.data;

    const early = await req("POST", `/loans/${loan.id}/return`, {
      returnedDate: offsetDate(0),
      shippingStatus: "returned"
    });
    check("按期归还状态=returned", early.status === 200 && early.json.data.status === "returned");
    check("归还登记 returnedDate", Boolean(early.json.data.returnedDate));
    check("按期归还 overdue=false", early.json.data.overdue === false);

    const progress = (await req("GET", `/tunes/${tune}/progress`)).json.data;
    check("归还后 onLoan=false（占用释放）", progress.loan.onLoan === false);

    // 占用释放后，可以新增区间/打孔，且新借展可与已归还区间重叠
    const sec = await req("POST", `/tunes/${tune}/sections`, {
      startBeat: 50,
      endBeat: 56,
      laneRange: "1-3",
      checked: true
    });
    check("归还后可修改母版", sec.status === 201);

    const reloan = await req("POST", `/tunes/${tune}/loans`, {
      borrower: "馆D",
      startDate: offsetDate(0),
      endDate: offsetDate(2)
    });
    check("归还后立刻可再借（含日期重叠）", reloan.status === 201);

    const again = await req("POST", `/loans/${loan.id}/return`, {});
    check("重复归还被拒绝 409", again.status === 409 && again.json.code === "LOAN_NOT_ACTIVE");
  }

  // 5. 逾期归还 => 待复核，补延迟原因+复核后才能再借
  {
    const tune = await createCleanTune("逾期母版");
    const loan = (await req("POST", `/tunes/${tune}/loans`, {
      borrower: "馆E",
      startDate: offsetDate(-20),
      endDate: offsetDate(-10)
    })).json.data;

    const late = await req("POST", `/loans/${loan.id}/return`, { returnedDate: offsetDate(-2) });
    check("逾期归还转 pending_review", late.json.data.status === "pending_review");
    check("标记 overdue=true", late.json.data.overdue === true);

    const progress1 = (await req("GET", `/tunes/${tune}/progress`)).json.data;
    check("待复核期间 onLoan=false（已归还）", progress1.loan.onLoan === false);
    check("进度显示 pendingReview=true", progress1.loan.pendingReview === true);

    const reloan1 = await req("POST", `/tunes/${tune}/loans`, {
      borrower: "馆F",
      startDate: offsetDate(0),
      endDate: offsetDate(1)
    });
    check("待复核期间再借被拒", reloan1.status === 409);
    check("拒绝原因含 PENDING_REVIEW", reloan1.json.reasons.some((r) => r.code === "PENDING_REVIEW"));

    // 未补原因直接复核 => 400
    const noReason = await req("POST", `/loans/${loan.id}/review`, { approved: true });
    check("未补延迟原因复核 400", noReason.status === 400 && noReason.json.code === "DELAY_REASON_REQUIRED");
    const stillPending = await req("GET", `/loans/${loan.id}`);
    check("复核失败状态不变", stillPending.json.data.status === "pending_review");

    // 补原因 + 复核通过
    const ok = await req("POST", `/loans/${loan.id}/review`, {
      approved: true,
      delayReason: "运输公司爆仓延误一周",
      reviewedBy: "保管员王"
    });
    check("补齐原因复核通过 => reviewed", ok.status === 200 && ok.json.data.status === "reviewed");

    const reloan2 = await req("POST", `/tunes/${tune}/loans`, {
      borrower: "馆G",
      startDate: offsetDate(0),
      endDate: offsetDate(1)
    });
    check("复核通过后可再借", reloan2.status === 201);

    // 复核非待复核记录
    const reviewedAgain = await req("POST", `/loans/${loan.id}/review`, { approved: true });
    check("已复核记录不能再复核", reviewedAgain.status === 409);

    // 运输状态 PATCH
    const ship = await req("PATCH", `/loans/${reloan2.json.data.id}`, { shippingStatus: "delivered" });
    check("运输状态可独立更新", ship.status === 200 && ship.json.data.shippingStatus === "delivered");
  }

  // 6. 并发申请只成功一次
  {
    const tune = await createCleanTune("并发母版");
    const payload = {
      borrower: "并发方",
      startDate: offsetDate(30),
      endDate: offsetDate(40)
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => req("POST", `/tunes/${tune}/loans`, payload))
    );
    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    check("8 个并发申请仅 1 个成功", created.length === 1, `成功 ${created.length} 个`);
    check("其余 7 个全部被拒", rejected.length === 7, `拒绝 ${rejected.length} 个`);
    const stored = (await req("GET", `/tunes/${tune}/loans`)).json.data;
    check("库中只落了 1 条记录", stored.length === 1, `实际 ${stored.length} 条`);
  }

  // 7. 零区间母版：无未完成区间，可借
  {
    const r = await req("POST", "/tunes", { title: "无区间母版", stripSpec: {} });
    const tuneId = r.json.data.id;
    const loan = await req("POST", `/tunes/${tuneId}/loans`, {
      borrower: "馆H",
      startDate: offsetDate(0),
      endDate: offsetDate(1)
    });
    check("没有任何区间的母版可借", loan.status === 201);
  }

  // 8. 列表过滤与未知路由
  {
    const all = await req("GET", "/loans?status=active");
    check("GET /loans?status= 过滤生效", all.json.data.every((l) => l.status === "active"));
    const nf = await req("GET", "/loans/loan_not_exist");
    check("未知借用记录 404", nf.status === 404);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  server.kill();
  process.exit(1);
});
