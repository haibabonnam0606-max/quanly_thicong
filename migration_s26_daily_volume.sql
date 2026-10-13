-- ==============================================================================
-- MIGRATION S-26 (SCRUM-118): BÁO CÁO KHỐI LƯỢNG HẰNG NGÀY VÀ LŨY KẾ
-- AC: API lưu báo cáo khối lượng hằng ngày kèm timestamp, tính tổng lũy kế
--     đội đã báo; cho phép lũy kế vượt khối lượng kế hoạch kèm cảnh báo phát sinh.
-- NFR: Đảm bảo toàn vẹn dữ liệu báo cáo lũy kế trong transaction.
-- Deps: T-50 (work_items đã tồn tại)
-- Thiết kế idempotent, an toàn với dữ liệu hiện có
-- ==============================================================================

-- Bảng báo cáo khối lượng hằng ngày của đội thi công
CREATE TABLE IF NOT EXISTS daily_volume_reports (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  project_id    INT            NOT NULL,
  work_item_id  INT            NOT NULL,
  reported_by   INT            NOT NULL,          -- user_id của người/đội báo cáo
  report_date   DATE           NOT NULL,           -- Ngày báo cáo (YYYY-MM-DD)
  quantity      DECIMAL(14, 4) NOT NULL,           -- Khối lượng báo trong ngày (>= 0)
  note          TEXT           NULL,               -- Ghi chú tùy chọn
  reported_at   TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,  -- Timestamp nộp báo cáo
  updated_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Mỗi đội chỉ báo cáo một lần mỗi ngày cho một hạng mục của dự án
  UNIQUE KEY uq_dvr_team_item_date (project_id, work_item_id, reported_by, report_date),

  INDEX idx_dvr_project_item     (project_id, work_item_id),
  INDEX idx_dvr_project_date     (project_id, report_date),
  INDEX idx_dvr_reported_by      (reported_by),

  CONSTRAINT fk_dvr_project   FOREIGN KEY (project_id)   REFERENCES projects(id)    ON DELETE CASCADE,
  CONSTRAINT fk_dvr_work_item FOREIGN KEY (work_item_id) REFERENCES work_items(id)  ON DELETE CASCADE,
  CONSTRAINT fk_dvr_user      FOREIGN KEY (reported_by)  REFERENCES users(id)       ON DELETE RESTRICT,
  CONSTRAINT chk_dvr_quantity CHECK (quantity >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
