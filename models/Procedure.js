const mongoose = require('mongoose');

const { Schema } = mongoose;

const formFieldSchema = new Schema(
  {
    field_name: {
      type: String,
      required: true,
    },
    field_type: {
      type: String,
      required: true,
    },
    options: {
      type: [String],
      default: undefined,
    },
    is_required: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const normalizeFieldOptions = (options) => {
  const rawList = Array.isArray(options)
    ? options
    : typeof options === 'string'
      ? options.split(/[,،、]/)
      : [];
  const cleaned = [];
  const seen = new Set();
  for (const item of rawList) {
    const trimmed = String(item ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned;
};

const normalizeFormStructure = (formStructure) => {
  if (!Array.isArray(formStructure)) return [];
  return formStructure.map((field) => {
    const plain = field && typeof field.toObject === 'function' ? field.toObject() : { ...field };
    const normalized = {
      field_name: String(plain.field_name ?? '').trim(),
      field_type: plain.field_type || 'text',
      is_required: Boolean(plain.is_required),
    };
    if (normalized.field_type === 'select') {
      normalized.options = normalizeFieldOptions(plain.options);
    }
    return normalized;
  });
};

const validateFormStructure = (formStructure, procedureLabel = '') => {
  const scope = procedureLabel ? `ในหัตถการ "${procedureLabel}" ` : '';
  if (!Array.isArray(formStructure)) {
    return {
      error: `โครงสร้างฟิลด์${scope}ไม่ถูกต้อง`,
      normalized: [],
    };
  }

  const normalized = normalizeFormStructure(formStructure);
  if (normalized.length === 0) {
    return {
      error: `กรุณาเพิ่มฟิลด์ข้อมูล${scope}อย่างน้อย 1 ช่อง`,
      normalized,
    };
  }

  for (const field of normalized) {
    if (!field.field_name) {
      return {
        error: `กรุณาระบุชื่อฟิลด์ข้อมูล${scope}ให้ครบถ้วน`,
        normalized,
      };
    }
    if (field.field_type === 'select' && (!field.options || field.options.length === 0)) {
      return {
        error: `กรุณาระบุตัวเลือกอย่างน้อย 1 ตัวเลือกสำหรับฟิลด์ "${field.field_name}"${scope ? ` ${scope.trim()}` : ''}`,
        normalized,
      };
    }
  }

  return { error: null, normalized };
};

const procedureSchema = new Schema(
  {
    course_id: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    procedure_name: {
      type: String,
      required: true,
      trim: true,
    },
    target_score: {
      type: Number,
      required: true,
    },
    required_cases: {
      type: Number,
      required: true,
    },
    form_structure: {
      type: [formFieldSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

procedureSchema.statics.normalizeFormStructure = normalizeFormStructure;
procedureSchema.statics.validateFormStructure = validateFormStructure;

module.exports = mongoose.model('Procedure', procedureSchema);

