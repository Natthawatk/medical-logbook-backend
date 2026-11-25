const ExcelJS = require('exceljs');

const FONT_NAME = 'Tahoma';

const PALETTE = {
  headerBg: 'FF1E40AF',     // Unified crisp deep blue for all headers
  headerBorder: 'FF1E3A8A',
  subHeaderBg: 'FFEFF6FF',  // Soft ice blue for subtitle bar
  subHeaderText: 'FF1E3A8A',
  white: 'FFFFFFFF',
  zebraBg: 'FFF8FAFC',      // Very light neutral tint for readability in guide tables
  borderLight: 'FFCBD5E1',
  textPrimary: 'FF0F172A',
  textSecondary: 'FF334155',
  requiredText: 'FFB91C1C', // Clear red text only for "จำเป็น" label in guide
  goodText: 'FF047857',     // Clean green text for good examples
};

const thinGridBorder = (color = PALETTE.borderLight) => ({
  top: { style: 'thin', color: { argb: color } },
  bottom: { style: 'thin', color: { argb: color } },
  left: { style: 'thin', color: { argb: color } },
  right: { style: 'thin', color: { argb: color } },
});

const buildImportTemplateColumns = () => [
  {
    colLetter: 'A',
    key: 'firstname_lastname',
    header: 'ชื่อ-นามสกุล',
    width: 28,
    numFmt: '@',
    kind: 'ข้อความ (Text)',
    requiredLevel: 'required',
    requiredFor: 'บังคับทุกบทบาท',
    goodExample: 'สมชาย เรียนดี / พญ.สมหญิง ใจดี',
    badExample: 'เว้นว่าง (ระบบจะข้ามแถวนี้)',
    note: 'ระบุคำนำหน้า (ถ้ามี) ชื่อ และนามสกุลให้ครบถ้วนในช่องเดียว',
  },
  {
    colLetter: 'B',
    key: 'email',
    header: 'อีเมล',
    width: 30,
    numFmt: '@',
    kind: 'ข้อความ (Text)',
    requiredLevel: 'required',
    requiredFor: 'บังคับทุกบทบาท (ห้ามซ้ำ)',
    goodExample: 'somchai.s@example.com',
    badExample: 'somchai (ไม่มี @) หรืออีเมลผิดรูปแบบ',
    note: 'ใช้เป็นชื่อบัญชีเข้าสู่ระบบ หากอีเมลมีในระบบแล้วจะอัปเดตข้อมูลให้',
  },
  {
    colLetter: 'C',
    key: 'phone_number',
    header: 'เบอร์โทรศัพท์',
    width: 20,
    numFmt: '@',
    kind: 'ข้อความ (Text @)',
    requiredLevel: 'optional',
    requiredFor: 'ไม่บังคับ',
    goodExample: '0812345678',
    badExample: '812345678 (เลข 0 ด้านหน้าหาย)',
    note: 'ตั้งค่าเป็นข้อความ (@) ไว้แล้วเพื่อรักษาเลข 0 ด้านหน้า',
  },
  {
    colLetter: 'D',
    key: 'role',
    header: 'บทบาท (student/preceptor)',
    width: 32,
    numFmt: '@',
    kind: 'ตัวเลือก Dropdown',
    requiredLevel: 'required',
    requiredFor: 'บังคับทุกบทบาท',
    goodExample: 'student หรือ preceptor',
    badExample: 'course_instructor, admin, นศ. หรือพิมพ์ผิดตัวสะกด',
    note: 'คลิกลูกศรในช่องเพื่อเลือกเฉพาะ student หรือ preceptor (ไม่รองรับนำเข้าอาจารย์หรือแอดมิน)',
  },
  {
    colLetter: 'E',
    key: 'student_id',
    header: 'รหัสนักศึกษา',
    width: 20,
    numFmt: '@',
    kind: 'ข้อความ (Text @)',
    requiredLevel: 'student_only',
    requiredFor: 'บังคับเฉพาะ student',
    goodExample: '6501100001 (พี่เลี้ยงให้เว้นว่าง)',
    badExample: '6.5011E+09 หรือเว้นว่างเมื่อเป็น student',
    note: 'ต้องกรอกเมื่อบทบาท = student (บทบาท preceptor ให้เว้นว่าง)',
  },
  {
    colLetter: 'F',
    key: 'year',
    header: 'ชั้นปี',
    width: 14,
    numFmt: '0',
    kind: 'ตัวเลข (1-6)',
    requiredLevel: 'student_only',
    requiredFor: 'แนะนำสำหรับ student',
    goodExample: '4 (กรอกเฉพาะตัวเลข 1-6)',
    badExample: 'ปี 4, ชั้นปีที่ 4, หรือ 7',
    note: 'กรอกเฉพาะตัวเลข 1 ถึง 6 สำหรับนักศึกษา (พี่เลี้ยงให้เว้นว่าง)',
  },
  {
    colLetter: 'G',
    key: 'semester',
    header: 'เทอม (เช่น 1/2569)',
    width: 22,
    numFmt: '@',
    kind: 'ข้อความ (Text @)',
    requiredLevel: 'optional',
    requiredFor: 'แนะนำ (เช่น 1/2569)',
    goodExample: '1/2569 หรือ 2/2569',
    badExample: 'ม.ค.-69 หรือ 1/1/2569 (กลายเป็นวันที่)',
    note: 'กรอกรูปแบบ ภาคเรียน/ปี พ.ศ. ในช่องข้อความ (@) เพื่อกันแปลงเป็นวันที่',
  },
  {
    colLetter: 'H',
    key: 'password',
    header: 'รหัสผ่าน',
    width: 18,
    numFmt: '@',
    kind: 'ข้อความ (Text @)',
    requiredLevel: 'optional',
    requiredFor: 'ไม่บังคับ (แนะนำเว้นว่างให้ระบบสุ่ม)',
    goodExample: 'Mlg@2569#12 หรือเว้นว่างไว้',
    badExample: 'password123, 12345678 หรือมีช่องว่าง',
    note: 'ต้องยาว >= 8 ตัว มีตัวพิมพ์ใหญ่+พิมพ์เล็ก+ตัวเลข+อักขระพิเศษ (เว้นว่าง = ระบบสุ่มรหัสปลอดภัยเฉพาะบุคคลให้อัตโนมัติ)',
  },
];

