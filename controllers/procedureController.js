const mongoose = require('mongoose');
const Procedure = require('../models/Procedure');
const Course = require('../models/Course');
const { getAccessibleCourseIds, hasCourseAccess, canManageCourse } = require('../services/courseAccessService');
const { notifyAdmins, notifyCourseStudents, getActorLabel } = require('./notificationController');
const { invalidateDashboardCache } = require('../services/dashboardCacheService');
const {
  getCompletedStudentSetForProcedures,
  notifyCourseCompletionForStudents,
  getActiveStudentIdsForCourse,
} = require('../services/courseCompletionService');

exports.createProcedure = async (req, res) => {
  try {
    const {
      course_id,
      procedure_name,
      target_score,
      required_cases,
      form_structure,
    } = req.body || {};

    if (!course_id || !procedure_name || target_score === undefined || required_cases === undefined) {
      return res.status(400).json({
        success: false,
        data: null,
        message:
          'course_id, procedure_name, target_score, and required_cases are required.',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(course_id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid course_id.',
      });
    }

    const courseExists = await Course.exists({ _id: course_id });
    if (!courseExists) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Course not found for the provided course_id.',
      });
    }
    if (!(await canManageCourse(req.user, course_id))) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์จัดการรายวิชานี้' });
    }

    const { error: formError, normalized: normalizedForm } = Procedure.validateFormStructure(
      form_structure,
      String(procedure_name || '').trim()
    );
    if (formError) {
      return res.status(400).json({
        success: false,
        data: null,
        message: formError,
      });
    }

    const created = await Procedure.create({
      course_id,
      procedure_name,
      target_score,
      required_cases,
      form_structure: normalizedForm,
    });

    const [actorLabel, parentCourse] = await Promise.all([
      getActorLabel(req.user.id),
      Course.findById(course_id).select('course_code course_name').lean(),
    ]);
    const courseLabel = parentCourse ? ` ในรายวิชา [${parentCourse.course_code}] ${parentCourse.course_name}` : '';
    await notifyAdmins({
      senderId: req.user.id,
      type: 'admin_course_alert',
      severity: 'success',
      sendPush: false,
      actionUrl: '/admin/procedures',
      message: `${actorLabel} เพิ่มหัตถการ "${created.procedure_name}"${courseLabel}`,
    });
    await notifyCourseStudents({
      courseId: course_id,
      senderId: req.user.id,
      type: 'course_procedure_updated',
      severity: 'info',
      sendPush: false,
      actionUrl: '/logbook-cases',
      message: `รายวิชา${courseLabel} เพิ่มหัตถการใหม่ "${created.procedure_name}" (เป้าหมาย ${created.required_cases} เคส)`,
    });

    invalidateDashboardCache();
    return res.status(201).json({
      success: true,
      data: created,
      message: 'Procedure created successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Create procedure error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while creating the procedure.',
    });
  }
};

exports.getProcedures = async (req, res) => {
  try {
    const accessibleIds = await getAccessibleCourseIds(req.user);
    const filter = accessibleIds === null ? {} : { course_id: { $in: accessibleIds } };
    const procedures = await Procedure.find(filter).populate('course_id').sort({ createdAt: -1 });
    return res.status(200).json({
      success: true,
      data: procedures,
      message: 'Procedures fetched successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get procedures error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while fetching procedures.',
    });
  }
};

exports.getProcedureById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid procedure id.',
      });
    }

    const procedure = await Procedure.findById(id).populate('course_id').lean();
    if (!procedure) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Procedure not found.',
      });
    }
    if (!(await hasCourseAccess(req.user, procedure.course_id._id || procedure.course_id))) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์เข้าถึงหัตถการนี้' });
    }

    // Get max progress by any student
    const LogbookCase = mongoose.model('LogbookCase');
    const maxProgress = await LogbookCase.aggregate([
      { $match: { procedure_id: new mongoose.Types.ObjectId(id), evaluation_status: 'approved' } },
      { $group: { _id: '$student_id', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ]);

    procedure.max_student_progress = maxProgress.length > 0 ? maxProgress[0].count : 0;

    return res.status(200).json({
      success: true,
      data: procedure,
      message: 'Procedure fetched successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get procedure by id error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while fetching the procedure.',
    });
  }
};

exports.getProceduresByCourse = async (req, res) => {
  try {
    const { course_id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(course_id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid course_id.',
      });
    }
    if (!(await hasCourseAccess(req.user, course_id))) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์เข้าถึงรายวิชานี้' });
    }

    const procedures = await Procedure.find({ course_id })
      .populate('course_id')
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: procedures,
      message: 'Procedures by course fetched successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Get procedures by course error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while fetching procedures by course.',
    });
  }
};

