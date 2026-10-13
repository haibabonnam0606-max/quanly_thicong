/**
 * DailyVolumeRepository (S-26 / SCRUM-118)
 * Quản lý báo cáo khối lượng hằng ngày và tính lũy kế theo đội / hạng mục WBS.
 *
 * AC:
 *  - Lưu báo cáo KL hằng ngày kèm timestamp (reported_at)
 *  - Tính tổng lũy kế đội đã báo
 *  - Cho phép lũy kế vượt KL kế hoạch kèm cảnh báo
 * NFR:
 *  - Đảm bảo toàn vẹn dữ liệu lũy kế trong database transaction
 */

class DailyVolumeRepository {
  constructor(db) {
    this.pool = db?.pool || db;
  }

  isDatabaseAvailable() {
    return Boolean(
      this.pool &&
      typeof this.pool.query === 'function' &&
      typeof this.pool.getConnection === 'function'
    );
  }

  /**
   * Lưu (hoặc cập nhật) báo cáo khối lượng hằng ngày trong một transaction.
   * Nếu đội đã báo ngày đó → cập nhật (ON DUPLICATE KEY UPDATE).
   *
   * @param {object} params
   * @param {number} params.projectId
   * @param {number} params.workItemId
   * @param {number} params.reportedBy     - user_id của người báo cáo
   * @param {string} params.reportDate     - 'YYYY-MM-DD'
   * @param {number} params.quantity       - Khối lượng hôm nay (>= 0)
   * @param {string} [params.note]         - Ghi chú tùy chọn
   * @returns {Promise<{id: number, isNew: boolean, cumulativeQuantity: number, plannedQuantity: number|null, isOverPlan: boolean}>}
   */
  async submitReport({ projectId, workItemId, reportedBy, reportDate, quantity, note }) {
    if (!this.isDatabaseAvailable()) {
      throw new Error('Kết nối cơ sở dữ liệu chưa sẵn sàng');
    }

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Kiểm tra work_item tồn tại và thuộc project; lấy quantity kế hoạch (nếu có)
      const [wiRows] = await conn.query(
        'SELECT id, project_id, quantity AS planned_quantity FROM work_items WHERE id = ? FOR SHARE',
        [workItemId]
      );
      if (wiRows.length === 0) {
        throw new Error('Hạng mục WBS không tồn tại');
      }
      if (wiRows[0].project_id !== projectId) {
        throw new Error('Hạng mục WBS không thuộc dự án đã chọn');
      }
      const plannedQuantity = wiRows[0].planned_quantity !== null
        ? Number(wiRows[0].planned_quantity)
        : null;

      // 2. Kiểm tra bản ghi cũ để biết isNew
      const [existingRows] = await conn.query(
        `SELECT id FROM daily_volume_reports
         WHERE project_id = ? AND work_item_id = ? AND reported_by = ? AND report_date = ?`,
        [projectId, workItemId, reportedBy, reportDate]
      );
      const isNew = existingRows.length === 0;

      // 3. Upsert báo cáo (mỗi đội báo 1 lần/ngày/hạng mục)
      const [upsertResult] = await conn.query(
        `INSERT INTO daily_volume_reports
           (project_id, work_item_id, reported_by, report_date, quantity, note)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           quantity    = VALUES(quantity),
           note        = VALUES(note),
           updated_at  = NOW()`,
        [projectId, workItemId, reportedBy, reportDate, quantity, note ?? null]
      );

      const reportId = isNew ? upsertResult.insertId : existingRows[0].id;

      // 4. Tính tổng lũy kế của tất cả đội cho hạng mục này (trong cùng project)
      const [cumRows] = await conn.query(
        `SELECT COALESCE(SUM(quantity), 0) AS cumulative_quantity
         FROM daily_volume_reports
         WHERE project_id = ? AND work_item_id = ?`,
        [projectId, workItemId]
      );
      const cumulativeQuantity = Number(cumRows[0].cumulative_quantity);

      // 5. Kiểm tra vượt kế hoạch
      const isOverPlan = plannedQuantity !== null && cumulativeQuantity > plannedQuantity;

      await conn.commit();

      return {
        id: reportId,
        isNew,
        cumulativeQuantity,
        plannedQuantity,
        isOverPlan
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Lấy danh sách báo cáo KL hằng ngày của một hạng mục / dự án.
   * Hỗ trợ lọc theo khoảng ngày và đội.
   *
   * @param {number} projectId
   * @param {object} [filters]
   * @param {number} [filters.workItemId]
   * @param {number} [filters.reportedBy]
   * @param {string} [filters.fromDate]   - 'YYYY-MM-DD'
   * @param {string} [filters.toDate]     - 'YYYY-MM-DD'
   * @returns {Promise<Array>}
   */
  async getReports(projectId, { workItemId, reportedBy, fromDate, toDate } = {}) {
    if (!this.isDatabaseAvailable()) {
      throw new Error('Kết nối cơ sở dữ liệu chưa sẵn sàng');
    }

    let query = `
      SELECT
        dvr.id,
        dvr.project_id,
        dvr.work_item_id,
        wi.name  AS work_item_name,
        wi.code  AS work_item_code,
        dvr.reported_by,
        u.full_name AS reporter_name,
        dvr.report_date,
        CAST(dvr.quantity AS DOUBLE) AS quantity,
        dvr.note,
        dvr.reported_at,
        dvr.updated_at
      FROM daily_volume_reports dvr
      JOIN work_items wi ON dvr.work_item_id = wi.id
      JOIN users      u  ON dvr.reported_by  = u.id
      WHERE dvr.project_id = ?
    `;
    const params = [projectId];

    if (workItemId) {
      query += ' AND dvr.work_item_id = ?';
      params.push(workItemId);
    }
    if (reportedBy) {
      query += ' AND dvr.reported_by = ?';
      params.push(reportedBy);
    }
    if (fromDate) {
      query += ' AND dvr.report_date >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      query += ' AND dvr.report_date <= ?';
      params.push(toDate);
    }

    query += ' ORDER BY dvr.report_date DESC, dvr.work_item_id ASC, dvr.reported_by ASC';

    const [rows] = await this.pool.query(query, params);
    return rows;
  }

  /**
   * Tính lũy kế khối lượng đã báo cho từng hạng mục trong dự án.
   * Kèm cảnh báo nếu lũy kế vượt khối lượng kế hoạch.
   *
   * @param {number} projectId
   * @param {object} [filters]
   * @param {number} [filters.workItemId]
   * @param {string} [filters.fromDate]
   * @param {string} [filters.toDate]
   * @returns {Promise<Array<{workItemId, workItemName, plannedQuantity, cumulativeQuantity, isOverPlan}>>}
   */
  async getCumulativeSummary(projectId, { workItemId, fromDate, toDate } = {}) {
    if (!this.isDatabaseAvailable()) {
      throw new Error('Kết nối cơ sở dữ liệu chưa sẵn sàng');
    }

    let query = `
      SELECT
        wi.id                                   AS workItemId,
        wi.name                                 AS workItemName,
        wi.code                                 AS workItemCode,
        CAST(wi.quantity AS DOUBLE)             AS plannedQuantity,
        COALESCE(SUM(dvr.quantity), 0)          AS cumulativeQuantity,
        COUNT(DISTINCT dvr.id)                  AS reportCount,
        MIN(dvr.report_date)                    AS firstReportDate,
        MAX(dvr.report_date)                    AS lastReportDate
      FROM work_items wi
      LEFT JOIN daily_volume_reports dvr
        ON dvr.work_item_id = wi.id
        AND dvr.project_id  = ?
    `;
    const params = [projectId];

    const where = ['wi.project_id = ?'];
    params.push(projectId);

    if (workItemId) {
      where.push('wi.id = ?');
      params.push(workItemId);
    }
    if (fromDate) {
      where.push('(dvr.report_date IS NULL OR dvr.report_date >= ?)');
      params.push(fromDate);
    }
    if (toDate) {
      where.push('(dvr.report_date IS NULL OR dvr.report_date <= ?)');
      params.push(toDate);
    }

    query += ` WHERE ${where.join(' AND ')}`;
    query += ' GROUP BY wi.id, wi.name, wi.code, wi.quantity';
    query += ' ORDER BY wi.id ASC';

    const [rows] = await this.pool.query(query, params);

    return rows.map(r => ({
      workItemId:          r.workItemId,
      workItemName:        r.workItemName,
      workItemCode:        r.workItemCode,
      plannedQuantity:     r.plannedQuantity !== null ? Number(r.plannedQuantity) : null,
      cumulativeQuantity:  Number(r.cumulativeQuantity),
      reportCount:         Number(r.reportCount),
      firstReportDate:     r.firstReportDate,
      lastReportDate:      r.lastReportDate,
      isOverPlan:          r.plannedQuantity !== null
                             ? Number(r.cumulativeQuantity) > Number(r.plannedQuantity)
                             : false
    }));
  }
}

module.exports = { DailyVolumeRepository };