const buildSampleRows = () => [
  {
    firstname_lastname: 'สมชาย เรียนดี (ตัวอย่างนักศึกษา - ลบหรือแก้ทับได้)',
    email: 'student.example@example.com',
    phone_number: '0812345678',
    role: 'student',
    student_id: '6501100001',
    year: 4,
    semester: '1/2569',
    password: '',
  },
  {
    firstname_lastname: 'พญ.สมหญิง ใจดี (ตัวอย่างพี่เลี้ยง - ลบหรือแก้ทับได้)',
    email: 'preceptor.example@example.com',
    phone_number: '0898765432',
    role: 'preceptor',
    student_id: '',
    year: null,
    semester: '1/2569',
    password: '',
  },
];

const renderQuickGuideSidebar = (sheet) => {
  // Keep Row 1 in columns I..K empty so parseUploadedUsers only reads headers A1..H1.
  sheet.getColumn(9).width = 3.5;
  sheet.getColumn(10).width = 23;
  sheet.getColumn(11).width = 40;

  sheet.mergeCells('J2:K2');
  const titleCell = sheet.getCell('J2');
  titleCell.value = 'คำแนะนำแบบย่อ';
  titleCell.font = { name: FONT_NAME, bold: true, size: 10.5, color: { argb: PALETTE.white } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.headerBg } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  titleCell.border = thinGridBorder(PALETTE.headerBorder);
  sheet.getRow(2).height = 26;

  const quickItems = [
    ['1. แถวตัวอย่าง (แถว 2-3)', 'แถว 2 = ตัวอย่างนักศึกษา, แถว 3 = ตัวอย่างพี่เลี้ยง (แก้ทับหรือลบก่อนนำเข้า)'],
    ['2. หัวตาราง (แถว 1)', 'ห้ามแก้ไขชื่อหัวตารางในแถวที่ 1 และห้ามเว้นคอลัมน์ว่างคั่น'],
    ['3. ช่องที่จำเป็นต้องกรอก', 'ชื่อ-นามสกุล, อีเมล (ห้ามซ้ำ) และ บทบาท (เลือกจาก Dropdown ช่อง D)'],
    ['4. กรณีบทบาท = student', 'ต้องกรอก รหัสนักศึกษา (E) และแนะนำกรอก ชั้นปี เป็นตัวเลข 1-6 (F)'],
    ['5. บทบาทที่รองรับ', 'student หรือ preceptor เท่านั้น (ไม่รองรับอาจารย์หรือแอดมินผ่าน Excel)'],
    ['6. ช่องที่ไม่บังคับ', 'เบอร์โทรศัพท์, เทอม (เช่น 1/2569) และ รหัสผ่าน (เว้นว่าง = ระบบสุ่มรหัสปลอดภัย 12 หลักแยกแต่ละบัญชี)'],
    ['7. ดูคู่มือและตัวอย่างละเอียด', 'คลิกที่แท็บ "คู่มือการใช้งานอย่างละเอียด" ด้านล่างซ้าย'],
  ];

  quickItems.forEach(([topic, desc], idx) => {
    const rowIdx = 3 + idx;
    const row = sheet.getRow(rowIdx);
    row.height = 24;
    const bg = idx % 2 === 0 ? PALETTE.white : PALETTE.zebraBg;

    const topicCell = row.getCell(10);
    const descCell = row.getCell(11);

    topicCell.value = topic;
    topicCell.font = { name: FONT_NAME, bold: true, size: 9.5, color: { argb: PALETTE.textPrimary } };
    topicCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    topicCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 };
    topicCell.border = thinGridBorder();

    descCell.value = desc;
    descCell.font = { name: FONT_NAME, size: 9.5, color: { argb: PALETTE.textSecondary } };
    descCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    descCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    descCell.border = thinGridBorder();
  });
};