exports.updateProcedure = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid procedure id.',
      });
    }

    const procedure = await Procedure.findById(id);
    if (!procedure) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Procedure not found.',
      });
    }
    if (!(await canManageCourse(req.user, procedure.course_id))) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์จัดการหัตถการนี้' });
    }

    const prevRequiredCases = Number(procedure.required_cases || procedure.target_score || 1);
    const prevProcedureName = procedure.procedure_name;

    const {
      course_id,
      procedure_name,
      target_score,
      required_cases,
      form_structure,
    } = req.body || {};

    if (course_id !== undefined && String(course_id) !== String(procedure.course_id)) {
      const LogbookCase = mongoose.model('LogbookCase');
      const hasCases = await LogbookCase.exists({ procedure_id: id });

      if (hasCases) {
        return res.status(400).json({
          success: false,
          message: 'ไม่สามารถเปลี่ยนรายวิชาของหัตถการนี้ได้ เนื่องจากมีนักศึกษาเริ่มบันทึกเคสแล้ว'
        });
      }

      if (!mongoose.Types.ObjectId.isValid(course_id)) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'Invalid course_id.',
        });
      }

      const courseExists = await Course.exists({ _id: course_id });
      if (!courseExists) {
        return res.status(404).json({
          success: false,
          data: null,
          message: 'Course not found for the provided course_id.',
        });
      }
      if (!(await canManageCourse(req.user, course_id))) {
        return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์ย้ายหัตถการไปยังรายวิชานี้' });
      }

      procedure.course_id = course_id;
    }

    if (procedure_name !== undefined) procedure.procedure_name = procedure_name;
    if (target_score !== undefined) {
      if (target_score === null || target_score === '') {
        procedure.target_score = 0;
      } else {
        const parsedTargetScore = Number(target_score);
        if (!Number.isFinite(parsedTargetScore) || parsedTargetScore < 0) {
          return res.status(400).json({
            success: false,
            data: null,
            message: 'คะแนนเป้าหมายต้องเป็นตัวเลขที่ไม่ติดลบ',
          });
        }
        procedure.target_score = parsedTargetScore;
      }
    }
    if (required_cases !== undefined) procedure.required_cases = required_cases;
    if (form_structure !== undefined) {
      const { error: formError, normalized: normalizedStructure } = Procedure.validateFormStructure(
        form_structure,
        String(procedure_name ?? procedure.procedure_name ?? '').trim()
      );
      if (formError) {
        return res.status(400).json({
          success: false,
          data: null,
          message: formError,
        });
      }

      procedure.form_structure = normalizedStructure;

      // Data Migration Logic (Simplified)
      // If new fields are added, they will be missing in old case_data.
      // We don't strictly NEED to update the DB if the frontend handles missing keys as "",
      // but the user requested migration logic.
      
      // Get all cases for this procedure
      const LogbookCase = mongoose.model('LogbookCase');
      const affectedCases = await LogbookCase.find({ procedure_id: id });
      
      if (affectedCases.length > 0) {
        const updatePromises = affectedCases.map(async (doc) => {
          let updated = false;
          const caseData = doc.case_data || {};
          
          normalizedStructure.forEach(field => {
            if (caseData[field.field_name] === undefined) {
              caseData[field.field_name] = ""; // Default empty value
              updated = true;
            }
          });
          
          if (updated) {
            doc.case_data = caseData;
            doc.markModified('case_data');
            return doc.save();
          }
        });
        await Promise.all(updatePromises);
      }
    }

    const nextRequiredCases = Number(procedure.required_cases || procedure.target_score || 1);
    const targetDecreased = nextRequiredCases < prevRequiredCases;
    const targetIncreased = nextRequiredCases > prevRequiredCases;

    let beforeCompletionContext = null;
    if (targetDecreased) {
      const [activeStudentIds, proceduresBefore] = await Promise.all([
        getActiveStudentIdsForCourse(procedure.course_id),
        Procedure.find({ course_id: procedure.course_id }).select('_id procedure_name required_cases target_score').lean(),
      ]);
      const adjustedBefore = proceduresBefore.map((p) =>
        String(p._id) === String(procedure._id) ? { ...p, required_cases: prevRequiredCases } : p
      );
      const completedBefore = await getCompletedStudentSetForProcedures(adjustedBefore, activeStudentIds);
      beforeCompletionContext = { activeStudentIds, completedBefore };
    }

    await procedure.save();
    invalidateDashboardCache();

    const [actorLabel, parentCourse] = await Promise.all([
      getActorLabel(req.user.id),
      Course.findById(procedure.course_id).select('course_code course_name').lean(),
    ]);
    const courseTag = parentCourse ? ` ในรายวิชา [${parentCourse.course_code}]` : '';
    await notifyAdmins({
      senderId: req.user.id,
      type: 'admin_course_alert',
      severity: 'info',
      sendPush: false,
      actionUrl: '/admin/procedures',
      message: `${actorLabel} แก้ไขหัตถการ "${procedure.procedure_name}"${courseTag}`,
    });

    const courseDisplay = parentCourse ? `[${parentCourse.course_code}] ${parentCourse.course_name || ''}`.trim() : 'รายวิชา';
    if (targetIncreased) {
      await notifyCourseStudents({
        courseId: procedure.course_id,
        senderId: req.user.id,
        type: 'course_procedure_updated',
        severity: 'warning',
        sendPush: true,
        actionUrl: '/logbook-cases',
        message: `รายวิชา ${courseDisplay} ปรับเพิ่มจำนวนเคสของหัตถการ "${procedure.procedure_name}" จาก ${prevRequiredCases} เป็น ${nextRequiredCases} เคส`,
      });
    } else if (targetDecreased && beforeCompletionContext && beforeCompletionContext.activeStudentIds.length > 0) {
      const proceduresAfter = await Procedure.find({ course_id: procedure.course_id })
        .select('_id procedure_name required_cases target_score')
        .lean();
      const completedAfter = await getCompletedStudentSetForProcedures(
        proceduresAfter,
        beforeCompletionContext.activeStudentIds
      );
      const newlyCompletedIds = [...completedAfter].filter(
        (sid) => !beforeCompletionContext.completedBefore.has(sid)
      );
      if (newlyCompletedIds.length > 0) {
        await notifyCourseCompletionForStudents({
          studentIds: newlyCompletedIds,
          courseId: procedure.course_id,
          courseDoc: parentCourse,
          senderId: req.user.id,
          procedures: proceduresAfter,
          reasonLabel: `หลังปรับเกณฑ์หัตถการ "${prevProcedureName}"`,
        });
      }
    }

    return res.status(200).json({
      success: true,
      data: procedure,
      message: 'Procedure updated successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Update procedure error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while updating the procedure.',
    });
  }
};

