# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目（母版）、纸带区间、试奏问题和母版外借记录。

## 启动

```bash
PORT=3019 node server.js
```

## 代码结构

借展相关逻辑按三个关注点拆开维护：

| 文件 | 职责 |
| --- | --- |
| `lib/store.js` | 数据保存：JSON 持久化、旧数据字段兼容（normalize）、全局串行事务（并发写/并发借用只成功一次） |
| `lib/loanPolicy.js` | 借展判定：未解决问题、未完成区间、日期重叠、待复核、是否借出中（纯函数，不落盘） |
| `lib/loanState.js` | 状态流转：借用记录结构、归还、逾期待复核、复核、运输状态（不读文件、不做判定） |

## 主要接口

曲目与打孔：

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`（进度中含 `loan` 借用摘要）
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

母版外借与归还：

- `GET /loans?tuneId=&status=`
- `GET /tunes/:id/loans`
- `POST /tunes/:id/loans`
- `GET /loans/:id`
- `PATCH /loans/:id`（更新运输状态 / 延迟原因 / 备注）
- `POST /loans/:id/return`（登记归还，可带 `returnedDate`、`shippingStatus`、`delayReason`）
- `POST /loans/:id/review`（逾期复核，需 `delayReason`，可带 `approved:false` 驳回）

## 业务规则

- 借用申请登记借出方（`borrower`）、起止日期（`startDate`/`endDate`，`YYYY-MM-DD`）和运输状态（`shippingStatus`：`pending` / `in_transit` / `delivered` / `returned`）。
- 申请时存在以下任一情况则**整单拒绝**（HTTP 409，返回结构化 `reasons`），不写盘、原记录不变：
  - 母版有未解决（非 `resolved`）的试奏问题；
  - 母版有未完成（`checked=false`）的纸带区间；
  - 借展日期与未归还的借用记录闭区间重叠（归还次日开始不算重叠）；
  - 上一次逾期归还仍处于 `pending_review`。
- 借出期间（已到起始日且未归还）禁止打孔（`POST /issues`）以及新增/修改区间（`POST .../sections`、`PATCH /sections/:id/check`），返回 409 `TUNE_ON_LOAN`。起始日在未来的预约不拦当前操作。
- 按期/提前归还：状态置 `returned`，立即释放占用，之后可打孔、改区间、再借展。
- 逾期归还：状态置 `pending_review`，必须补齐延迟原因并复核通过（`reviewed`）后才能再借。
- 旧曲目没有任何借用记录时按可借处理；旧 `db.json` 缺少 `loans` 字段会自动兼容。
- 并发借用申请通过全局串行事务保证只成功一次。
- 字段兼容：申请接口接受历史别名 `borrowerName`、`from`/`borrowDate`、`to`/`dueDate`、`transportStatus`。

借用状态流转：

```
active ──按期/提前归还──> returned（占用释放）
   └────逾期归还──────> pending_review ──补齐延迟原因+复核通过──> reviewed（可再借）
```

## 测试

```bash
node test/run-tests.js
```

端到端测试使用临时 DB 启动独立服务实例，覆盖拒绝规则、借出锁定、归还释放、逾期复核、并发申请与旧数据兼容。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress

curl -X POST http://127.0.0.1:3019/tunes/tune_demo/loans \
  -H 'Content-Type: application/json' \
  -d '{"borrower":"市立风琴馆","startDate":"2026-10-01","endDate":"2026-10-14","shippingStatus":"in_transit"}'
```
