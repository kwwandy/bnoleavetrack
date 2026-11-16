/*
 * dates.js — 核心日期同缺勤計算邏輯 (純函數,冇DOM依賴,方便用Node直接測試)
 *
 * 所有日期一律用 'YYYY-MM-DD' 字串表示(日曆日期,唔帶時間/時區)。
 * 內部一律用 UTC 做運算,避免夏令時間/時區產生 off-by-one 誤差。
 *
 * 官方缺勤計算規則(GOV.UK "Indefinite leave to remain: calculating continuous
 * period in UK"):
 *   "You must only include whole days in this calculation. Part day absences,
 *    for example, less than 24 hours, are not counted."
 * 即:離境當日 same 返英當日都唔計缺勤日,只計中間嘅完整日子。
 *   缺勤日數 = 返英日期 − 離境日期 − 1
 */
(function (global) {
  'use strict';

  // ---------- 基本日期解析/格式化 ----------

  function assertISO(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      throw new Error('日期格式必須係 YYYY-MM-DD,收到: ' + s);
    }
  }

  function toParts(s) {
    assertISO(s);
    const [y, m, d] = s.split('-').map(Number);
    return { y, m, d };
  }

  function fromParts(y, m, d) {
    // 用 UTC 建構,再讀返正規化後嘅 y/m/d(處理月份/日子溢出,例如 addDays 用)
    const dt = new Date(Date.UTC(y, m - 1, d));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${String(yy).padStart(4, '0')}-${mm}-${dd}`;
  }

  function toEpochDay(s) {
    const { y, m, d } = toParts(s);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }

  function fromEpochDay(n) {
    const ms = n * 86400000;
    const dt = new Date(ms);
    return fromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  function today() {
    const dt = new Date();
    return fromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  function compare(a, b) {
    const ea = toEpochDay(a);
    const eb = toEpochDay(b);
    return ea < eb ? -1 : ea > eb ? 1 : 0;
  }

  function addDays(s, n) {
    return fromEpochDay(toEpochDay(s) + n);
  }

  function addMonths(s, n) {
    const { y, m, d } = toParts(s);
    const totalMonths = (y * 12 + (m - 1)) + n;
    const ny = Math.floor(totalMonths / 12);
    const nm = totalMonths - ny * 12; // 0-11
    // 用 fromParts 會自動 clamp 溢出日子(例如 1月31 + 1個月 -> 2月28/29)
    // 因為 new Date(Date.UTC(ny, nm+1-1, d)) 若 d 超過該月日數會自動進位落月,
    // 我哋想要嘅係「clamp」而唔係「進位」,所以要手動計返嗰個月最後一日。
    const lastDayOfTargetMonth = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    const clampedDay = Math.min(d, lastDayOfTargetMonth);
    return fromParts(ny, nm + 1, clampedDay);
  }

  function addYears(s, n) {
    return addMonths(s, n * 12);
  }

  // b - a,幾多個完整日(可以係負數)
  function diffDays(a, b) {
    return toEpochDay(b) - toEpochDay(a);
  }

  function max(a, b) {
    return compare(a, b) >= 0 ? a : b;
  }

  function min(a, b) {
    return compare(a, b) <= 0 ? a : b;
  }

  function clampISO(s) {
    assertISO(s);
    return s;
  }

  /**
   * 兩個inclusive日期範圍(例如兩程行程嘅離境日~返英日)係咪有重疊(包括touch單一日)。
   * 用嚟做「重疊行程」偵測 —— 呢度特登用原始離境/返英日比較,唔係「缺勤區間」,
   * 因為離境/返英當日都唔可能同時分身去第二程行程。
   */
  function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return compare(aStart, bEnd) <= 0 && compare(bStart, aEnd) <= 0;
  }

  // ---------- 缺勤日數(整日制) ----------

  /**
   * 一般離境-返英行程嘅缺勤日數。
   * 離境當日、返英當日都唔計(因為嗰日只有部分時間唔喺英國)。
   * 缺勤日數 = 返英日期 − 離境日期 − 1
   */
  function tripAbsenceDays(departureDate, returnDate) {
    assertISO(departureDate);
    assertISO(returnDate);
    if (compare(returnDate, departureDate) < 0) {
      throw new Error('返英日期唔可以早過離境日期');
    }
    return Math.max(0, diffDays(departureDate, returnDate) - 1);
  }

  /**
   * 將一程行程轉做「完整缺勤日」嘅日期區間(inclusive),
   * 若冇任何完整缺勤日(例如即日走即日返,或者第二日就返)就回傳 null。
   */
  function tripAbsenceInterval(departureDate, returnDate) {
    const days = tripAbsenceDays(departureDate, returnDate);
    if (days <= 0) return null;
    return { start: addDays(departureDate, 1), end: addDays(returnDate, -1) };
  }

  /**
   * 簽證生效日 -> 首次抵英日 呢段「未入境前」嘅空檔。
   * 呢段唔屬於普通離境-返英行程:簽證生效當日申請人已經喺英國以外,
   * 屬於完整一日缺勤;抵英當日因為已經身處英國一部分時間,唔計缺勤。
   * 所以缺勤日數 = 抵英日期 − 簽證生效日期(唔減1),
   * 對應嘅完整缺勤日區間係 [簽證生效日, 抵英日前一日]。
   */
  function implicitEntryGapInterval(visaGrantDate, firstArrivalDate) {
    assertISO(visaGrantDate);
    assertISO(firstArrivalDate);
    if (compare(firstArrivalDate, visaGrantDate) <= 0) return null; // 當日已抵英或資料有誤,冇空檔
    return { start: visaGrantDate, end: addDays(firstArrivalDate, -1) };
  }

  function implicitEntryGapDays(visaGrantDate, firstArrivalDate) {
    const interval = implicitEntryGapInterval(visaGrantDate, firstArrivalDate);
    if (!interval) return 0;
    return diffDays(interval.start, interval.end) + 1;
  }

  // ---------- 區間合併/重疊計算 ----------

  function mergeIntervals(intervals) {
    const valid = intervals.filter(Boolean).slice().sort((a, b) => compare(a.start, b.start));
    const merged = [];
    for (const iv of valid) {
      if (merged.length === 0) {
        merged.push({ ...iv });
        continue;
      }
      const last = merged[merged.length - 1];
      // 相鄰或重疊(中間冇間隔)就合併
      if (compare(iv.start, addDays(last.end, 1)) <= 0) {
        last.end = max(last.end, iv.end);
      } else {
        merged.push({ ...iv });
      }
    }
    return merged;
  }

  /**
   * 計算 intervals 喺 [rangeStart, rangeEnd] (inclusive) 範圍內嘅總重疊日數。
   */
  function sumOverlapDays(intervals, rangeStart, rangeEnd) {
    if (compare(rangeEnd, rangeStart) < 0) return 0;
    let total = 0;
    for (const iv of intervals) {
      const os = max(iv.start, rangeStart);
      const oe = min(iv.end, rangeEnd);
      if (compare(os, oe) <= 0) {
        total += diffDays(os, oe) + 1;
      }
    }
    return total;
  }

  /**
   * 掃描 [periodStart, periodEnd] 入面,每一日做「12個月窗口」嘅終點,
   * 揾出滾動12個月缺勤嘅最大值,同埋邊個窗口。
   * windowYears 預設 1(即12個月);其他計算(例如5年累積)可以另外用 sumOverlapDays。
   */
  function rollingWindowMax(intervals, periodStart, periodEnd, windowYears) {
    windowYears = windowYears || 1;
    const merged = mergeIntervals(intervals);
    let best = { days: 0, windowStart: periodStart, windowEnd: periodStart };
    if (compare(periodEnd, periodStart) < 0) return best;

    const startEpoch = toEpochDay(periodStart);
    const endEpoch = toEpochDay(periodEnd);
    for (let e = startEpoch; e <= endEpoch; e++) {
      const windowEnd = fromEpochDay(e);
      const windowStart = addDays(addYears(windowEnd, -windowYears), 1);
      const days = sumOverlapDays(merged, windowStart, windowEnd);
      if (days > best.days) {
        best = { days, windowStart, windowEnd };
      }
    }
    return best;
  }

  /**
   * 以某一日做窗口終點,計返滾動 windowYears 年(預設12個月)嘅缺勤日數。
   */
  function rollingWindowAsOf(intervals, asOfDate, windowYears) {
    windowYears = windowYears || 1;
    const merged = mergeIntervals(intervals);
    const windowStart = addDays(addYears(asOfDate, -windowYears), 1);
    return {
      windowStart,
      windowEnd: asOfDate,
      days: sumOverlapDays(merged, windowStart, asOfDate),
    };
  }

  const DateUtils = {
    assertISO,
    today,
    compare,
    addDays,
    addMonths,
    addYears,
    diffDays,
    max,
    min,
    tripAbsenceDays,
    tripAbsenceInterval,
    implicitEntryGapInterval,
    implicitEntryGapDays,
    rangesOverlap,
    mergeIntervals,
    sumOverlapDays,
    rollingWindowMax,
    rollingWindowAsOf,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DateUtils;
  } else {
    global.DateUtils = DateUtils;
  }
})(typeof window !== 'undefined' ? window : globalThis);