const renderDetailedGuideSheet = (workbook, columns) => {
  const guideSheet = workbook.addWorksheet('คู่มือการใช้งานอย่างละเอียด', {
    views: [{ showGridLines: true }],
  });

  guideSheet.columns = [
    { width: 15 },
    { width: 32 },
    { width: 22 },
    { width: 20 },
    { width: 34 },
    { width: 42 },
  ];

  // Hero Banner
  guideSheet.mergeCells('A1:F1');
  const heroTitle = guideSheet.getCell('A1');
  heroTitle.value = 'คู่มือการเตรียมไฟล์ Excel สำหรับนำเข้าบัญชีผู้ใช้งาน (Medical Logbook)';
  heroTitle.font = { name: FONT_NAME, bold: true, size: 14, color: { argb: PALETTE.white } };
  heroTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.headerBg } };
  heroTitle.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  guideSheet.getRow(1).height = 36;

  guideSheet.mergeCells('A2:F2');
  const heroSub = guideSheet.getCell('A2');
  heroSub.value = 'รองรับการนำเข้าเฉพาะบทบาทนักศึกษา (student) และพี่เลี้ยง (preceptor) เท่านั้น | กรอกข้อมูลในแท็บแรก "ข้อมูลนำเข้าผู้ใช้"';
  heroSub.font = { name: FONT_NAME, bold: true, size: 10, color: { argb: PALETTE.subHeaderText } };
  heroSub.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.subHeaderBg } };
  heroSub.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  guideSheet.getRow(2).height = 24;

  const renderSectionHeader = (rowNum, text) => {
    guideSheet.mergeCells(`A${rowNum}:F${rowNum}`);
    const cell = guideSheet.getCell(`A${rowNum}`);
    cell.value = text;
    cell.font = { name: FONT_NAME, bold: true, size: 11.5, color: { argb: PALETTE.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.headerBg } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    guideSheet.getRow(rowNum).height = 28;
  };

  // Section 1: 4 Easy Steps
  let cursor = 4;
  renderSectionHeader(cursor++, 'ส่วนที่ 1 : ขั้นตอนการเตรียมข้อมูลและอัปโหลดไฟล์ (ทำตามทีละขั้น)');

  const steps = [
    ['ขั้นตอนที่ 1', 'เปิดแท็บ "ข้อมูลนำเข้าผู้ใช้"', 'คลิกที่แท็บแรกด้านล่างซ้าย หากเปิดไฟล์แล้วเจอแถบแจ้งเตือนด้านบนใน Excel ให้กด "Enable Editing" (เปิดใช้งานการแก้ไข) ก่อน'],
    ['ขั้นตอนที่ 2', 'ดูตัวอย่างแล้วกรอกข้อมูลจริงแทนที่', 'แถวที่ 2 (นักศึกษา) และแถวที่ 3 (พี่เลี้ยง) เป็นตัวอย่างวิธีกรอก ให้แก้ทับด้วยข้อมูลจริงหรือลบออกก่อนอัปโหลด แล้วกรอกเรียงลงมา'],
    ['ขั้นตอนที่ 3', 'เลือกบทบาทและตรวจรูปแบบข้อมูล', 'ช่อง "บทบาท" ให้คลิกลูกศร Dropdown เพื่อป้องกันการพิมพ์ผิด หากคัดลอกข้อมูลจากไฟล์อื่นมาวาง แนะนำวางแบบ "Paste Values (วางเฉพาะค่า)"'],
    ['ขั้นตอนที่ 4', 'บันทึกเป็น .XLSX แล้วอัปโหลดเข้าระบบ', 'กดบันทึกไฟล์ (Ctrl+S) แล้วกลับไปที่หน้านำเข้าข้อมูลในระบบ เลือกรายวิชา (ถ้าต้องการเพิ่มเข้าวิชาอัตโนมัติ) จากนั้นอัปโหลดไฟล์ได้เลย'],
  ];

  steps.forEach(([badge, title, detail], idx) => {
    guideSheet.mergeCells(`C${cursor}:F${cursor}`);
    const row = guideSheet.getRow(cursor);
    row.height = 30;
    const bg = idx % 2 === 0 ? PALETTE.white : PALETTE.zebraBg;

    const c1 = row.getCell(1);
    c1.value = badge;
    c1.font = { name: FONT_NAME, bold: true, size: 10, color: { argb: PALETTE.subHeaderText } };
    c1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    c1.alignment = { vertical: 'middle', horizontal: 'center' };
    c1.border = thinGridBorder();

    const c2 = row.getCell(2);
    c2.value = title;
    c2.font = { name: FONT_NAME, bold: true, size: 10, color: { argb: PALETTE.textPrimary } };
    c2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    c2.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    c2.border = thinGridBorder();

    const c3 = row.getCell(3);
    c3.value = detail;
    c3.font = { name: FONT_NAME, size: 10, color: { argb: PALETTE.textSecondary } };
    c3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    c3.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    for (let col = 3; col <= 6; col++) {
      row.getCell(col).border = thinGridBorder();
    }
    cursor++;
  });

  // Section 2: Column Guide
  cursor++;
  renderSectionHeader(cursor++, 'ส่วนที่ 2 : คำอธิบายความหมาย วิธีกรอก และตัวอย่างของแต่ละคอลัมน์');

  const colHeaders = ['คอลัมน์', 'ชื่อหัวตาราง (ห้ามแก้ไข)', 'ความจำเป็น', 'รูปแบบเซลล์', 'ตัวอย่างที่ถูกต้อง', 'ตัวอย่างที่ผิด / ข้อควรระวัง'];
  const colHeaderRow = guideSheet.getRow(cursor);
  colHeaderRow.height = 26;
  colHeaders.forEach((h, i) => {
    const cell = colHeaderRow.getCell(i + 1);
    cell.value = h;
    cell.font = { name: FONT_NAME, bold: true, size: 10, color: { argb: PALETTE.subHeaderText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.subHeaderBg } };
    cell.alignment = { vertical: 'middle', horizontal: i === 0 || i === 2 ? 'center' : 'left', wrapText: true };
    cell.border = thinGridBorder();
  });
  cursor++;

  columns.forEach((col, idx) => {
    const row = guideSheet.getRow(cursor);
    row.height = 34;
    const bg = idx % 2 === 0 ? PALETTE.white : PALETTE.zebraBg;
    const reqColor = col.requiredLevel === 'required' ? PALETTE.requiredText : PALETTE.textPrimary;

    const vals = [
      `คอลัมน์ ${col.colLetter}`,
      col.header,
      col.requiredFor,
      col.kind,
      col.goodExample,
      `${col.badExample}\n(${col.note})`,
    ];

    vals.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      cell.border = thinGridBorder();
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'middle', horizontal: i === 0 || i === 2 ? 'center' : 'left', wrapText: true };
      if (i === 2) {
        cell.font = { name: FONT_NAME, bold: true, size: 9.5, color: { argb: reqColor } };
      } else if (i === 4) {
        cell.font = { name: FONT_NAME, bold: true, size: 9.5, color: { argb: PALETTE.goodText } };
      } else if (i === 5) {
        cell.font = { name: FONT_NAME, size: 9, color: { argb: PALETTE.textSecondary } };
      } else {
        cell.font = { name: FONT_NAME, bold: i <= 1, size: 10, color: { argb: PALETTE.textPrimary } };
      }
    });
    cursor++;
  });

  // Section 3: Role Cheat Sheet
  cursor++;
  renderSectionHeader(cursor++, 'ส่วนที่ 3 : ตารางอ้างอิงบทบาท (Role) และช่องที่ต้องกรอกในแต่ละบทบาท');

  const rolesTable = [
    ['student', 'นักศึกษาฝึกปฏิบัติงาน', 'ต้องกรอก ชื่อ-นามสกุล, อีเมล และ รหัสนักศึกษา (แนะนำใส่ ชั้นปี 1-6 และ เทอม)'],
    ['preceptor', 'อาจารย์พี่เลี้ยง / พยาบาลพี่เลี้ยงประจำหอผู้ป่วย', 'กรอก ชื่อ-นามสกุล และ อีเมล (รหัสนักศึกษา และ ชั้นปี ให้เว้นว่าง)'],
  ];

  rolesTable.forEach(([roleCode, meaning, reqNote], idx) => {
    guideSheet.mergeCells(`B${cursor}:C${cursor}`);
    guideSheet.mergeCells(`D${cursor}:F${cursor}`);
    const row = guideSheet.getRow(cursor);
    row.height = 26;
    const bg = idx % 2 === 0 ? PALETTE.white : PALETTE.zebraBg;

    const r1 = row.getCell(1);
    r1.value = roleCode;
    r1.font = { name: FONT_NAME, bold: true, size: 10, color: { argb: PALETTE.subHeaderText } };
    r1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    r1.alignment = { vertical: 'middle', horizontal: 'center' };
    r1.border = thinGridBorder();

    const r2 = row.getCell(2);
    r2.value = meaning;
    r2.font = { name: FONT_NAME, bold: true, size: 10, color: { argb: PALETTE.textPrimary } };
    r2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    r2.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell(2).border = thinGridBorder();
    row.getCell(3).border = thinGridBorder();

    const r3 = row.getCell(4);
    r3.value = reqNote;
    r3.font = { name: FONT_NAME, size: 10, color: { argb: PALETTE.textSecondary } };
    r3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    r3.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    for (let col = 4; col <= 6; col++) {
      row.getCell(col).border = thinGridBorder();
    }
    cursor++;
  });

  // Section 4: FAQ / Common Mistakes
  cursor++;
  renderSectionHeader(cursor++, 'ส่วนที่ 4 : ปัญหาที่พบบ่อยและวิธีแก้ไข (FAQ)');

  const faqs = [
    ['คัดลอกข้อมูลจากไฟล์อื่นมาวางแล้วเลข 0 หาย / เทอมกลายเป็นวันที่', 'ใช้วิธีวางแบบ "Paste Values" หรือเลือกเซลล์ -> คลิกขวา Format Cells -> เลือก Text (@) ก่อนพิมพ์ หรือใส่เครื่องหมาย \' นำหน้า เช่น \'0812345678 หรือ \'1/2569'],
    ['ไม่ทราบว่าต้องตั้งรหัสผ่านให้ทุกคนหรือไม่', 'แนะนำให้เว้นว่างไว้ ระบบจะสุ่มรหัสผ่านเริ่มต้นที่ปลอดภัย (12 ตัวอักษร) แยกเฉพาะบุคคลให้โดยอัตโนมัติ และให้ดาวน์โหลดไฟล์รหัสผ่านชั่วคราวหลังนำเข้าทันที (ผู้ใช้จะถูกบังคับเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก)'],
    ['นำเข้าไฟล์ซ้ำโดยใช้อีเมลเดิม จะเกิดอะไรขึ้น', 'ระบบจะอัปเดตข้อมูลล่าสุดและลงทะเบียนรายวิชาที่เลือกเพิ่มเติมให้โดยไม่สร้างบัญชีซ้ำ (แต่ไม่อนุญาตให้เปลี่ยนบทบาทข้ามประเภทจากอีเมลเดิม)'],
  ];

  faqs.forEach(([question, answer], idx) => {
    guideSheet.mergeCells(`A${cursor}:B${cursor}`);
    guideSheet.mergeCells(`C${cursor}:F${cursor}`);
    const row = guideSheet.getRow(cursor);
    row.height = 34;
    const bg = idx % 2 === 0 ? PALETTE.white : PALETTE.zebraBg;

    const qCell = row.getCell(1);
    qCell.value = `Q: ${question}`;
    qCell.font = { name: FONT_NAME, bold: true, size: 9.5, color: { argb: PALETTE.textPrimary } };
    qCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    qCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell(1).border = thinGridBorder();
    row.getCell(2).border = thinGridBorder();

    const aCell = row.getCell(3);
    aCell.value = `วิธีแก้: ${answer}`;
    aCell.font = { name: FONT_NAME, size: 9.5, color: { argb: PALETTE.textSecondary } };
    aCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    aCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    for (let col = 3; col <= 6; col++) {
      row.getCell(col).border = thinGridBorder();
    }
    cursor++;
  });
};

