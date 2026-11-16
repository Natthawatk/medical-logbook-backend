const ExcelJS = require('exceljs');
const { sanitizeSpreadsheetText } = require('../middlewares/securityMiddleware');

const FONT_NAME = 'Tahoma';
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

const PALETTE = {
  bannerBg: 'FF0F172A',
  bannerText: 'FFFFFFFF',
  metaBg: 'FFEFF6FF',
  metaText: 'FF1E3A8A',
  borderLight: 'FFCBD5E1',
  borderHeaderBottom: 'FF0F172A',
  zebraBg: 'FFF8FAFC',
  whiteBg: 'FFFFFFFF',
  summaryHeaderBg: 'FF1E293B',
  attendanceHeaderBg: 'FF0F766E',
  proceduresHeaderBg: 'FF1E40AF',
  footerBg: 'FFF1F5F9',
  footerText: 'FF0F172A',
};

const STATUS_BADGE_STYLES = {
  approved: { bg: 'FFD1FAE5', text: 'FF065F46', label: 'อนุมัติแล้ว' },
  verified: { bg: 'FFD1FAE5', text: 'FF065F46', label: 'ผ่านการยืนยัน' },
  normal: { bg: 'FFD1FAE5', text: 'FF065F46', label: 'ปกติ' },
  pending: { bg: 'FFFEF3C7', text: 'FF92400E', label: 'รอตรวจสอบ' },
  late: { bg: 'FFFFEDD5', text: 'FF9A3412', label: 'มาสาย' },
  rejected: { bg: 'FFFFE4E6', text: 'FF9F1239', label: 'ไม่ผ่าน' },
  absent: { bg: 'FFFFE4E6', text: 'FF9F1239', label: 'ขาด' },
  leave: { bg: 'FFDBEAFE', text: 'FF1E40AF', label: 'ลา' },
};

const CASE_STATUS_LABELS = {
  approved: 'อนุมัติแล้ว',
  pending: 'รอประเมิน',
  rejected: 'ไม่ผ่าน',
};

const SHIFT_TIME_LABELS = {
  normal: 'ตรงเวลา',
  late: 'มาสาย',
  absent: 'ขาด',
  leave: 'ลา',
};

const SHIFT_VERIFY_LABELS = {
  verified: 'ผ่านการยืนยัน',
  pending: 'รอตรวจสอบ',
  rejected: 'ถูกปฏิเสธ',
};

const toBangkokExcelDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + BANGKOK_OFFSET_MS);
};

