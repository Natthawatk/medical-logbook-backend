/**
 * Normalize an evaluated case score onto a 0-4 scale.
 * Pass/Fail courses map PASS (> 0 and not rejected) to 4.0 and FAIL/rejected to 0.00.
 */
const normalizeEvaluationScore = (evaluationType, evaluationResult, evaluationStatus) => {
  if (evaluationStatus === 'rejected') {
    return 0;
  }
  const numeric = Number(evaluationResult || 0);
  if (evaluationType === 'Pass/Fail') {
    return numeric > 0 ? 4 : 0;
  }
  return Number.isFinite(numeric) ? numeric : 0;
};

/**
 * MongoDB aggregation expression normalizing `$evaluation_result` onto a 0-4 scale.
 */
const mongoNormalizedScoreExpr = (evalTypeField = '$course.evaluation_type') => ({
  $cond: [
    { $eq: ['$evaluation_status', 'rejected'] },
    0,
    {
      $cond: [
        { $eq: [evalTypeField, 'Pass/Fail'] },
        { $cond: [{ $gt: [{ $ifNull: ['$evaluation_result', 0] }, 0] }, 4, 0] },
        { $ifNull: ['$evaluation_result', 0] },
      ],
    },
  ],
});

/**
 * MongoDB aggregation expression for a known static evaluation type ('Pass/Fail' or '0-4').
 */
const mongoNormalizedScoreForCourseType = (evaluationType) => ({
  $cond: [
    { $eq: ['$evaluation_status', 'rejected'] },
    0,
    evaluationType === 'Pass/Fail'
      ? { $cond: [{ $gt: [{ $ifNull: ['$evaluation_result', 0] }, 0] }, 4, 0] }
      : { $ifNull: ['$evaluation_result', 0] },
  ],
});

module.exports = {
  normalizeEvaluationScore,
  mongoNormalizedScoreExpr,
  mongoNormalizedScoreForCourseType,
};
