"use strict";

// 数据保存层：db.json 的读写、旧数据字段兼容，以及串行化事务（并发申请只成功一次）。
const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

// 互斥链：任一时刻只允许一个“读-校验-写”事务在执行，
// 避免两个并发借用申请同时读到旧库后双双写入。
let chain = Promise.resolve();

async function ensureDb(initialData) {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

// 兼容旧库：没有 loans 集合时补空数组，老曲目即按“无借用记录”处理。
function normalize(db) {
  if (!Array.isArray(db.loans)) db.loans = [];
  return db;
}

async function readRaw(initialData) {
  await ensureDb(initialData);
  return normalize(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(db) {
  // 临时文件 +  rename，保证并发读到的不会是写了一半的JSON。
  const tmp = `${DB_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, DB_FILE);
}

function withTransaction(initialData, fn) {
  const run = chain.then(async () => {
    const db = await readRaw(initialData);
    const result = await fn(db);
    await writeDb(db);
    return result;
  });
  // 无论上一笔成败，链条都继续，但把原始结果/reject透传给调用方。
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

module.exports = { DB_FILE, ensureDb, readRaw, writeDb, withTransaction };
