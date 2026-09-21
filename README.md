# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题与母版借展记录。
可用 `DB_FILE=/path/to/db.json PORT=3019 node server.js` 覆盖数据文件与端口。

## 启动

```bash
PORT=3019 node server.js
```

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

## 母版外借与归还

- `GET /tunes/:id/loans`：某曲目的借用单列表
- `POST /tunes/:id/loans`：申请登记借用（字段：`borrower` 借出方、`startDate`/`endDate`（YYYY-MM-DD）、`shippingStatus`：preparing/inTransit/delivered/returnTransit、`note`）
- `GET /loans?tuneId=&status=&borrower=`
- `PATCH /loans/:id/shipping`：更新运输状态；送达（delivered）时借用单 `requested -> loaned`
- `POST /loans/:id/return`：归还（可用 `returnDate` 指定归还日，默认今日）
- `POST /loans/:id/review`：逾期单补齐 `delayReason` 并复核（`reviewedBy`、`approved`）

### 规则

- 申请整单拒绝（HTTP 409，响应体 `blockers` 列出原因，原记录不变）：
  - `open_issue`：母版存在未解决问题（issues 中非 resolved）；
  - `unfinished_section`：存在未校对区间；
  - `loan_overlap`：起止区间与占用中的借用单重叠（起止日期采用半开区间，前单结束日与新单开始日同日可衔接）；
  - `pending_review`：上一单逾期归还尚待复核，复核通过前不能再借。
- 借出期间（requested/loaned 且当日在借期内）禁止打孔与修改区间：`POST /tunes/:id/sections`、`PATCH /sections/:id/check` 返回 409；问题登记不受限。
- 提前/按时归还：`loaned -> returned`，立即释放占用，可打孔、改区间、再借。
- 逾期归还：`loaned -> review`，必须补齐延迟原因并复核通过才转为 `returned` 释放占用。
- 旧数据兼容：`db.json` 无 `loans` 集合时读取自动补空数组，老曲目按“无借用记录=可借”处理；纯只读不会改写旧库文件。
- 并发：所有写操作经串行化事务（读-校验-写加互斥锁 + 临时文件原子替换），并发借用申请只成功一次。

### 分层

- `loans.js`：借展判定与状态流转（纯函数，无IO）。
- `store.js`：数据保存、旧字段兼容与事务互斥。
- `server.js`：HTTP路由与入参校验。

## 测试

```bash
node test-loans.js   # 使用临时DB启动真实服务做端到端验证
```

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'
```
