const mysql = require('mysql2');
require('dotenv').config();
const { SEED_ROLES, findUserByEmail } = require('./src/models/store');

let pool = null;

try {
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'db',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'secret',
    database: process.env.DB_NAME || 'quanly_thicong',
  charset: "utf8mb4",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  }).promise();
} catch (err) {
  console.warn('[DB] Không thể tạo MySQL pool, sẽ sử dụng in-memory store:', err.message);
}

// Hàm khởi tạo bảng và seed 6 vai trò khi kết nối MySQL thành công (SCRUM-29 / T-04)
async function initDbSchema(maxRetries = 10, delayMs = 1500) {
  if (!pool) return;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 1. Tạo bảng roles
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 2. Tạo bảng users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        salt VARCHAR(64) NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        role_id INT,
        failed_login_attempts INT DEFAULT 0,
        locked_until DATETIME NULL,
        is_active BOOLEAN DEFAULT TRUE,
        last_login_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 3. Tạo bảng projects (Quản lý dự án thi công)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50) NOT NULL UNIQUE,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Seed dự án mặc định (id = 1)
    await pool.query(`
      INSERT INTO projects (id, name, code, description)
      VALUES (1, 'Dự án Thi Công Mẫu', 'DA-01', 'Dự án mẫu quản trị tiến độ thi công')
      ON DUPLICATE KEY UPDATE name = VALUES(name);
    `);

    // 4. Tạo bảng work_items (Cơ cấu công việc WBS)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        project_id INT NOT NULL,
        parent_id INT NULL,
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50) NULL,
        unit VARCHAR(50) NULL,
        quantity DECIMAL(12,2) DEFAULT 0,
        status ENUM('pending', 'in_progress', 'completed') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES work_items(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Seed hạng mục WBS mẫu (id = 1)
    await pool.query(`
      INSERT INTO work_items (id, project_id, name, code, unit, quantity, status)
      VALUES (1, 1, 'Thi công phần móng', 'WBS-01', 'Gói', 1, 'in_progress')
      ON DUPLICATE KEY UPDATE name = VALUES(name);
    `);

    // 5. Tạo bảng tasks (S-05 / SCRUM-60 / T-11: Khai báo công việc có thời lượng gắn vào hạng mục WBS)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        project_id INT NOT NULL,
        work_item_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50) NULL,
        duration DECIMAL(8,2) NOT NULL,
        status ENUM('pending', 'in_progress', 'completed') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_tasks_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CONSTRAINT fk_tasks_work_item FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Seed các công việc mẫu (task 1: CV-01, task 2: CV-02)
    await pool.query(`
      INSERT INTO tasks (id, project_id, work_item_id, name, code, duration, status)
      VALUES
        (1, 1, 1, 'Đào đất hố móng trụ T1', 'CV-01', 5.00, 'pending'),
        (2, 1, 1, 'Đổ bê tông lót móng', 'CV-02', 3.00, 'pending')
      ON DUPLICATE KEY UPDATE name = VALUES(name);
    `);

    // 6. Tạo bảng project_members (Phân quyền người xem / thành viên dự án)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_members (
        project_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, user_id),
        CONSTRAINT fk_pm_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CONSTRAINT fk_pm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 7. Tạo bảng task_dependencies (S-06 / SCRUM-61: Quan hệ phụ thuộc công việc FS, SS, FF, SF và lag)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_dependencies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        project_id INT NOT NULL,
        predecessor_task_id INT NOT NULL,
        successor_task_id INT NOT NULL,
        dependency_type ENUM('FS', 'SS', 'FF', 'SF') NOT NULL DEFAULT 'FS',
        lag_days DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (predecessor_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (successor_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        UNIQUE KEY unique_dependency_pair (predecessor_task_id, successor_task_id),
        INDEX idx_deps_project (project_id),
        INDEX idx_deps_pred (predecessor_task_id),
        INDEX idx_deps_succ (successor_task_id),
        CONSTRAINT chk_no_self_loop CHECK (predecessor_task_id <> successor_task_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 8. Tạo bảng schedule_results & project_schedule_status (S-12 / SCRUM-67: Bảng tiến độ và việc găng)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schedule_results (
        id INT AUTO_INCREMENT PRIMARY KEY,
        project_id INT NOT NULL,
        task_id INT NOT NULL,
        early_start DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
        early_finish DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
        late_start DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
        late_finish DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
        total_float DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
        is_critical BOOLEAN NOT NULL DEFAULT FALSE,
        is_stale BOOLEAN NOT NULL DEFAULT FALSE,
        calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_project_task (project_id, task_id),
        INDEX idx_sr_project_es (project_id, early_start, task_id),
        INDEX idx_sr_project_crit (project_id, is_critical),
        INDEX idx_sr_task (task_id),
        CONSTRAINT fk_sr_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CONSTRAINT fk_sr_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_schedule_status (
        project_id INT PRIMARY KEY,
        needs_recalculation BOOLEAN NOT NULL DEFAULT TRUE,
        project_duration DECIMAL(8, 2) NULL,
        calculated_at TIMESTAMP NULL,
        has_cycle BOOLEAN NOT NULL DEFAULT FALSE,
        cycle_info TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_pss_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 9. Tạo bảng daily_volume_reports (S-26 / SCRUM-118: Báo cáo KL hằng ngày và lũy kế)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_volume_reports (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        project_id    INT            NOT NULL,
        work_item_id  INT            NOT NULL,
        reported_by   INT            NOT NULL,
        report_date   DATE           NOT NULL,
        quantity      DECIMAL(14, 4) NOT NULL,
        note          TEXT           NULL,
        reported_at   TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_dvr_team_item_date (project_id, work_item_id, reported_by, report_date),
        INDEX idx_dvr_project_item (project_id, work_item_id),
        INDEX idx_dvr_project_date (project_id, report_date),
        INDEX idx_dvr_reported_by  (reported_by),
        CONSTRAINT fk_dvr_project   FOREIGN KEY (project_id)   REFERENCES projects(id)   ON DELETE CASCADE,
        CONSTRAINT fk_dvr_work_item FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        CONSTRAINT fk_dvr_user      FOREIGN KEY (reported_by)  REFERENCES users(id)      ON DELETE RESTRICT,
        CONSTRAINT chk_dvr_quantity CHECK (quantity >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Seed 7 vai trò thi công xây dựng
    for (const r of SEED_ROLES) {
      await pool.query(`
        INSERT INTO roles (id, name, display_name, description)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), description = VALUES(description);
      `, [r.id, r.name, r.display_name, r.description]);
    }
    console.log('[DB] Đã seed 7 vai trò thi công xây dựng thành công (SCRUM-29 & Sprint 2)!');

    // Seed tài khoản admin, PM và Người xem dự án mẫu
    const { inMemoryUsers } = require('./src/models/store');
    for (const u of inMemoryUsers) {
      await pool.query(`
        INSERT INTO users (id, email, password_hash, salt, full_name, role_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), role_id = VALUES(role_id);
      `, [u.id, u.email, u.password_hash, u.salt, u.full_name, u.role_id]);
    }

    // Gán quyền thành viên dự án mẫu 1 cho Admin (1), PM (2), Viewer (3)
    await pool.query(`
      INSERT IGNORE INTO project_members (project_id, user_id) VALUES (1, 1), (1, 2), (1, 3);
    `);

    // Sửa triệt để lỗi font/mojibake dữ liệu mẫu WBS và tasks theo cách idempotent
    await pool.query(`
      UPDATE work_items
      SET name = 'Thi công phần móng'
      WHERE code = 'WBS-01' OR (project_id = 1 AND (name LIKE '%ph%n m%ng%' OR name LIKE 'Thi c%ng%'));
    `);
    await pool.query(`
      UPDATE tasks
      SET name = 'Đào đất hố móng trụ T1'
      WHERE code = 'CV-01' OR (project_id = 1 AND (name LIKE '%o d%t h% m%ng%' OR name LIKE '%tr% T1%'));
    `);
    await pool.query(`
      UPDATE tasks
      SET name = 'Đổ bê tông lót móng'
      WHERE code = 'CV-02' OR (project_id = 1 AND (name LIKE '%b% t%ng l%t m%ng%' OR name LIKE '%l%t m%ng%'));
    `);

    // Seed quan hệ phụ thuộc mẫu: CV-01 -> CV-02, Loại FS, lag 0
    await pool.query(`
      INSERT IGNORE INTO task_dependencies (project_id, predecessor_task_id, successor_task_id, dependency_type, lag_days)
      SELECT 1, 1, 2, 'FS', 0.00
      FROM DUAL
      WHERE EXISTS (SELECT 1 FROM tasks WHERE id = 1)
        AND EXISTS (SELECT 1 FROM tasks WHERE id = 2)
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies WHERE predecessor_task_id = 1 AND successor_task_id = 2
        );
    `);

    // Đồng bộ người dùng đã đăng ký từ MySQL vào bộ nhớ
    const [rows] = await pool.query(`
      SELECT u.id, u.email, u.password_hash, u.salt, u.full_name, u.role_id, r.name as role_name, r.display_name as role_display_name
      FROM users u LEFT JOIN roles r ON u.role_id = r.id
    `);
    if (rows && rows.length > 0) {
      for (const row of rows) {
        if (!inMemoryUsers.some(im => im.email.toLowerCase() === row.email.toLowerCase())) {
          inMemoryUsers.push({
            id: row.id,
            email: row.email.toLowerCase(),
            password_hash: row.password_hash,
            salt: row.salt,
            full_name: row.full_name,
            role_id: row.role_id,
            role_name: row.role_name,
            role_display_name: row.role_display_name,
            failed_login_attempts: 0,
            locked_until: null,
            is_active: true
          });
        }
      }
    }
    console.log(`[DB] Đã đồng bộ ${inMemoryUsers.length} tài khoản người dùng sẵn sàng.`);
    return;
  } catch (err) {
    if (attempt < maxRetries) {
      console.warn(`[DB] Đang đợi MySQL sẵn sàng (lần ${attempt}/${maxRetries}): ${err.message}. Thử lại sau ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    } else {
      console.warn('[DB] Lưu ý khi tạo schema MySQL:', err.message);
    }
  }
}
}

module.exports = {
  pool,
  initDbSchema
};
