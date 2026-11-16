const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const THAI_SHORT_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

const getBangkokNowDate = (now = new Date()) => new Date(now.getTime() + BANGKOK_OFFSET_MS);

const formatBangkokDayKey = (utcShiftedDate) => {
  const y = utcShiftedDate.getUTCFullYear();
  const m = String(utcShiftedDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utcShiftedDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const formatShortDayMonth = (utcShiftedDate) => {
  const d = utcShiftedDate.getUTCDate();
  const m = utcShiftedDate.getUTCMonth() + 1;
  return `${d}/${m}`;
};

const formatThaiDateLabel = (utcShiftedDate) => {
  const d = utcShiftedDate.getUTCDate();
  const m = THAI_SHORT_MONTHS[utcShiftedDate.getUTCMonth()];
  const y = utcShiftedDate.getUTCFullYear() + 543;
  return `${d} ${m} ${y}`;
};

const getSixMonthStart = (now = new Date()) => {
  const bangkok = getBangkokNowDate(now);
  const startUtcMs = Date.UTC(bangkok.getUTCFullYear(), bangkok.getUTCMonth() - 5, 1) - BANGKOK_OFFSET_MS;
  return new Date(startUtcMs);
};

const buildMonthlySeries = (dayCountMap, bangkokToday) => {
  const monthTotals = new Map();
  for (const [dayKey, count] of dayCountMap.entries()) {
    const monthPrefix = dayKey.slice(0, 7);
    monthTotals.set(monthPrefix, (monthTotals.get(monthPrefix) || 0) + count);
  }

  return Array.from({ length: 6 }).map((_, index) => {
    const monthDate = new Date(Date.UTC(bangkokToday.getUTCFullYear(), bangkokToday.getUTCMonth() - (5 - index), 1));
    const year = monthDate.getUTCFullYear();
    const monthIndex = monthDate.getUTCMonth();
    const prefix = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const shortName = MONTH_NAMES[monthIndex];
    return {
      name: shortName,
      tooltipLabel: `${THAI_SHORT_MONTHS[monthIndex]} ${year + 543}`,
      cases: monthTotals.get(prefix) || 0,
    };
  });
};

const buildWeeklySeries = (dayCountMap, bangkokToday) => {
  const dayOfWeekFromMon = (bangkokToday.getUTCDay() + 6) % 7;
  const currentWeekMonday = new Date(Date.UTC(
    bangkokToday.getUTCFullYear(),
    bangkokToday.getUTCMonth(),
    bangkokToday.getUTCDate() - dayOfWeekFromMon
  ));

  return Array.from({ length: 8 }).map((_, index) => {
    const weeksAgo = 7 - index;
    const weekStart = new Date(currentWeekMonday.getTime() - weeksAgo * 7 * 86400000);
    const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);

    let cases = 0;
    for (let offset = 0; offset < 7; offset++) {
      const day = new Date(weekStart.getTime() + offset * 86400000);
      cases += dayCountMap.get(formatBangkokDayKey(day)) || 0;
    }

    const startLabel = formatShortDayMonth(weekStart);
    const endLabel = formatShortDayMonth(weekEnd);
    return {
      name: startLabel,
      tooltipLabel: `สัปดาห์ ${startLabel} - ${endLabel}`,
      cases,
    };
  });
};

const buildDailySeries = (dayCountMap, bangkokToday) => {
  const todayUtcMidnight = new Date(Date.UTC(
    bangkokToday.getUTCFullYear(),
    bangkokToday.getUTCMonth(),
    bangkokToday.getUTCDate()
  ));

  return Array.from({ length: 14 }).map((_, index) => {
    const daysAgo = 13 - index;
    const dayDate = new Date(todayUtcMidnight.getTime() - daysAgo * 86400000);
    const key = formatBangkokDayKey(dayDate);
    return {
      name: formatShortDayMonth(dayDate),
      tooltipLabel: formatThaiDateLabel(dayDate),
      cases: dayCountMap.get(key) || 0,
    };
  });
};

/**
 * Build monthly (6M), weekly (8W), and daily (14D) series from MongoDB day-grouped stats.
 * Each item is expected to look like `{ _id: { day: 'YYYY-MM-DD', ... }, count: Number }`.
 */
const buildGraphDataByRange = (dailyStats = [], filterPredicate = null, now = new Date()) => {
  const dayCountMap = new Map();
  for (const item of dailyStats) {
    if (filterPredicate && !filterPredicate(item)) continue;
    const dayKey = item?._id?.day;
    if (!dayKey) continue;
    dayCountMap.set(dayKey, (dayCountMap.get(dayKey) || 0) + Number(item.count || 0));
  }

  const bangkokToday = getBangkokNowDate(now);
  return {
    monthly: buildMonthlySeries(dayCountMap, bangkokToday),
    weekly: buildWeeklySeries(dayCountMap, bangkokToday),
    daily: buildDailySeries(dayCountMap, bangkokToday),
  };
};

/**
 * Sum multiple per-course `graphDataByRange` objects into one overall bundle.
 */
const sumGraphDataByRange = (bundles = [], now = new Date()) => {
  const validBundles = bundles.filter(Boolean);
  if (validBundles.length === 0) {
    return buildGraphDataByRange([], null, now);
  }

  const sumSeries = (rangeKey) => {
    const template = validBundles[0][rangeKey] || [];
    return template.map((point, index) => ({
      name: point.name,
      tooltipLabel: point.tooltipLabel,
      cases: validBundles.reduce((sum, bundle) => sum + Number(bundle[rangeKey]?.[index]?.cases || 0), 0),
    }));
  };

  return {
    monthly: sumSeries('monthly'),
    weekly: sumSeries('weekly'),
    daily: sumSeries('daily'),
  };
};

module.exports = {
  getSixMonthStart,
  buildGraphDataByRange,
  sumGraphDataByRange,
};
