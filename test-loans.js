"use strict";

// 端到端验证：母版外借/归还全流程。用临时DB启动真实服务，零依赖。
const { spawn } = require("child_process");
const { rmSync, writeFileSync } = require("fs");
const path = require("path");

const PORT = 3919;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, "tmp.test.db.json");

function day(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

let pass = 0;
let fail = 0;
function assert(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}`, extra ?? "");
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function waitHealthy(proc) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    if (proc.exitCode !== null) throw new Error("server exited early");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server not ready");
}

async function main() {
  rmSync(DB_FILE, { force: true });
  const proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: ["ignore", "pipe", "inherit"]
  });
  try {
    await waitHealthy(proc);

    // 1. 初始曲目有未解决问题 + 未完成区间：申请被整单拒绝
    console.log("1) 拒绝条件：未解决问题 + 未完成区间");
    let r = await api("POST", "/tunes/tune_demo/loans", {
      borrower: "省城风琴博物馆",
      startDate: day(1),
      endDate: day(10),
      shippingStatus: "preparing"
    });
    assert(r.status === 409, "返回409整单拒绝", r);
    const codes = (r.json.blockers || []).map((b) => b.code).sort();
    assert(codes.includes("open_issue") && codes.includes("unfinished_section"), "拒绝原因含 open_issue/unfinished_section", codes);
    let list = (await api("GET", "/tunes/tune_demo/loans")).json.data;
    assert(Array.isArray(list) && list.length === 0, "被拒绝后无借用记录生成", list);

    // 2. 消除拒绝条件后申请成功
    console.log("2) 补齐条件后申请成功");
    await api("PATCH", "/issues/issue_demo/status", { status: "resolved" });
    await api("PATCH", "/sections/section_demo_2/check", { checked: true });
    r = await api("POST", "/tunes/tune_demo/loans", {
      borrower: "省城风琴博物馆",
      startDate: day(-1),
      endDate: day(5),
      shippingStatus: "preparing"
    });
    assert(r.status === 201, "申请登记成功", r.status);
    const loanId = r.json.data.id;
    assert(r.json.data.status === "requested", "初始状态 requested");
    assert(r.json.data.shippingStatus === "preparing", "运输状态被登记");
    assert(r.json.data.overdue === false && r.json.data.returnedAt === null, "初始占用字段正确");

    // 3. 借展重叠：第二单被拒绝
    console.log("3) 借展区间重叠拒绝");
    r = await api("POST", "/tunes/tune_demo/loans", {
      borrower: "另一单位",
      startDate: day(0),
      endDate: day(2)
    });
    assert(r.status === 409, "重叠区间409", r.status);
    assert((r.json.blockers || []).some((b) => b.code === "loan_overlap"), "原因 loan_overlap");
    // 相邻区间（endDate 与对方 startDate 同日，半开区间）不重叠
    r = await api("POST", "/tunes/tune_demo/loans", {
      borrower: "另一单位",
      startDate: day(6),
      endDate: day(8)
    });
    assert(r.status === 201, "紧邻日期不视为重叠，可借出", r.status);
    const loanId2 = r.json.data.id;

    // 4. 借出期间禁止打孔与修改区间
    console.log("4) 借出期间锁定打孔/区间");
    r = await api("POST", "/tunes/tune_demo/sections", { startBeat: 65, endBeat: 96, laneRange: "1-20" });
    assert(r.status === 409, "新建区间409", r.status);
    r = await api("PATCH", "/sections/section_demo_1/check", { checked: false });
    assert(r.status === 409, "修改区间校对409", r.status);
    // 问题上报不属于打孔/区间修改，仍允许
    r = await api("POST", "/issues", {
      tuneId: "tune_demo",
      sectionId: "section_demo_1",
      type: "错孔",
      description: "借出期间登记问题"
    });
    assert(r.status === 201, "问题上报不受借出锁定影响", r.status);
    const newIssueId = r.json.data.id;

    // 5. 运输/送达状态流转
    console.log("5) 运输与借出状态流转");
    r = await api("PATCH", `/loans/${loanId}/shipping`, { shippingStatus: "inTransit" });
    assert(r.json.data.shippingStatus === "inTransit" && r.json.data.status === "requested", "运输中仍为 requested");
    r = await api("PATCH", `/loans/${loanId}/shipping`, { shippingStatus: "delivered" });
    assert(r.json.data.shippingStatus === "delivered" && r.json.data.status === "loaned", "送达后转 loaned", r.json.data);
    assert(Boolean(r.json.data.loanedAt), "记录借出时间");

    // 6. 提前归还释放占用
    console.log("6) 提前归还释放占用");
    r = await api("POST", `/loans/${loanId}/return`, { note: "提前送回" });
    assert(r.json.data.status === "returned" && r.json.data.overdue === false, "提前归还 status=returned", r.json.data);
    r = await api("POST", "/tunes/tune_demo/sections", { startBeat: 65, endBeat: 96, laneRange: "1-20" });
    assert(r.status === 201, "归还后可新建区间（占用释放）", r.status);
    r = await api("PATCH", "/sections/section_demo_1/check", { checked: true });
    assert(r.status === 200, "归还后可修改区间");
    // 归还后新建的区间校对掉，避免影响后续借用申请
    const newSectionId = (await api("GET", "/tunes/tune_demo/sections")).json.data.find(
      (s) => s.startBeat === 65
    ).id;
    await api("PATCH", `/sections/${newSectionId}/check`, { checked: true });
    // 清理借出期间登记的问题，避免影响后续申请
    await api("PATCH", `/issues/${newIssueId}/status`, { status: "resolved" });
    // 第二单也归还，清空活跃占用
    await api("PATCH", `/loans/${loanId2}/shipping`, { shippingStatus: "delivered" });
    await api("POST", `/loans/${loanId2}/return`, {});

    // 7. 逾期归还 -> 待复核，补齐延迟原因并复核后才能再借
    console.log("7) 逾期归还与复核");
    r = await api("POST", "/tunes/tune_demo/loans", {
      borrower: "海外巡展",
      startDate: day(-12),
      endDate: day(-2)
    });
    assert(r.status === 201, "历史区间新单成功", r.status);
    const overLoanId = r.json.data.id;
    r = await api("POST", `/loans/${overLoanId}/return`, {});
    assert(r.json.data.status === "review" && r.json.data.overdue === true, "逾期归还转 review", r.json.data);
    r = await api("POST", "/tunes/tune_demo/loans", { borrower: "x", startDate: day(1), endDate: day(3) });
    assert(r.status === 409, "待复核期间不能再借", r.status);
    assert((r.json.blockers || []).some((b) => b.code === "pending_review"), "原因 pending_review");
    r = await api("POST", `/loans/${overLoanId}/review`, { reviewedBy: "馆长" });
    assert(r.status === 400, "缺少延迟原因复核被拒", r.status);
    r = await api("POST", `/loans/${overLoanId}/review`, { delayReason: "海运清关延误两周", reviewedBy: "馆长" });
    assert(r.status === 200 && r.json.data.status === "returned", "补齐原因并复核后闭环", r.json.data);
    assert(Boolean(r.json.data.reviewedAt), "记录复核时间");
    r = await api("POST", "/tunes/tune_demo/loans", { borrower: "x", startDate: day(1), endDate: day(3) });
    assert(r.status === 201, "复核通过后可再借", r.status);

    // 8. 并发申请只成功一次
    console.log("8) 并发申请只成功一次");
    const tune = (await api("POST", "/tunes", { title: "并发测试曲", stripSpec: { widthMm: 70 } })).json.data;
    const payload = { borrower: "A馆", startDate: day(1), endDate: day(4) };
    const results = await Promise.all([
      api("POST", `/tunes/${tune.id}/loans`, payload),
      api("POST", `/tunes/${tune.id}/loans`, { ...payload, borrower: "B馆" })
    ]);
    const statuses = results.map((x) => x.status).sort();
    assert(JSON.stringify(statuses) === JSON.stringify([201, 409]), "并发两单一成一拒", statuses);
    const concList = (await api("GET", `/tunes/${tune.id}/loans`)).json.data;
    assert(concList.length === 1, "仅落库一条借用单", concList.length);

    // 9. 旧库兼容：无 loans 字段的老数据按可借处理
    console.log("9) 旧数据字段兼容（无 loans 集合）");
    const oldDb = {
      tunes: [{ id: "tune_old", title: "老曲子", stripSpec: {}, createdAt: new Date().toISOString() }],
      sections: [],
      issues: []
    };
    rmSync(DB_FILE, { force: true });
    writeFileSync(DB_FILE, JSON.stringify(oldDb));
    r = await api("POST", "/tunes/tune_old/loans", { borrower: "老借出方", startDate: day(1), endDate: day(2) });
    assert(r.status === 201, "无借用记录的旧曲目按可借处理", r.status);
    const rawAfter = JSON.parse(require("fs").readFileSync(DB_FILE, "utf8"));
    assert(Array.isArray(rawAfter.loans) && rawAfter.loans.length === 1, "旧库自动补 loans 集合并落库");

    // 10. 字段校验
    console.log("10) 字段与状态校验");
    r = await api("POST", "/tunes/tune_old/loans", { borrower: "", startDate: "bad", endDate: day(2) });
    assert(r.status === 400, "缺借出方/坏日期返回400", r.status);
    r = await api("POST", "/tunes/tune_old/loans", { borrower: "z", startDate: day(5), endDate: day(1) });
    assert(r.status === 400, "起止倒置返回400", r.status);
    r = await api("POST", "/tunes/ghost/loans", { borrower: "z", startDate: day(1), endDate: day(2) });
    assert(r.status === 404, "未知曲目404", r.status);
  } finally {
    proc.kill("SIGTERM");
    rmSync(DB_FILE, { force: true });
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
