const LogbookCase = require('../models/LogbookCase');
const Shift = require('../models/Shift');
const Notification = require('../models/Notification');
const Course = require('../models/Course');
const { createNotification, notifyCourseInstructors } = require('../controllers/notificationController');

const PRECEPTOR_BACKLOG_HOURS = 48;
const INSTRUCTOR_BACKLOG_HOURS = 120; // 5 days
const DEDUPE_WINDOW_HOURS = 24;
const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // Every 6 hours

let monitorTimer = null;

async function runPendingBacklogScan() {
  try {
    const now = Date.now();
    const preceptorCutoff = new Date(now - PRECEPTOR_BACKLOG_HOURS * 60 * 60 * 1000);
    const instructorCutoff = new Date(now - INSTRUCTOR_BACKLOG_HOURS * 60 * 60 * 1000);
    const dedupeCutoff = new Date(now - DEDUPE_WINDOW_HOURS * 60 * 60 * 1000);

    // Run preceptor (>48h) and course escalation (>5d) aggregations in parallel.
    const [
      pendingCasesByPreceptor,
      pendingShiftsByPreceptor,
      staleCasesByCourse,
      staleShiftsByCourse,
    ] = await Promise.all([
      LogbookCase.aggregate([
        { $match: { evaluation_status: 'pending', createdAt: { $lte: preceptorCutoff }, preceptor_id: { $ne: null } } },
        { $group: { _id: '$preceptor_id', count: { $sum: 1 } } },
      ]),
      Shift.aggregate([
        { $match: { verify_status: 'pending', createdAt: { $lte: preceptorCutoff }, preceptor_id: { $ne: null } } },
        { $group: { _id: '$preceptor_id', count: { $sum: 1 } } },
      ]),
      LogbookCase.aggregate([
        { $match: { evaluation_status: 'pending', createdAt: { $lte: instructorCutoff }, procedure_id: { $ne: null } } },
        {
          $lookup: {
            from: 'procedures',
            localField: 'procedure_id',
            foreignField: '_id',
            as: 'procedure',
          },
        },
        { $unwind: '$procedure' },
        { $match: { 'procedure.course_id': { $ne: null } } },
        { $group: { _id: '$procedure.course_id', count: { $sum: 1 } } },
      ]),
      Shift.aggregate([
        { $match: { verify_status: 'pending', createdAt: { $lte: instructorCutoff }, course_id: { $ne: null } } },
        { $group: { _id: '$course_id', count: { $sum: 1 } } },
      ]),
    ]);

    const preceptorTotals = new Map();
    for (const row of pendingCasesByPreceptor) {
      const id = String(row._id);
      preceptorTotals.set(id, { cases: row.count, shifts: 0 });
    }
    for (const row of pendingShiftsByPreceptor) {
      const id = String(row._id);
      const entry = preceptorTotals.get(id) || { cases: 0, shifts: 0 };
      entry.shifts = row.count;
      preceptorTotals.set(id, entry);
    }

    const courseTotals = new Map();
    for (const row of staleCasesByCourse) {
      const cid = String(row._id);
      courseTotals.set(cid, { cases: row.count, shifts: 0 });
    }
    for (const row of staleShiftsByCourse) {
      const cid = String(row._id);
      const entry = courseTotals.get(cid) || { cases: 0, shifts: 0 };
      entry.shifts = row.count;
      courseTotals.set(cid, entry);
    }

    if (preceptorTotals.size === 0 && courseTotals.size === 0) {
      return;
    }

    // Batch-load recent backlog alerts once instead of N+1 exists/regex queries inside loops.
    const recentBacklogAlerts = await Notification.find({
      type: 'pending_backlog_alert',
      created_at: { $gte: dedupeCutoff },
    })
      .select('recipient_id action_url message')
      .lean();

    const alertedPreceptorIds = new Set(recentBacklogAlerts.map((n) => String(n.recipient_id)));
    const courseEscalationMessages = recentBacklogAlerts
      .filter((n) => n.action_url === '/admin/progress' && typeof n.message === 'string')
      .map((n) => n.message);

    for (const [preceptorId, counts] of preceptorTotals.entries()) {
      if (alertedPreceptorIds.has(preceptorId)) continue;
      const parts = [];
      if (counts.cases > 0) parts.push(`เคสหัตถการ ${counts.cases} รายการ`);
      if (counts.shifts > 0) parts.push(`การเข้าเวร ${counts.shifts} รายการ`);
      if (parts.length === 0) continue;

      const primaryUrl = counts.cases > 0 ? '/evaluate-procedures' : '/verify-shifts';
      await createNotification({
        recipient_id: preceptorId,
        sender_id: preceptorId,
        type: 'pending_backlog_alert',
        severity: 'warning',
        action_url: primaryUrl,
        sendPush: true,
        allowSelfPush: true,
        message: `มีรายการรอตรวจสอบค้างเกิน ${PRECEPTOR_BACKLOG_HOURS} ชั่วโมง: ${parts.join(' และ ')}`,
      });
    }

    if (courseTotals.size > 0) {
      const courses = await Course.find({ _id: { $in: [...courseTotals.keys()] } })
        .select('course_code course_name')
        .lean();
      const courseMap = new Map(courses.map((c) => [String(c._id), c]));

      for (const [courseId, counts] of courseTotals.entries()) {
        const course = courseMap.get(courseId);
        const courseLabel = course?.course_code
          ? `[${course.course_code}] ${course.course_name || ''}`.trim()
          : course?.course_name || 'รายวิชา';
        const parts = [];
        if (counts.cases > 0) parts.push(`เคส ${counts.cases} รายการ`);
        if (counts.shifts > 0) parts.push(`เวร ${counts.shifts} รายการ`);
        if (parts.length === 0) continue;

        const searchToken = String(course?.course_code || courseId);
        const recentlyAlerted = courseEscalationMessages.some((msg) => msg.includes(searchToken));
        if (recentlyAlerted) continue;

        await notifyCourseInstructors({
          courseId,
          type: 'pending_backlog_alert',
          severity: 'warning',
          actionUrl: '/admin/progress',
          sendPush: true,
          message: `พบรายการรอพี่เลี้ยงตรวจค้างเกิน 5 วัน ในรายวิชา ${courseLabel}: ${parts.join(' และ ')}`,
        });
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Pending backlog scan error:', err);
  }
}

function startNotificationMonitor() {
  if (monitorTimer) return;
  const initialDelay = setTimeout(() => {
    void runPendingBacklogScan();
  }, 20000);
  if (typeof initialDelay.unref === 'function') initialDelay.unref();

  monitorTimer = setInterval(() => {
    void runPendingBacklogScan();
  }, SCAN_INTERVAL_MS);
  if (typeof monitorTimer.unref === 'function') monitorTimer.unref();
}

module.exports = {
  runPendingBacklogScan,
  startNotificationMonitor,
};
