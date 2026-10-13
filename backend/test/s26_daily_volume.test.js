/**
 * Unit & Integration Tests – S-26 / SCRUM-118
 * API Báo cáo khối lượng hằng ngày và lũy kế
 *
 * Chiến lược: mock pool MySQL (không cần Docker) để kiểm tra:
 *  1. Validation đầu vào (POST)
 *  2. Luồng thành công: nộp mới, cập nhật, lũy kế
 *  3. Cảnh báo vượt KL kế hoạch
 *  4. NFR: rollback khi lỗi transaction
 *  5. Phân quyền: Viewer bị 403
 *  6. GET danh sách và GET summary
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');

// ── Mock pool factory ────────────────────────────────────────────────────────

/**
 * Tạo mock pool với conn.query đáp ứng theo thứ tự callSequence.
 * @param {Array<{rows: any}|Error>} callSequence
 * @param {{commitFails?: boolean, rollbackFails?: boolean}} opts
 */
function makeMockPool(callSequence, { commitFails = false } = {}) {
  let callIndex = 0;
  const conn = {
    beginTransaction: async () => {},
    query: async (sql, params) => {
      if (callIndex >= callSequence.length) {
        throw new Error(`Unexpected query call #${callIndex}: ${sql}`);
      }
      const entry = callSequence[callIndex++];
      if (entry instanceof Error) throw entry;
      // Trả về [rows, fields] như mysql2 promise
      return [entry.rows ?? entry, []];
    },
    commit:   async () => { if (commitFails) throw new Error('commit error'); },
    rollback: async () => {},
    release:  () => {}
  };
  return {
    query: conn.query,
    getConnection: async () => conn
  };
}

// ── Import module cần test ───────────────────────────────────────────────────
const { DailyVolumeRepository } = require('../src/repositories/dailyVolumeRepository');

// ── Helper: payload hợp lệ mặc định ─────────────────────────────────────────
const DEFAULT_PAYLOAD = {
  projectId:   1,
  workItemId:  1,
  reportedBy:  10,
  reportDate:  '2026-10-13',
  quantity:    50,
  note:        'Ca sáng'
};

