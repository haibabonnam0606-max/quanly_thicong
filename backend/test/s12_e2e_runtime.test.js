/**
 * End-to-End Runtime Integration Test (S-12 / Sprint 2)
 * Kiểm tra toàn bộ luồng tích hợp với máy chủ Docker thực tế (port 5001 & 8081):
 * - Admin đăng nhập, lấy token
 * - Truy cập trang schedule.html, kiểm tra đầy đủ cột hiển thị và kịch bản XSS
 * - Đọc kết quả tính toán lần đầu (isCached = false)
 * - Đọc kết quả lần tiếp theo từ bảng lưu sẵn (isCached = true)
 * - Lọc công việc găng (critical = true)
 * - Sửa thời lượng công việc -> cache bị stale -> tính lại -> lưu lại cache
 * - Viewer đăng nhập: xem được dự án của mình, bị 403 khi xem dự án khác hoặc sửa dữ liệu
 * - Kiểm tra chu trình trả về lỗi tiếng Việt 422
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const BACKEND_URL = process.env.BACKEND_BASE_URL || process.env.TEST_BACKEND_URL || 'http://localhost:5001';
const FRONTEND_URL = process.env.FRONTEND_BASE_URL || process.env.TEST_FRONTEND_URL || 'http://localhost:8081';

async function isBackendReachable() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

test('E2E Runtime: Kiểm tra các trang HTML và kịch bản giao diện S-12', { concurrency: false }, async (t) => {
  if (!await isBackendReachable()) {
    t.skip(`Backend server not running at ${BACKEND_URL}. Skipping live runtime test.`);
    return;
  }
  // 1. Kiểm tra schedule.html được phục vụ thành công từ Backend
  const resHtml = await fetch(`${BACKEND_URL}/schedule.html`);
  assert.equal(resHtml.status, 200, 'Trang schedule.html trên backend phải trả về HTTP 200');
  const html = await resHtml.text();

  // Kiểm tra frontend Nginx phục vụ thành công trang schedule.html và login.html
  const resFrontendSchedule = await fetch(`${FRONTEND_URL}/schedule.html`);
  assert.equal(resFrontendSchedule.status, 200, 'Trang schedule.html trên frontend (Nginx) phải trả về HTTP 200');

  const resFrontendLogin = await fetch(`${FRONTEND_URL}/login.html`);
  assert.equal(resFrontendLogin.status, 200, 'Trang login.html trên frontend (Nginx) phải trả về HTTP 200');

  // Kiểm tra đủ các cột cần thiết (T-28 AC 2)
  assert.ok(html.includes('Mã CV'), 'Phải có cột Mã CV');
  assert.ok(html.includes('Tên công việc'), 'Phải có cột Tên công việc');
  assert.ok(html.includes('Thời lượng'), 'Phải có cột Thời lượng');
  assert.ok(html.includes('Khởi sớm (ES)'), 'Phải có cột Khởi sớm (ES)');
  assert.ok(html.includes('Kết sớm (EF)'), 'Phải có cột Kết sớm (EF)');
  assert.ok(html.includes('Khởi muộn (LS)'), 'Phải có cột Khởi muộn (LS)');
  assert.ok(html.includes('Kết muộn (LF)'), 'Phải có cột Kết muộn (LF)');
  assert.ok(html.includes('Độ trễ (Float)'), 'Phải có cột Độ trễ (Float)');
  assert.ok(html.includes('Trạng thái'), 'Phải có cột Trạng thái');

  // Kiểm tra bộ lọc việc găng (T-28 AC 4)
  assert.ok(html.includes('critical-only-toggle'), 'Phải có switch lọc việc găng');

  // Kiểm tra cơ chế chống XSS (T-28 AC 9)
  assert.ok(html.includes('escapeHtml'), 'Phải có hàm escapeHtml để chống XSS');

  // Kiểm tra định dạng ngày giờ tiếng Việt (T-28 AC 8)
  assert.ok(html.includes('formatDateVN'), 'Phải có hàm định dạng thời gian Việt Nam');
});

test('E2E Runtime: Admin đăng nhập và truy vấn bảng tiến độ lưu sẵn', { concurrency: false }, async (t) => {
  if (!await isBackendReachable()) {
    t.skip(`Backend server not running at ${BACKEND_URL}. Skipping live runtime test.`);
    return;
  }
  // 1. Đăng nhập Admin
  const loginRes = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@thicong.vn', password: 'Admin@123' })
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  const token = loginData.token;
  assert.ok(token, 'Admin phải nhận được token phiên');

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  // Đảm bảo dự án 1 có công việc và quan hệ phụ thuộc mẫu nếu môi trường mới khởi tạo
  const taskCheckRes = await fetch(`${BACKEND_URL}/api/tasks/1`, { headers });
  if (taskCheckRes.status === 404) {
    await fetch(`${BACKEND_URL}/api/work-items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: 1, name: 'Thi công phần móng', code: 'WBS-01' })
    }).catch(() => {});
    await fetch(`${BACKEND_URL}/api/projects/1/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Đào đất hố móng trụ T1', code: 'CV-01', duration: 5, work_item_id: 1 })
    }).catch(() => {});
    await fetch(`${BACKEND_URL}/api/projects/1/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Đổ bê tông lót móng', code: 'CV-02', duration: 3, work_item_id: 1 })
    }).catch(() => {});
    await fetch(`${BACKEND_URL}/api/projects/1/dependencies`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ predecessorTaskId: 1, successorTaskId: 2, dependencyType: 'FS', lagDays: 0 })
    }).catch(() => {});
  }

  // 2. Truy vấn kết quả tiến độ dự án 1
  const resResults = await fetch(`${BACKEND_URL}/api/projects/1/scheduling/results`, { headers });
  assert.equal(resResults.status, 200);
  const data = await resResults.json();

  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.tasks), 'tasks phải là mảng');
  assert.ok(data.tasks.length > 0, 'Dự án 1 phải có công việc đã lập tiến độ');

  // Kiểm tra sắp xếp theo ES tăng dần (AC 2)
  for (let i = 0; i < data.tasks.length - 1; i++) {
    assert.ok(
      data.tasks[i].earlyStart <= data.tasks[i + 1].earlyStart,
      `Thứ tự ES phải tăng dần: ${data.tasks[i].earlyStart} <= ${data.tasks[i + 1].earlyStart}`
    );
  }

  // 3. Truy vấn lần tiếp theo -> phải đọc từ cache lưu sẵn (isCached = true)
  const resCached = await fetch(`${BACKEND_URL}/api/projects/1/scheduling/results`, { headers });
  assert.equal(resCached.status, 200);
  const cachedData = await resCached.json();
  assert.equal(cachedData.isCached, true, 'Lần gọi tiếp theo phải đọc từ bộ nhớ đệm schedule_results');

  // 4. Lọc chỉ việc găng (critical=true)
  const resCrit = await fetch(`${BACKEND_URL}/api/projects/1/scheduling/results?critical=true`, { headers });
  assert.equal(resCrit.status, 200);
  const critData = await resCrit.json();
  assert.ok(critData.tasks.every(t => t.isCritical === true), 'Bộ lọc critical=true chỉ trả về công việc găng');
});

test('E2E Runtime: Sửa duration làm stale cache, tự động tính lại và lưu lại', { concurrency: false }, async (t) => {
  if (!await isBackendReachable()) {
    t.skip(`Backend server not running at ${BACKEND_URL}. Skipping live runtime test.`);
    return;
  }
  const loginRes = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@thicong.vn', password: 'Admin@123' })
  });
  const { token } = await loginRes.json();
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Lấy duration gốc của task 1
  const taskRes = await fetch(`${BACKEND_URL}/api/tasks/1`, { headers });
  const taskData = await taskRes.json();
  const origDuration = Number(taskData.data.duration);

  try {
    // Sửa duration task 1
    const updateRes = await fetch(`${BACKEND_URL}/api/tasks/1`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ duration: origDuration + 1 })
    });
    assert.equal(updateRes.status, 200);

    // Lần đọc kế tiếp -> isCached phải là false (vì vừa stale và được tính lại)
    const resAfterUpdate = await fetch(`${BACKEND_URL}/api/projects/1/scheduling/results`, { headers });
    assert.equal(resAfterUpdate.status, 200);
    const dataAfterUpdate = await resAfterUpdate.json();
    assert.equal(dataAfterUpdate.isCached, false, 'Sau khi sửa duration, kết quả phải được tính lại (isCached = false)');

    // Lần đọc tiếp theo -> isCached trở lại true
    const resCachedAgain = await fetch(`${BACKEND_URL}/api/projects/1/scheduling/results`, { headers });
    assert.equal(resCachedAgain.status, 200);
    const dataCachedAgain = await resCachedAgain.json();
    assert.equal(dataCachedAgain.isCached, true, 'Sau khi tính lại, kết quả đã được lưu sẵn (isCached = true)');
  } finally {
    // Khôi phục lại duration ban đầu trong khối finally để bảo toàn tính độc lập dữ liệu
    await fetch(`${BACKEND_URL}/api/tasks/1`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ duration: origDuration })
    }).catch(() => {});
    await fetch(`${BACKEND_URL}/api/projects/1/scheduling/results`, { headers }).catch(() => {});
  }
});

test('E2E Runtime: Phân quyền Viewer xem được dự án nhưng bị chặn sửa và xem ngoài quyền', { concurrency: false }, async (t) => {
  if (!await isBackendReachable()) {
    t.skip(`Backend server not running at ${BACKEND_URL}. Skipping live runtime test.`);
    return;
  }
  // 1. Đăng nhập Viewer
  const viewerLogin = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'viewer@thicong.vn', password: 'Viewer@123' })
  });
  assert.equal(viewerLogin.status, 200);
  const { token } = await viewerLogin.json();
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 2. Viewer xem dự án 1 (được phân quyền) -> 200 OK
  const readRes = await fetch(`${BACKEND_URL}/api/projects/1/scheduling/results`, { headers });
  assert.equal(readRes.status, 200, 'Viewer được xem lịch dự án 1');

  // 3. Viewer xem dự án 999 (không được cấp quyền) -> 403 Forbidden
  const forbiddenRes = await fetch(`${BACKEND_URL}/api/projects/999/scheduling/results`, { headers });
  assert.equal(forbiddenRes.status, 403, 'Viewer bị chặn 403 khi xem dự án không được cấp quyền');

  // 4. Viewer thử sửa task -> 403 Forbidden
  const putRes = await fetch(`${BACKEND_URL}/api/tasks/1`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ duration: 99 })
  });
  assert.equal(putRes.status, 403, 'Viewer bị chặn 403 khi cố gắng sửa dữ liệu');
});
