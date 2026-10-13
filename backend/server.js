const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const db = require('./db');
const authController = require('./src/controllers/authController');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Header chống lưu bộ nhớ đệm (Chống nút Back trình duyệt truy cập lại trang bảo vệ sau đăng xuất)
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Phục vụ giao diện người dùng frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// API kiem tra trang thai server (S-01)
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Backend quan ly thi cong dang hoat dong' });
});

// API kiem tra ket noi database (S-01)
app.get('/api/db-check', async (req, res) => {
  try {
    if (db.pool) {
      const [rows] = await db.pool.query('SELECT 1 + 1 AS solution');
      return res.json({ status: 'Connected', data: rows });
    }
    res.json({ status: 'Standalone', message: 'Đang chạy in-memory store (chưa kết nối MySQL container)' });
  } catch (error) {
    res.status(500).json({ status: 'Error', message: error.message });
  }
});

// ==========================================
// CÁC ENDPOINT CHO SPRINT S-02 (SCRUM-19)
// ==========================================
// Đăng nhập, đếm lần sai và khóa 15 phút (SCRUM-30 / T-05)
app.post('/api/auth/login', authController.login);

// Đăng ký tài khoản người dùng mới
app.post('/api/auth/register', authController.register);

// Lấy thông tin người dùng từ phiên hiện tại
app.get('/api/auth/me', authController.getMe);

// Đăng xuất - hủy phiên làm việc
app.post('/api/auth/logout', authController.logout);

// Danh sách 6 vai trò đã seed (SCRUM-29 / T-04)
app.get('/api/auth/roles', authController.getRoles);

// Mở khóa nhanh tài khoản (dành cho test/dev)
app.post('/api/auth/unlock-dev', authController.unlockDev);

// Điều hướng trang mặc định
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/register.html'));
});

app.get('/schedule', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/schedule.html'));
});

app.get('/daily-volume', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/daily-volume.html'));
});

// Middleware xác thực token phiên
const { authenticate } = require('./src/utils/rbac');
app.use(authenticate);

// Quản lý dự án thi công
const projectRoutes = require('./src/routes/projectRoutes');
app.use('/api', projectRoutes(db));

const wbsRoutes = require("./wbs_routes");
app.use("/api", wbsRoutes(db));

// Sprint 2: S-05 (Tasks có thời lượng) & S-06 (Quan hệ phụ thuộc) & S-07 (Thứ tự phụ thuộc & phát hiện vòng)
const taskRoutes = require("./src/routes/taskRoutes");
app.use("/api", taskRoutes(db));

const dependencyRoutes = require("./src/routes/dependencyRoutes");
app.use("/api", dependencyRoutes(db));

const schedulingRoutes = require("./src/routes/schedulingRoutes");
app.use("/api", schedulingRoutes(db));

// S-26 (SCRUM-118): Báo cáo khối lượng hằng ngày và lũy kế
const dailyVolumeRoutes = require("./src/routes/dailyVolumeRoutes");
app.use("/api", dailyVolumeRoutes(db));

app.listen(PORT, async () => {
  console.log(`===================================================`);
  console.log(`🚀 Backend Quản lý thi công đang chạy tại port ${PORT}`);
  console.log(`👉 Link giao diện đăng nhập: http://localhost:${PORT}/login.html`);
  console.log(`👉 Link trang chính (được bảo vệ): http://localhost:${PORT}/index.html`);
  console.log(`===================================================`);

  if (db.initDbSchema) {
    await db.initDbSchema();
  }
});

module.exports = app;
