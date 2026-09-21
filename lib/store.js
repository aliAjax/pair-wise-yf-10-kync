"use strict";

// 数据保存：JSON 文件持久化、旧数据字段兼容（normalize）、
// 以及全局串行事务，保证并发写不互相覆盖、并发借用申请只成功一次。
// 借展判定和状态流转不在这里，它们分别在 loanPolicy.js / loanState.js。

const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "db.json");

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
      createdAt: "2026-06-16T00:00:00.000Z"
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
      createdAt: "2026-06-16T00:00:00.000Z",
      resolvedAt: null
    }
  ],
  loans: []
};

function normalizeDb(raw) {
  const db = raw && typeof raw === "object" ? raw : {};
  db.tunes = Array.isArray(db.tunes) ? db.tunes : [];
  db.sections = Array.isArray(db.sections) ? db.sections : [];
  db.issues = Array.isArray(db.issues) ? db.issues : [];
  // 旧 db.json 没有 loans 字段：旧曲目无借用记录，按可借处理。
  db.loans = Array.isArray(db.loans) ? db.loans.map(normalizeLoan).filter(Boolean) : [];
  return db;
}

// 字段兼容：补全老记录可能缺失的全部新字段，未知字段原样保留。
function normalizeLoan(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  return {
    ...raw,
    id: String(raw.id),
    tuneId: String(raw.tuneId),
    borrower: raw.borrower ?? "",
    startDate: raw.startDate ?? null,
    endDate: raw.endDate ?? null,
    shippingStatus: raw.shippingStatus ?? (raw.transportStatus ?? "pending"),
    status: raw.status ?? "active",
    note: raw.note ?? "",
    appliedAt: raw.appliedAt ?? null,
    returnedDate: raw.returnedDate ?? null,
    returnedAt: raw.returnedAt ?? null,
    overdue: Boolean(raw.overdue),
    delayReason: raw.delayReason ?? "",
    reviewedAt: raw.reviewedAt ?? null,
    reviewedBy: raw.reviewedBy ?? "",
    reviewNote: raw.reviewNote ?? ""
  };
}

async function loadRaw() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    return JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
}

// GET 用的只读入口。
async function readDb() {
  return normalizeDb(await loadRaw());
}

// 全局串行队列：同一时刻只有一个事务读-改-写，
// 后到的借用申请会在前一个事务提交后重新读到最新数据，再做判定，因此并发只会成功一次。
let tail = Promise.resolve();

function withTransaction(worker) {
  const run = tail.then(async () => {
    const db = normalizeDb(await loadRaw());
    const result = await worker(db);
    await writeFile(DB_FILE, JSON.stringify(db, null, 2));
    return result;
  });
  // 队列不因单个事务失败而中断。
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { DB_FILE, readDb, withTransaction, makeId, normalizeDb, normalizeLoan };