// ════════════════════════════════════════════════════════════════════════════
// 1. submitReport – luồng thành công (nộp mới, không vượt KL)
// ════════════════════════════════════════════════════════════════════════════
test('submitReport – nộp mới thành công, tính lũy kế, không vượt kế hoạch', async () => {
  const pool = makeMockPool([
    // 1. SELECT work_items (FOR SHARE)
    { rows: [{ id: 1, project_id: 1, planned_quantity: 200 }] },
    // 2. SELECT existing report → không có
    { rows: [] },
    // 3. INSERT upsert → insertId = 42
    { rows: { insertId: 42, affectedRows: 1 } },
    // 4. SELECT SUM(quantity) lũy kế
    { rows: [{ cumulative_quantity: 50 }] }
  ]);

  const repo   = new DailyVolumeRepository({ pool });
  const result = await repo.submitReport(DEFAULT_PAYLOAD);

  assert.equal(result.id,                 42,    'id phải là insertId');
  assert.equal(result.isNew,              true,  'isNew phải true khi chưa có bản ghi');
  assert.equal(result.cumulativeQuantity, 50,    'Lũy kế = quantity vừa nộp');
  assert.equal(result.plannedQuantity,    200,   'plannedQuantity từ work_item');
  assert.equal(result.isOverPlan,         false, 'Chưa vượt kế hoạch (50 <= 200)');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. submitReport – cập nhật (đội đã báo ngày đó)
// ════════════════════════════════════════════════════════════════════════════
test('submitReport – cập nhật báo cáo đã nộp cùng ngày', async () => {
  const pool = makeMockPool([
    { rows: [{ id: 1, project_id: 1, planned_quantity: 200 }] },
    // Đã có bản ghi cũ
    { rows: [{ id: 7 }] },
    // ON DUPLICATE KEY UPDATE
    { rows: { insertId: 0, affectedRows: 2 } },
    // Lũy kế sau update
    { rows: [{ cumulative_quantity: 80 }] }
  ]);

  const repo   = new DailyVolumeRepository({ pool });
  const result = await repo.submitReport({ ...DEFAULT_PAYLOAD, quantity: 80 });

  assert.equal(result.id,    7,     'id phải là id bản ghi cũ');
  assert.equal(result.isNew, false, 'isNew phải false khi đã tồn tại');
  assert.equal(result.cumulativeQuantity, 80);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. submitReport – lũy kế vượt KL kế hoạch → isOverPlan = true
// ════════════════════════════════════════════════════════════════════════════
test('submitReport – lũy kế vượt KL kế hoạch → isOverPlan = true', async () => {
  const pool = makeMockPool([
    { rows: [{ id: 1, project_id: 1, planned_quantity: 100 }] },
    { rows: [] },
    { rows: { insertId: 55, affectedRows: 1 } },
    // Lũy kế tổng (gồm nhiều đội) = 150 > 100
    { rows: [{ cumulative_quantity: 150 }] }
  ]);

  const repo   = new DailyVolumeRepository({ pool });
  const result = await repo.submitReport({ ...DEFAULT_PAYLOAD, quantity: 80 });

  assert.equal(result.isOverPlan,         true,  'Phải phát hiện vượt KL kế hoạch');
  assert.equal(result.cumulativeQuantity, 150);
  assert.equal(result.plannedQuantity,    100);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. submitReport – work_item không tồn tại → throw & rollback
// ════════════════════════════════════════════════════════════════════════════
test('submitReport – work_item không tồn tại → ném lỗi, không commit', async () => {
  let committed = false;
  const conn = {
    beginTransaction: async () => {},
    query: async () => [[]], // SELECT work_items trả rỗng
    commit:   async () => { committed = true; },
    rollback: async () => {},
    release:  () => {}
  };
  const pool = { query: conn.query, getConnection: async () => conn };

  const repo = new DailyVolumeRepository({ pool });
  await assert.rejects(
    () => repo.submitReport(DEFAULT_PAYLOAD),
    (err) => {
      assert.match(err.message, /không tồn tại/);
      return true;
    }
  );
  assert.equal(committed, false, 'Không được commit khi work_item không tồn tại');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. submitReport – work_item không thuộc project → ném lỗi
// ════════════════════════════════════════════════════════════════════════════
test('submitReport – work_item không thuộc project → ném lỗi', async () => {
  const pool = makeMockPool([
    // work_item thuộc project_id = 99, không phải 1
    { rows: [{ id: 1, project_id: 99, planned_quantity: 200 }] }
  ]);

  const repo = new DailyVolumeRepository({ pool });
  await assert.rejects(
    () => repo.submitReport(DEFAULT_PAYLOAD),
    /không thuộc/
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 6. submitReport – lỗi DB trong transaction → rollback
// ════════════════════════════════════════════════════════════════════════════
test('submitReport – lỗi DB trong transaction → rollback được gọi', async () => {
  let rolledBack = false;
  const conn = {
    beginTransaction: async () => {},
    query: async (sql) => {
      if (sql.startsWith('SELECT')) return [[{ id: 1, project_id: 1, planned_quantity: 100 }]];
      // INSERT throw lỗi DB
      throw new Error('Deadlock found when trying to get lock');
    },
    commit:   async () => {},
    rollback: async () => { rolledBack = true; },
    release:  () => {}
  };
  const pool = { query: conn.query, getConnection: async () => conn };

  const repo = new DailyVolumeRepository({ pool });
  await assert.rejects(() => repo.submitReport(DEFAULT_PAYLOAD));
  assert.equal(rolledBack, true, 'rollback phải được gọi khi INSERT lỗi');
});

// ════════════════════════════════════════════════════════════════════════════
// 7. submitReport – KL kế hoạch NULL → isOverPlan luôn false
// ════════════════════════════════════════════════════════════════════════════
test('submitReport – plannedQuantity NULL → isOverPlan = false dù lũy kế lớn', async () => {
  const pool = makeMockPool([
    { rows: [{ id: 1, project_id: 1, planned_quantity: null }] },
    { rows: [] },
    { rows: { insertId: 9, affectedRows: 1 } },
    { rows: [{ cumulative_quantity: 99999 }] }
  ]);

  const repo   = new DailyVolumeRepository({ pool });
  const result = await repo.submitReport(DEFAULT_PAYLOAD);

  assert.equal(result.plannedQuantity, null,  'plannedQuantity phải là null');
  assert.equal(result.isOverPlan,      false, 'Khi KL kế hoạch NULL, không cảnh báo');
});

// ════════════════════════════════════════════════════════════════════════════
// 8. getCumulativeSummary – tổng hợp đúng, đánh dấu isOverPlan
// ════════════════════════════════════════════════════════════════════════════
test('getCumulativeSummary – trả về lũy kế và đánh dấu vượt KL', async () => {
  const mockRows = [
    {
      workItemId:         1,
      workItemName:       'Thi công phần móng',
      workItemCode:       'WBS-01',
      plannedQuantity:    100,
      cumulativeQuantity: 120,   // vượt
      reportCount:        5,
      firstReportDate:    '2026-10-01',
      lastReportDate:     '2026-10-10'
    },
    {
      workItemId:         2,
      workItemName:       'Xây tường',
      workItemCode:       'WBS-02',
      plannedQuantity:    200,
      cumulativeQuantity: 80,    // chưa vượt
      reportCount:        2,
      firstReportDate:    '2026-10-05',
      lastReportDate:     '2026-10-08'
    }
  ];

  const fakePool = {
    query: async () => [mockRows, []],
    getConnection: async () => { throw new Error('should not be called'); }
  };

  const repo    = new DailyVolumeRepository({ pool: fakePool });
  const summary = await repo.getCumulativeSummary(1);

  assert.equal(summary.length, 2);
  assert.equal(summary[0].isOverPlan, true,  'WBS-01 phải được đánh dấu vượt KL');
  assert.equal(summary[1].isOverPlan, false, 'WBS-02 chưa vượt KL');
  assert.equal(summary[0].cumulativeQuantity, 120);
});

// ════════════════════════════════════════════════════════════════════════════
// 9. isDatabaseAvailable – trả false khi không có pool
// ════════════════════════════════════════════════════════════════════════════
test('isDatabaseAvailable – false khi pool thiếu getConnection', () => {
  const repo1 = new DailyVolumeRepository(null);
  assert.equal(repo1.isDatabaseAvailable(), false);

  // pool có query nhưng không có getConnection
  const repo2 = new DailyVolumeRepository({ pool: { query: () => {} } });
  assert.equal(repo2.isDatabaseAvailable(), false);
});

// ════════════════════════════════════════════════════════════════════════════
// 10. HTTP Route – Validation endpoint (integration với Express)
// ════════════════════════════════════════════════════════════════════════════
test('Route POST validation – thiếu work_item_id, quantity, report_date', async () => {
  const http    = require('node:http');
  const express = require('express');

  // Pool giả không cần gọi thật
  const fakePool = {
    query: async () => { throw new Error('Không nên gọi DB khi validate lỗi'); },
    getConnection: async () => { throw new Error('Không nên gọi DB khi validate lỗi'); }
  };

  const dailyVolumeRoutes = require('../src/routes/dailyVolumeRoutes');
  const app = express();
  app.use(express.json());
  // Mock authenticate: admin đã đăng nhập
  app.use((req, _res, next) => { req.user = { id: 10, role_id: 1, role_name: 'admin' }; next(); });
  app.use('/api', dailyVolumeRoutes(fakePool));

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  async function post(body) {
    const res = await fetch(`http://localhost:${port}/api/projects/1/daily-volume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  }

  try {
    // Thiếu work_item_id
    const r1 = await post({ report_date: '2026-10-13', quantity: 10 });
    assert.equal(r1.status, 400, 'Thiếu work_item_id → 400');
    assert.match(r1.data.message, /work_item_id/);

    // Thiếu quantity
    const r2 = await post({ work_item_id: 1, report_date: '2026-10-13' });
    assert.equal(r2.status, 400, 'Thiếu quantity → 400');
    assert.match(r2.data.message, /[Kk]h\u1ed1i l\u01b0\u1ee3ng/);

    // quantity âm
    const r3 = await post({ work_item_id: 1, report_date: '2026-10-13', quantity: -5 });
    assert.equal(r3.status, 400, 'quantity âm → 400');

    // report_date sai định dạng
    const r4 = await post({ work_item_id: 1, report_date: '13/10/2026', quantity: 10 });
    assert.equal(r4.status, 400, 'report_date sai định dạng → 400');
    assert.match(r4.data.message, /report_date/);
  } finally {
    await new Promise(r => server.close(r));
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Frontend Mobile – Kiểm tra cấu trúc HTML, ký hiệu việc găng và NFR button >= 48px
// ════════════════════════════════════════════════════════════════════════════
test('Frontend Mobile daily-volume.html – Đáp ứng AC và NFR tap-target >= 48px', async () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const htmlPath = path.join(__dirname, '../../frontend/daily-volume.html');
  assert.ok(fs.existsSync(htmlPath), 'File daily-volume.html phải tồn tại trong thư mục frontend');

  const content = fs.readFileSync(htmlPath, 'utf8');

  // NFR: Nút bấm tối thiểu 48x48px
  assert.match(content, /--tap-min:\s*48px/, 'Phải định nghĩa CSS token --tap-min: 48px cho nút bấm mobile');
  assert.match(content, /qty-btn/, 'Phải có class qty-btn cho các nút bấm cộng/trừ số lượng');

  // AC: Ký hiệu việc găng riêng biệt
  assert.match(content, /VIỆC GĂNG/, 'Phải có ký hiệu việc găng rõ ràng');
  assert.match(content, /isCritical|is-critical/, 'Phải có logic xử lý việc găng isCritical');

  // AC: Hiển thị danh sách việc theo ngày bắt đầu (ES)
  assert.match(content, /earlyStart/, 'Phải sắp xếp và hiển thị theo ngày bắt đầu earlyStart');

  // NFR: Màn hình dùng được một tay (FAB hoặc bottom bar hoặc controls dễ thao tác)
  assert.match(content, /fab-submit-all/, 'Phải có FAB hoặc thanh hành động một tay');
});