const formatBangkokTimestampText = (value = new Date()) => {
  const shifted = toBangkokExcelDate(value);
  if (!shifted) return '-';
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = shifted.getUTCFullYear() + 543;
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min} น.`;
};

const measureDisplayWidth = (value) => {
  if (value === null || value === undefined) return 0;
  if (value instanceof Date) return 16;
  const lines = String(value).split(/\r?\n/);
  return lines.reduce((maxLen, line) => {
    let width = 0;
    for (const ch of line) {
      width += /[\u0E00-\u0E7F]/.test(ch) ? 1.15 : 1;
    }
    return Math.max(maxLen, width);
  }, 0);
};

const buildCellBorder = (bottomStyle = 'thin', bottomColor = PALETTE.borderLight) => ({
  top: { style: 'thin', color: { argb: PALETTE.borderLight } },
  bottom: { style: bottomStyle, color: { argb: bottomColor } },
  left: { style: 'thin', color: { argb: PALETTE.borderLight } },
  right: { style: 'thin', color: { argb: PALETTE.borderLight } },
});

const getBadgeStyle = (statusKey, customLabel) => {
  const preset = STATUS_BADGE_STYLES[statusKey];
  if (!preset) return null;
  return {
    bg: preset.bg,
    text: preset.text,
    label: customLabel || preset.label,
  };
};

const populateStyledSheet = ({
  workbook,
  sheetName,
  title,
  subtitle,
  headerBgColor,
  columns,
  rows,
  footerRow,
}) => {
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 4 }],
    pageSetup: {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: {
        left: 0.35,
        right: 0.35,
        top: 0.45,
        bottom: 0.45,
        header: 0.25,
        footer: 0.25,
      },
    },
  });

  const colCount = columns.length;
  const maxWidths = columns.map((col) => Math.max(measureDisplayWidth(col.header) + 4, col.minWidth || 10));

  // Row 1: Title banner
  sheet.mergeCells(1, 1, 1, colCount);
  const titleRow = sheet.getRow(1);
  titleRow.height = 34;
  const titleCell = titleRow.getCell(1);
  titleCell.value = title;
  titleCell.font = { name: FONT_NAME, size: 14, bold: true, color: { argb: PALETTE.bannerText } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.bannerBg } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  // Row 2: Metadata / Filter banner
  sheet.mergeCells(2, 1, 2, colCount);
  const metaRow = sheet.getRow(2);
  metaRow.height = 22;
  const metaCell = metaRow.getCell(1);
  metaCell.value = subtitle;
  metaCell.font = { name: FONT_NAME, size: 10, bold: false, color: { argb: PALETTE.metaText } };
  metaCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.metaBg } };
  metaCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  // Row 3: Spacer
  sheet.getRow(3).height = 8;

  // Row 4: Table column headers
  const headerRow = sheet.getRow(4);
  headerRow.height = 30;
  columns.forEach((col, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = col.header;
    cell.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: PALETTE.bannerText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerBgColor } };
    cell.alignment = { vertical: 'middle', horizontal: col.headerAlign || col.align || 'center', wrapText: true };
    cell.border = buildCellBorder('medium', PALETTE.borderHeaderBottom);
  });

  sheet.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4, column: colCount },
  };

  // Data rows starting at Row 5
  rows.forEach((rowData, rowIndex) => {
    const excelRow = sheet.getRow(5 + rowIndex);
    const isEvenRow = rowIndex % 2 === 1;
    const baseFillColor = isEvenRow ? PALETTE.zebraBg : PALETTE.whiteBg;
    let longestWrapLines = 1;

    columns.forEach((col, colIndex) => {
      const cell = excelRow.getCell(colIndex + 1);
      const rawVal = rowData[col.key];
      const badge = col.getBadge ? col.getBadge(rowData) : null;
      const cellValue = badge ? badge.label : rawVal ?? (col.emptyValue ?? '-');

      cell.value = typeof cellValue === 'string' ? sanitizeSpreadsheetText(cellValue) : cellValue;
      cell.numFmt = col.numFmt || '@';
      cell.font = {
        name: FONT_NAME,
        size: 10,
        bold: Boolean(col.bold || badge),
        color: { argb: badge ? badge.text : 'FF1E293B' },
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: badge ? badge.bg : baseFillColor },
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: col.align || 'left',
        wrapText: Boolean(col.wrapText),
      };
      cell.border = buildCellBorder();

      const displayForWidth = badge
        ? badge.label
        : col.numFmt === '0.0%' && typeof rawVal === 'number'
          ? `${(rawVal * 100).toFixed(1)}%`
          : col.numFmt === '0.00' && typeof rawVal === 'number'
            ? rawVal.toFixed(2)
            : rawVal;

      const measured = measureDisplayWidth(displayForWidth) + 3;
      maxWidths[colIndex] = Math.max(maxWidths[colIndex], measured);

      if (col.wrapText && typeof cell.value === 'string') {
        const colMax = col.maxWidth || 40;
        const estimatedLines = Math.ceil(measureDisplayWidth(cell.value) / Math.max(colMax - 4, 12));
        longestWrapLines = Math.max(longestWrapLines, Math.min(estimatedLines, 5));
      }
    });

    excelRow.height = Math.max(23, longestWrapLines * 16 + 7);
  });

  // Optional Footer summary row
  if (footerRow) {
    const excelFooterRow = sheet.getRow(5 + rows.length);
    excelFooterRow.height = 26;
    columns.forEach((col, colIndex) => {
      const cell = excelFooterRow.getCell(colIndex + 1);
      const val = footerRow[col.key];
      cell.value = val !== undefined ? val : '';
      if (col.numFmt && typeof val === 'number') {
        cell.numFmt = col.numFmt;
      }
      cell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: PALETTE.footerText } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.footerBg } };
      cell.alignment = { vertical: 'middle', horizontal: col.align || 'left' };
      cell.border = buildCellBorder('medium', PALETTE.borderHeaderBottom);
    });
  }

  // Apply clamped auto-fitted column widths
  columns.forEach((col, index) => {
    const minW = col.minWidth || 10;
    const maxW = col.maxWidth || 44;
    sheet.getColumn(index + 1).width = Math.min(Math.max(maxWidths[index], minW), maxW);
  });

  return sheet;
};

const getProcedureColumns = ({ includeStudentCols }) => {
  const baseCols = [
    { header: 'ลำดับ', key: 'index', numFmt: '#,##0', align: 'center', minWidth: 8, maxWidth: 10 },
  ];

  if (includeStudentCols) {
    baseCols.push(
      { header: 'รหัสนักศึกษา', key: 'studentId', numFmt: '@', align: 'center', minWidth: 15, maxWidth: 18 },
      { header: 'ชื่อ - สกุล', key: 'studentName', numFmt: '@', align: 'left', minWidth: 22, maxWidth: 32 },
      { header: 'ชั้นปี', key: 'year', numFmt: '#,##0', align: 'center', minWidth: 8, maxWidth: 10 }
    );
  }

  return [
    ...baseCols,
    { header: 'วันที่บันทึกเคส', key: 'caseDate', numFmt: 'dd/mm/yyyy hh:mm', align: 'center', minWidth: 18, maxWidth: 20 },
    { header: 'รหัสวิชา', key: 'courseCode', numFmt: '@', align: 'center', minWidth: 13, maxWidth: 16 },
    { header: 'รายวิชา', key: 'courseName', numFmt: '@', align: 'left', minWidth: 22, maxWidth: 34, wrapText: true },
    { header: 'หัตถการ', key: 'procedureName', numFmt: '@', align: 'left', minWidth: 22, maxWidth: 34, wrapText: true },
    { header: 'สถานที่ฝึกปฏิบัติ', key: 'locationName', numFmt: '@', align: 'left', minWidth: 20, maxWidth: 30, wrapText: true },
    { header: 'อาจารย์ผู้ประเมิน', key: 'preceptorName', numFmt: '@', align: 'left', minWidth: 18, maxWidth: 28 },
    {
      header: 'สถานะการประเมิน',
      key: 'evaluationStatus',
      numFmt: '@',
      align: 'center',
      minWidth: 16,
      maxWidth: 18,
      getBadge: (row) => getBadgeStyle(row.evaluationStatus, CASE_STATUS_LABELS[row.evaluationStatus] || row.evaluationStatus),
    },
    { header: 'คะแนน (เต็ม 4)', key: 'score', numFmt: '0.00', align: 'center', minWidth: 15, maxWidth: 16, emptyValue: '-' },
    { header: 'วันที่ประเมิน', key: 'evaluatedAt', numFmt: 'dd/mm/yyyy hh:mm', align: 'center', minWidth: 18, maxWidth: 20, emptyValue: '-' },
    { header: 'ข้อเสนอแนะจากอาจารย์', key: 'feedback', numFmt: '@', align: 'left', minWidth: 24, maxWidth: 42, wrapText: true },
  ];
};

const getAttendanceColumns = ({ includeStudentCols }) => {
  const baseCols = [
    { header: 'ลำดับ', key: 'index', numFmt: '#,##0', align: 'center', minWidth: 8, maxWidth: 10 },
  ];

  if (includeStudentCols) {
    baseCols.push(
      { header: 'รหัสนักศึกษา', key: 'studentId', numFmt: '@', align: 'center', minWidth: 15, maxWidth: 18 },
      { header: 'ชื่อ - สกุล', key: 'studentName', numFmt: '@', align: 'left', minWidth: 22, maxWidth: 32 },
      { header: 'ชั้นปี', key: 'year', numFmt: '#,##0', align: 'center', minWidth: 8, maxWidth: 10 }
    );
  }

  return [
    ...baseCols,
    { header: 'วันและเวลาเช็คอิน', key: 'shiftDate', numFmt: 'dd/mm/yyyy hh:mm', align: 'center', minWidth: 18, maxWidth: 20 },
    { header: 'รหัสวิชา', key: 'courseCode', numFmt: '@', align: 'center', minWidth: 13, maxWidth: 16 },
    { header: 'รายวิชา', key: 'courseName', numFmt: '@', align: 'left', minWidth: 22, maxWidth: 34, wrapText: true },
    { header: 'สถานที่ฝึกปฏิบัติ', key: 'locationName', numFmt: '@', align: 'left', minWidth: 20, maxWidth: 30, wrapText: true },
    { header: 'อาจารย์ผู้ตรวจ', key: 'preceptorName', numFmt: '@', align: 'left', minWidth: 18, maxWidth: 28 },
    {
      header: 'สถานะเวลา',
      key: 'shiftStatus',
      numFmt: '@',
      align: 'center',
      minWidth: 14,
      maxWidth: 16,
      getBadge: (row) => getBadgeStyle(row.shiftStatus, SHIFT_TIME_LABELS[row.shiftStatus] || row.shiftStatus),
    },
    {
      header: 'สถานะการตรวจสอบ',
      key: 'verifyStatus',
      numFmt: '@',
      align: 'center',
      minWidth: 17,
      maxWidth: 20,
      getBadge: (row) => getBadgeStyle(row.verifyStatus, SHIFT_VERIFY_LABELS[row.verifyStatus] || row.verifyStatus),
    },
    { header: 'วันที่ยืนยัน', key: 'verifiedAt', numFmt: 'dd/mm/yyyy hh:mm', align: 'center', minWidth: 18, maxWidth: 20, emptyValue: '-' },
  ];
};

const createBaseWorkbook = () => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Medical Logbook System';
  workbook.created = new Date();
  return workbook;
};

const buildYearlyReportWorkbook = ({
  type = 'procedures',
  yearLabel = 'ทุกชั้นปี',
  searchTerm = '',
  students = [],
  records = [],
}) => {
  const workbook = createBaseWorkbook();
  const generatedText = formatBangkokTimestampText(new Date());
  const scopeDesc = `ขอบเขต: ${yearLabel}${searchTerm ? ` | คำค้นหา: "${searchTerm}"` : ''} | นักศึกษา ${students.length} คน | ส่งออกเมื่อ ${generatedText}`;

  const summaryRows = students.map((student, idx) => {
    const targetCases = Number(student.targetCases || 0);
    const approvedCases = Number(student.approvedCases || 0);
    const caseProgressRatio = targetCases > 0 ? Math.min(approvedCases / targetCases, 1) : 0;
    const attendanceRatio = Number(student.attendance_pct || 0) / 100;
    const evaluationPassRatio = Number(student.overallProgress || 0) / 100;
    const avgScoreRatio = Number(student.avg_score_pct || 0) / 100;
    const avgScoreOutOf4 = Number(((avgScoreRatio * 4)).toFixed(2));

    return {
      index: idx + 1,
      studentId: String(student.student_id || '-'),
      studentName: student.firstname_lastname || '-',
      year: student.year ? Number(student.year) : '-',
      semester: student.semester || '-',
      courseNames: student.enrolled_course_names || '-',
      approvedCases,
      targetCases,
      caseProgressRatio,
      attendanceRatio,
      evaluationPassRatio,
      avgScoreOutOf4,
      avgScoreRatio,
    };
  });

  const count = summaryRows.length || 1;
  const totalApproved = summaryRows.reduce((s, r) => s + r.approvedCases, 0);
  const totalTarget = summaryRows.reduce((s, r) => s + r.targetCases, 0);
  const summaryFooter = summaryRows.length > 0
    ? {
        index: '',
        studentId: 'รวม / เฉลี่ย',
        studentName: `${summaryRows.length} คน`,
        year: '',
        semester: '',
        courseNames: '',
        approvedCases: totalApproved,
        targetCases: totalTarget,
        caseProgressRatio: totalTarget > 0 ? Math.min(totalApproved / totalTarget, 1) : 0,
        attendanceRatio: summaryRows.reduce((s, r) => s + r.attendanceRatio, 0) / count,
        evaluationPassRatio: summaryRows.reduce((s, r) => s + r.evaluationPassRatio, 0) / count,
        avgScoreOutOf4: summaryRows.reduce((s, r) => s + r.avgScoreOutOf4, 0) / count,
        avgScoreRatio: summaryRows.reduce((s, r) => s + r.avgScoreRatio, 0) / count,
      }
    : null;

  populateStyledSheet({
    workbook,
    sheetName: 'สรุปภาพรวมนักศึกษา',
    title: `รายงานความคืบหน้านักศึกษา (${yearLabel})`,
    subtitle: scopeDesc,
    headerBgColor: PALETTE.summaryHeaderBg,
    columns: [
      { header: 'ลำดับ', key: 'index', numFmt: '#,##0', align: 'center', minWidth: 8, maxWidth: 10 },
      { header: 'รหัสนักศึกษา', key: 'studentId', numFmt: '@', align: 'center', minWidth: 15, maxWidth: 18, bold: true },
      { header: 'ชื่อ - สกุล', key: 'studentName', numFmt: '@', align: 'left', minWidth: 24, maxWidth: 34 },
      { header: 'ชั้นปี', key: 'year', numFmt: '#,##0', align: 'center', minWidth: 8, maxWidth: 10 },
      { header: 'ภาคการศึกษา', key: 'semester', numFmt: '@', align: 'center', minWidth: 13, maxWidth: 16 },
      { header: 'รายวิชา', key: 'courseNames', numFmt: '@', align: 'left', minWidth: 24, maxWidth: 42, wrapText: true },
      { header: 'เคสผ่านเกณฑ์', key: 'approvedCases', numFmt: '#,##0', align: 'right', minWidth: 13, maxWidth: 16 },
      { header: 'เคสเป้าหมาย', key: 'targetCases', numFmt: '#,##0', align: 'right', minWidth: 13, maxWidth: 16 },
      { header: 'ความคืบหน้าเคส (%)', key: 'caseProgressRatio', numFmt: '0.0%', align: 'center', minWidth: 17, maxWidth: 20 },
      { header: 'อัตราการเข้าเวร (%)', key: 'attendanceRatio', numFmt: '0.0%', align: 'center', minWidth: 17, maxWidth: 20 },
      { header: 'ผ่านการประเมิน (%)', key: 'evaluationPassRatio', numFmt: '0.0%', align: 'center', minWidth: 17, maxWidth: 20 },
      { header: 'คะแนนเฉลี่ย (เต็ม 4)', key: 'avgScoreOutOf4', numFmt: '0.00', align: 'center', minWidth: 17, maxWidth: 20 },
      { header: 'คะแนนเฉลี่ย (%)', key: 'avgScoreRatio', numFmt: '0.0%', align: 'center', minWidth: 16, maxWidth: 18 },
    ],
    rows: summaryRows,
    footerRow: summaryFooter,
  });

  const isAttendance = type === 'attendance';
  populateStyledSheet({
    workbook,
    sheetName: isAttendance ? 'รายละเอียดการเข้าเวร' : 'รายละเอียดหัตถการ',
    title: isAttendance ? `บันทึกการเข้าเวรนักศึกษา (${yearLabel})` : `บันทึกการทำหัตถการนักศึกษา (${yearLabel})`,
    subtitle: `${scopeDesc} | รายการทั้งหมด ${records.length} รายการ`,
    headerBgColor: isAttendance ? PALETTE.attendanceHeaderBg : PALETTE.proceduresHeaderBg,
    columns: isAttendance
      ? getAttendanceColumns({ includeStudentCols: true })
      : getProcedureColumns({ includeStudentCols: true }),
    rows: records.map((item, idx) => ({ ...item, index: idx + 1 })),
  });

  return workbook;
};

const buildStudentReportWorkbook = ({
  type = 'procedures',
  student = {},
  courseProgress = [],
  overallStats = {},
  records = [],
}) => {
  const workbook = createBaseWorkbook();
  const generatedText = formatBangkokTimestampText(new Date());
  const studentCode = student.student_id || '-';
  const studentName = student.firstname_lastname || '-';
  const yearLabel = student.year ? `ชั้นปีที่ ${student.year}` : '-';
  const scopeDesc = `นักศึกษา: ${studentName} (${studentCode}) | ${yearLabel} | คะแนนเฉลี่ยรวม: ${Number(overallStats.averageScore || 0).toFixed(2)}/4 | ส่งออกเมื่อ ${generatedText}`;

  const courseRows = courseProgress.map((course, idx) => {
    const approvedCases = Number(course.approvedCases || 0);
    const targetCases = Number(course.targetCases || 0);
    const progressRatio = targetCases > 0 ? Math.min(approvedCases / targetCases, 1) : 0;
    return {
      index: idx + 1,
      courseCode: course.course_code || '-',
      courseName: course.course_name || '-',
      semester: course.semester || '-',
      totalTypes: Number(course.totalTypes || 0),
      approvedCases,
      pendingCases: Number(course.pendingCases || 0),
      targetCases,
      progressRatio,
      averageScore: Number(course.averageScore || 0),
    };
  });

  const totalApproved = courseRows.reduce((s, r) => s + r.approvedCases, 0);
  const totalPending = courseRows.reduce((s, r) => s + r.pendingCases, 0);
  const totalTarget = courseRows.reduce((s, r) => s + r.targetCases, 0);
  const courseFooter = courseRows.length > 0
    ? {
        index: '',
        courseCode: 'รวมทั้งหมด',
        courseName: `${courseRows.length} รายวิชา`,
        semester: '',
        totalTypes: courseRows.reduce((s, r) => s + r.totalTypes, 0),
        approvedCases: totalApproved,
        pendingCases: totalPending,
        targetCases: totalTarget,
        progressRatio: totalTarget > 0 ? Math.min(totalApproved / totalTarget, 1) : 0,
        averageScore: Number(overallStats.averageScore || 0),
      }
    : null;

  populateStyledSheet({
    workbook,
    sheetName: 'สรุปผลรายวิชา',
    title: `รายงานความคืบหน้ารายบุคคล — ${studentName}`,
    subtitle: scopeDesc,
    headerBgColor: PALETTE.summaryHeaderBg,
    columns: [
      { header: 'ลำดับ', key: 'index', numFmt: '#,##0', align: 'center', minWidth: 8, maxWidth: 10 },
      { header: 'รหัสวิชา', key: 'courseCode', numFmt: '@', align: 'center', minWidth: 13, maxWidth: 16, bold: true },
      { header: 'ชื่อรายวิชา', key: 'courseName', numFmt: '@', align: 'left', minWidth: 26, maxWidth: 38, wrapText: true },
      { header: 'ภาคการศึกษา', key: 'semester', numFmt: '@', align: 'center', minWidth: 13, maxWidth: 16 },
      { header: 'จำนวนหัตถการ (ชนิด)', key: 'totalTypes', numFmt: '#,##0', align: 'center', minWidth: 18, maxWidth: 20 },
      { header: 'เคสผ่านเกณฑ์', key: 'approvedCases', numFmt: '#,##0', align: 'right', minWidth: 14, maxWidth: 16 },
      { header: 'เคสรอประเมิน', key: 'pendingCases', numFmt: '#,##0', align: 'right', minWidth: 14, maxWidth: 16 },
      { header: 'เคสเป้าหมาย', key: 'targetCases', numFmt: '#,##0', align: 'right', minWidth: 14, maxWidth: 16 },
      { header: 'ความคืบหน้า (%)', key: 'progressRatio', numFmt: '0.0%', align: 'center', minWidth: 16, maxWidth: 18 },
      { header: 'คะแนนเฉลี่ย (เต็ม 4)', key: 'averageScore', numFmt: '0.00', align: 'center', minWidth: 17, maxWidth: 20 },
    ],
    rows: courseRows,
    footerRow: courseFooter,
  });

  const isAttendance = type === 'attendance';
  populateStyledSheet({
    workbook,
    sheetName: isAttendance ? 'รายละเอียดการเข้าเวร' : 'รายละเอียดหัตถการ',
    title: isAttendance
      ? `ประวัติการเข้าเวร — ${studentName} (${studentCode})`
      : `ประวัติการทำหัตถการ — ${studentName} (${studentCode})`,
    subtitle: `${scopeDesc} | รายการทั้งหมด ${records.length} รายการ`,
    headerBgColor: isAttendance ? PALETTE.attendanceHeaderBg : PALETTE.proceduresHeaderBg,
    columns: isAttendance
      ? getAttendanceColumns({ includeStudentCols: false })
      : getProcedureColumns({ includeStudentCols: false }),
    rows: records.map((item, idx) => ({ ...item, index: idx + 1 })),
  });

  return workbook;
};

const writeWorkbookToResponse = async (res, workbook, filename) => {
  const safeFilename = String(filename || 'report.xlsx').replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  await workbook.xlsx.write(res);
  return res.end();
};

module.exports = {
  toBangkokExcelDate,
  buildYearlyReportWorkbook,
  buildStudentReportWorkbook,
  writeWorkbookToResponse,
};
