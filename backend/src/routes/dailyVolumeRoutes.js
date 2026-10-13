/**
 * Daily Volume Routes (S-26 / SCRUM-118)
 *
 * POST /api/projects/:projectId/daily-volume
 *   - Lưu báo cáo KL hằng ngày kèm timestamp
 *   - Tự động tính lũy kế, cảnh báo vượt KL kế hoạch
 *   - Toàn vẹn dữ liệu trong database transaction (NFR)
 *
 * GET  /api/projects/:projectId/daily-volume
 *   - Lấy danh sách báo cáo (lọc theo work_item, đội, khoảng ngày)
 *
 * GET  /api/projects/:projectId/daily-volume/summary
 *   - Lũy kế KL theo từng hạng mục WBS, kèm cờ cảnh báo vượt kế hoạch
 */

const express = require('express');
const { checkViewerForbidden, checkProjectReadAccess } = require('../utils/rbac');
const { DailyVolumeRepository } = require('../repositories/dailyVolumeRepository');

module.exports = (db) => {
  const router = express.Router();
  const dailyVolumeRepo = new DailyVolumeRepository(db);

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Validate YYYY-MM-DD */
  function isValidDate(str) {
    if (typeof str !== 'string') return false;
    return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str));
  }

  // ── POST /api/projects/:projectId/daily-volume ────────────────────────────
  router.post('/projects/:projectId/daily-volume', async (req, res) => {
    // Viewer bị cấm ghi dữ liệu
    if (checkViewerForbidden(req, res)) return;

    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'projectId không hợp lệ' });
    }

    const { work_item_id, report_date, quantity, note } = req.body;

    // Validation: work_item_id
    const workItemId = Number(work_item_id);
    if (!Number.isInteger(workItemId) || workItemId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Phải chọn hạng mục WBS hợp lệ (work_item_id)'
      });
    }

    // Validation: report_date
    if (!isValidDate(report_date)) {
      return res.status(400).json({
        success: false,
        message: 'Ngày báo cáo (report_date) không hợp lệ, định dạng yêu cầu: YYYY-MM-DD'
      });
    }

    // Validation: quantity
    if (quantity === undefined || quantity === null || quantity === '') {
      return res.status(400).json({
        success: false,
        message: 'Khối lượng báo cáo (quantity) không được để trống'
      });
    }
    const quantityNum = Number(quantity);
    if (isNaN(quantityNum) || !Number.isFinite(quantityNum) || quantityNum < 0) {
      return res.status(400).json({
        success: false,
        message: 'Khối lượng báo cáo phải là số không âm'
      });
    }

    // Người báo cáo: lấy từ token phiên đăng nhập
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Yêu cầu xác thực: Vui lòng đăng nhập để nộp báo cáo'
      });
    }
    const reportedBy = req.user.id;

    try {
      const result = await dailyVolumeRepo.submitReport({
        projectId,
        workItemId,
        reportedBy,
        reportDate: report_date,
        quantity:   quantityNum,
        note:       note ?? null
      });

      const response = {
        success: true,
        id:                  result.id,
        isNew:               result.isNew,
        cumulativeQuantity:  result.cumulativeQuantity,
        plannedQuantity:     result.plannedQuantity,
        isOverPlan:          result.isOverPlan,
        message:             result.isNew
          ? 'Nộp báo cáo khối lượng thành công'
          : 'Cập nhật báo cáo khối lượng thành công'
      };

      // Cảnh báo vượt KL kế hoạch (AC: cho phép vượt nhưng kèm cảnh báo)
      if (result.isOverPlan) {
        response.warning =
          `Lũy kế khối lượng đã báo (${result.cumulativeQuantity}) vượt khối lượng kế hoạch ` +
          `(${result.plannedQuantity}) của hạng mục này. Cần xem xét điều chỉnh kế hoạch.`;
      }

      return res.status(result.isNew ? 201 : 200).json(response);
    } catch (err) {
      const isValidationErr = /không tồn tại|không thuộc|không hợp lệ|phải là/.test(err.message);
      return res.status(isValidationErr ? 400 : 500).json({
        success: false,
        message: isValidationErr
          ? err.message
          : 'Không thể lưu báo cáo khối lượng. Vui lòng thử lại.'
      });
    }
  });

  // ── GET /api/projects/:projectId/daily-volume ─────────────────────────────
  router.get('/projects/:projectId/daily-volume', async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'projectId không hợp lệ' });
    }
    if (checkProjectReadAccess(req, res, projectId)) return;

    const workItemId  = req.query.work_item_id ? Number(req.query.work_item_id) : undefined;
    const reportedBy  = req.query.reported_by  ? Number(req.query.reported_by)  : undefined;
    const fromDate    = req.query.from_date     || undefined;
    const toDate      = req.query.to_date       || undefined;

    if (fromDate && !isValidDate(fromDate)) {
      return res.status(400).json({ success: false, message: 'from_date không hợp lệ (YYYY-MM-DD)' });
    }
    if (toDate && !isValidDate(toDate)) {
      return res.status(400).json({ success: false, message: 'to_date không hợp lệ (YYYY-MM-DD)' });
    }

    try {
      const rows = await dailyVolumeRepo.getReports(projectId, {
        workItemId,
        reportedBy,
        fromDate,
        toDate
      });
      return res.json({ success: true, data: rows, total: rows.length });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── GET /api/projects/:projectId/daily-volume/summary ────────────────────
  router.get('/projects/:projectId/daily-volume/summary', async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ success: false, message: 'projectId không hợp lệ' });
    }
    if (checkProjectReadAccess(req, res, projectId)) return;

    const workItemId = req.query.work_item_id ? Number(req.query.work_item_id) : undefined;
    const fromDate   = req.query.from_date     || undefined;
    const toDate     = req.query.to_date       || undefined;

    if (fromDate && !isValidDate(fromDate)) {
      return res.status(400).json({ success: false, message: 'from_date không hợp lệ (YYYY-MM-DD)' });
    }
    if (toDate && !isValidDate(toDate)) {
      return res.status(400).json({ success: false, message: 'to_date không hợp lệ (YYYY-MM-DD)' });
    }

    try {
      const summary = await dailyVolumeRepo.getCumulativeSummary(projectId, {
        workItemId,
        fromDate,
        toDate
      });

      const overPlanItems = summary.filter(s => s.isOverPlan);

      return res.json({
        success:        true,
        data:           summary,
        total:          summary.length,
        overPlanCount:  overPlanItems.length,
        warnings:       overPlanItems.map(s =>
          `Hạng mục "${s.workItemName}" (${s.workItemCode ?? s.workItemId}): ` +
          `lũy kế ${s.cumulativeQuantity} vượt kế hoạch ${s.plannedQuantity}`
        )
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
};