exports.deleteProcedure = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid procedure id.',
      });
    }

    const procedure = await Procedure.findById(id).select('course_id procedure_name');
    if (!procedure) {
      return res.status(404).json({ success: false, data: null, message: 'Procedure not found.' });
    }
    if (!(await canManageCourse(req.user, procedure.course_id))) {
      return res.status(403).json({ success: false, data: null, message: 'คุณไม่มีสิทธิ์จัดการหัตถการนี้' });
    }

    // Dependency Check: Prevent deleting procedure if linked to cases
    const LogbookCase = mongoose.model('LogbookCase');
    const hasCases = await LogbookCase.exists({ procedure_id: id });

    if (hasCases) {
      return res.status(400).json({
        success: false,
        message: 'ไม่สามารถลบหัตถการนี้ได้ เนื่องจากมีนักศึกษาบันทึกเคสโดยใช้หัตถการนี้แล้ว'
      });
    }

    const [activeStudentIdsBeforeDelete, proceduresBeforeDelete] = await Promise.all([
      getActiveStudentIdsForCourse(procedure.course_id),
      Procedure.find({ course_id: procedure.course_id }).select('_id procedure_name required_cases target_score').lean(),
    ]);
    const completedBeforeDelete = await getCompletedStudentSetForProcedures(
      proceduresBeforeDelete,
      activeStudentIdsBeforeDelete
    );

    const deleted = await Procedure.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Procedure not found.',
      });
    }
    invalidateDashboardCache();
    const [actorLabel, parentCourse] = await Promise.all([
      getActorLabel(req.user.id),
      Course.findById(procedure.course_id).select('course_code course_name').lean(),
    ]);
    const courseTag = parentCourse ? ` จากรายวิชา [${parentCourse.course_code}]` : '';
    await notifyAdmins({
      senderId: req.user.id,
      type: 'admin_course_alert',
      severity: 'danger',
      sendPush: true,
      actionUrl: '/admin/procedures',
      message: `${actorLabel} ลบหัตถการ "${deleted.procedure_name}"${courseTag}`,
    });

    if (activeStudentIdsBeforeDelete.length > 0) {
      const remainingProcedures = proceduresBeforeDelete.filter((p) => String(p._id) !== String(id));
      if (remainingProcedures.length > 0) {
        const completedAfterDelete = await getCompletedStudentSetForProcedures(
          remainingProcedures,
          activeStudentIdsBeforeDelete
        );
        const newlyCompletedIds = [...completedAfterDelete].filter(
          (sid) => !completedBeforeDelete.has(sid)
        );
        if (newlyCompletedIds.length > 0) {
          await notifyCourseCompletionForStudents({
            studentIds: newlyCompletedIds,
            courseId: procedure.course_id,
            courseDoc: parentCourse,
            senderId: req.user.id,
            procedures: remainingProcedures,
            reasonLabel: `หลังปรับลดรายการหัตถการ "${deleted.procedure_name}"`,
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: null,
      message: 'Procedure deleted successfully.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Delete procedure error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'An unexpected error occurred while deleting the procedure.',
    });
  }
};