const buildUserImportTemplateWorkbook = () => {
  const columns = buildImportTemplateColumns();
  const roleOptions = '"student,preceptor"';
  const sampleRows = buildSampleRows();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Medical Logbook';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('ข้อมูลนำเข้าผู้ใช้', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = columns.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width,
    style: { numFmt: col.numFmt, font: { name: FONT_NAME, size: 10.5 } },
  }));

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  // Unified, high-contrast header styling across all columns
  const headerRow = sheet.getRow(1);
  headerRow.height = 40;
  columns.forEach((col, index) => {
    const cell = headerRow.getCell(index + 1);
    const isNumberCol = col.numFmt === '0';
    cell.numFmt = '@';
    cell.font = { name: FONT_NAME, bold: true, color: { argb: PALETTE.white }, size: 11 };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: PALETTE.headerBg },
    };
    cell.alignment = {
      vertical: 'middle',
      horizontal: isNumberCol ? 'center' : 'left',
      indent: isNumberCol ? 0 : 1,
      wrapText: true,
    };
    cell.border = {
      top: { style: 'thin', color: { argb: PALETTE.headerBorder } },
      bottom: { style: 'medium', color: { argb: PALETTE.headerBorder } },
      left: { style: 'thin', color: { argb: PALETTE.headerBorder } },
      right: { style: 'thin', color: { argb: PALETTE.headerBorder } },
    };
    cell.note = {
      texts: [
        { font: { name: FONT_NAME, bold: true, size: 9.5 }, text: `${col.header}\n` },
        {
          font: { name: FONT_NAME, size: 9 },
          text: `• สถานะ: ${col.requiredFor}\n• รูปแบบ: ${col.kind}\n• คำแนะนำ: ${col.note}\n• ตัวอย่าง: ${col.goodExample}`,
        },
      ],
    };
  });

  // Data cells: sample rows for student & preceptor on rows 2-3, with default Excel cell styling
  const TOTAL_PREFORMATTED_ROWS = 300;
  for (let rowNum = 2; rowNum <= TOTAL_PREFORMATTED_ROWS; rowNum++) {
    const sample = sampleRows[rowNum - 2];
    const row = sheet.getRow(rowNum);
    columns.forEach((col, index) => {
      const cell = row.getCell(index + 1);
      const isNumberCol = col.numFmt === '0';
      cell.numFmt = col.numFmt;
      cell.alignment = { vertical: 'middle', horizontal: isNumberCol ? 'center' : 'left' };

      if (sample) {
        const val = sample[col.key];
        if (isNumberCol) {
          cell.value = typeof val === 'number' ? val : null;
        } else {
          cell.value = val ? String(val) : '';
        }
      }

      if (col.key === 'role') {
        cell.dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [roleOptions],
          showInputMessage: true,
          promptTitle: 'บทบาท (เลือกจาก Dropdown)',
          prompt: col.note,
          showErrorMessage: true,
          errorTitle: 'บทบาทไม่ถูกต้อง',
          error: `กรุณาเลือกบทบาทจากรายการ: ${col.note}`,
        };
      } else if (col.key === 'year') {
        cell.dataValidation = {
          type: 'whole',
          operator: 'between',
          allowBlank: true,
          formulae: [1, 6],
          showInputMessage: true,
          promptTitle: 'ชั้นปี (ตัวเลข 1-6)',
          prompt: col.note,
          showErrorMessage: true,
          errorTitle: 'ข้อมูลต้องเป็นตัวเลขจำนวนเต็ม',
          error: 'กรุณากรอกชั้นปีเป็นตัวเลข 1 ถึง 6 เท่านั้น',
        };
      } else {
        cell.dataValidation = {
          type: 'textLength',
          operator: 'greaterThanOrEqual',
          allowBlank: true,
          formulae: [0],
          showInputMessage: true,
          promptTitle: `${col.header} (${col.requiredFor})`,
          prompt: `${col.note}\nตัวอย่าง: ${col.goodExample}`,
        };
      }
    });
  }

  renderQuickGuideSidebar(sheet);
  renderDetailedGuideSheet(workbook, columns);

  return workbook;
};

module.exports = {
  buildUserImportTemplateWorkbook,
};
