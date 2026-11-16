/*
 * calc.js — 業務層計算:合併 DateUtils 做「里程碑」同「合規報告」計算。
 * 純函數,方便測試;UI 層(app.js)只負責攞資料再叫呢啲function。
 */
(function (global) {
  'use strict';

  const D = (typeof module !== 'undefined' && module.exports)
    ? require('./dates.js')
    : global.DateUtils;

  const DEFAULT_SETTINGS = {
    rollingAbsenceLimitDays: 180,       // ILR: 任何連續12個月缺勤上限
    ilrQualifyingYears: 5,              // ILR: 合資格年期
    ilrEarlyApplyDays: 28,              // ILR: 到期前可遞交日數
    // BC/入籍:非配偶人士(Section 6(1))用「5年」路線,配偶/民事伴侶為英國公民(Section 6(2))用「3年」路線。
    // 官方依據(gov.uk"Naturalisation as a British citizen by discretion"):
    //   6(1): 450 days in that 5-year period
    //   6(2): 270 days in that 3-year period
    // 兩條路線嘅「過去12個月」上限都係90日。
    naturalisationQualifyingYearsUnmarried: 5,
    naturalisationTotalAbsenceDaysUnmarried: 450,
    naturalisationQualifyingYearsMarried: 3,
    naturalisationTotalAbsenceDaysMarried: 270,
    naturalisationLast12MonthDays: 90,  // BC: 過去12個月缺勤上限(兩條路線共用)
    bcWaitAfterIlrMonths: 12,           // BC: ILR批出後要等幾多個月(如配偶係英國公民可設0)
    // 英文試(SELT)同 Life in the UK 而家分開設定,因為官方規則唔同:
    //   - 英文試(SELT)證書根據Home Office guidance,遞交申請當日一般唔可以超過2年。
    //   - Life in the UK 測試合格結果,現行官方caseworker guidance冇註明到期日。
    // 0(或留空)代表「冇時限」,testExpiry() 會回傳 noExpiry:true,唔會計到期日。
    englishTestValidityYears: 2,
    lifeInUkTestValidityYears: 0,
    figExemptionYears: 4,               // FIG regime 豁免年期
    lastVerifiedDate: '2026-09-14',     // 呢組參數最後對照官方指引嘅日期
  };

  function mergeSettings(overrides) {
    return Object.assign({}, DEFAULT_SETTINGS, overrides || {});
  }

  /**
   * 將 profile(簽證生效日/首次抵英日) + 逐程 trips 轉做合併咗嘅缺勤區間列表。
   */
  function buildAbsenceIntervals(profile, trips) {
    const intervals = [];
    if (profile.visaGrantDate && profile.firstArrivalDate) {
      const gap = D.implicitEntryGapInterval(profile.visaGrantDate, profile.firstArrivalDate);
      if (gap) intervals.push(gap);
    }
    for (const t of trips || []) {
      if (!t.departureDate || !t.returnDate) continue;
      const iv = D.tripAbsenceInterval(t.departureDate, t.returnDate);
      if (iv) intervals.push(iv);
    }
    return D.mergeIntervals(intervals);
  }

  function ilrQualifyingDate(profile, settings) {
    return D.addYears(profile.visaGrantDate, settings.ilrQualifyingYears);
  }

  function ilrEarliestApplyDate(profile, settings) {
    return D.addDays(ilrQualifyingDate(profile, settings), -settings.ilrEarlyApplyDays);
  }

  function bcEarliestApplyDate(profile, settings) {
    // 若已經有實際 ILR 批出日就用嗰個做基準,否則用預計嘅合資格日做估算
    const ilrBaseDate = profile.ilrGrantDate || ilrQualifyingDate(profile, settings);
    if (profile.marriedToBritishCitizen) return ilrBaseDate;
    return D.addMonths(ilrBaseDate, settings.bcWaitAfterIlrMonths);
  }

  /**
   * ILR 缺勤合規報告:掃描由簽證生效日到「今日或合資格日(以早者為準)」,
   * 揾出歷史上任何連續12個月嘅最高缺勤,同「以今日為終點」嘅目前狀態。
   */
  function ilrComplianceReport(profile, trips, settings) {
    const intervals = buildAbsenceIntervals(profile, trips);
    const qualifyingDate = ilrQualifyingDate(profile, settings);
    const today = D.today();
    const periodEnd = D.compare(today, qualifyingDate) < 0 ? today : qualifyingDate;
    const periodStart = profile.visaGrantDate;

    if (D.compare(periodEnd, periodStart) < 0) {
      return {
        limit: settings.rollingAbsenceLimitDays,
        worst: { days: 0, windowStart: periodStart, windowEnd: periodStart },
        asOfToday: { days: 0, windowStart: periodStart, windowEnd: periodStart },
        passed: true,
      };
    }

    const worst = D.rollingWindowMax(intervals, periodStart, periodEnd, 1);
    const asOfEnd = D.compare(today, periodEnd) < 0 ? today : periodEnd;
    const asOfToday = D.rollingWindowAsOf(intervals, asOfEnd, 1);

    return {
      limit: settings.rollingAbsenceLimitDays,
      worst,
      asOfToday,
      passed: worst.days <= settings.rollingAbsenceLimitDays,
    };
  }

  // 配偶/民事伴侶為英國公民 -> Section 6(2),3年/270日;否則 Section 6(1),5年/450日
  function naturalisationQualifyingYears(profile, settings) {
    return profile.marriedToBritishCitizen
      ? settings.naturalisationQualifyingYearsMarried
      : settings.naturalisationQualifyingYearsUnmarried;
  }

  function naturalisationTotalLimit(profile, settings) {
    return profile.marriedToBritishCitizen
      ? settings.naturalisationTotalAbsenceDaysMarried
      : settings.naturalisationTotalAbsenceDaysUnmarried;
  }

  /**
   * 入籍(BC)缺勤合規報告,以某個「假設/實際申請日」做終點。
   * 根據 gov.uk 官方指引,計算方法係:
   *   合資格期開始日 = 申請日 − 年期 + 1日(例如申請日2022-09-01、5年期,
   *   開始日就係2017-09-02) —— 已對照官方例子驗證。
   * 分別計「過去N年(3或5年,視乎是否配偶為英國公民)總缺勤」同「過去12個月缺勤」,
   * 兩者都係獨立檢查,缺勤區間覆蓋成個合資格期(包括攞到ILR之前嘅居留期)。
   */
  function naturalisationComplianceReport(profile, trips, settings, applicationDate) {
    const intervals = buildAbsenceIntervals(profile, trips);
    const years = naturalisationQualifyingYears(profile, settings);
    const totalLimit = naturalisationTotalLimit(profile, settings);

    const periodStart = D.addDays(D.addYears(applicationDate, -years), 1);
    const periodDays = D.sumOverlapDays(intervals, periodStart, applicationDate);

    const twelveMonthStart = D.addDays(D.addYears(applicationDate, -1), 1);
    const twelveMonthDays = D.sumOverlapDays(intervals, twelveMonthStart, applicationDate);

    return {
      applicationDate,
      qualifyingYears: years,
      route: profile.marriedToBritishCitizen ? 'section-6-2-spouse' : 'section-6-1-general',
      totalPeriod: {
        start: periodStart,
        end: applicationDate,
        days: periodDays,
        limit: totalLimit,
        passed: periodDays <= totalLimit,
      },
      twelveMonth: {
        start: twelveMonthStart,
        end: applicationDate,
        days: twelveMonthDays,
        limit: settings.naturalisationLast12MonthDays,
        passed: twelveMonthDays <= settings.naturalisationLast12MonthDays,
      },
    };
  }

  /**
   * 揾出同 targetTrip(離境日/返英日)有日期重疊嘅其他行程。
   * excludeId(即targetTrip.id)存在嘅話,唔會同自己比較(編輯緊嗰筆紀錄嘅情況)。
   * 純粹用嚟做UI提醒,唔會影響任何缺勤計算(嗰邊本身已經用 mergeIntervals 處理重疊)。
   */
  function findOverlappingTrips(targetTrip, allTrips) {
    if (!targetTrip || !targetTrip.departureDate || !targetTrip.returnDate) return [];
    return (allTrips || []).filter((t) => {
      if (!t.departureDate || !t.returnDate) return false;
      if (targetTrip.id && t.id === targetTrip.id) return false;
      return D.rangesOverlap(targetTrip.departureDate, targetTrip.returnDate, t.departureDate, t.returnDate);
    });
  }

  /**
   * 掃描成個行程列表,揾出所有兩兩重疊嘅pair,方便喺表格層面做摘要/標記。
   * 回傳 [{a: trip, b: trip}, ...]。
   */
  function findAllOverlaps(trips) {
    const list = (trips || []).filter((t) => t.departureDate && t.returnDate);
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (D.rangesOverlap(list[i].departureDate, list[i].returnDate, list[j].departureDate, list[j].returnDate)) {
          pairs.push({ a: list[i], b: list[j] });
        }
      }
    }
    return pairs;
  }

  function figWindow(profile, settings) {
    if (!profile.uktaxResidentFromTaxYear) return null;
    const startYear = parseInt(profile.uktaxResidentFromTaxYear, 10);
    if (!Number.isFinite(startYear)) return null;
    const years = settings.figExemptionYears || 4;
    const endYear = startYear + years - 1;
    const label = (y) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
    return {
      startTaxYear: startYear,
      endTaxYear: endYear,
      startLabel: label(startYear),
      endLabel: label(endYear),
    };
  }

  /**
   * @param {string} testDateStr 考試日期(YYYY-MM-DD)
   * @param {number} validityYears 假設有效年期;0/null/undefined 代表冇時限(noExpiry)
   */
  function testExpiry(testDateStr, validityYears) {
    if (!testDateStr) return null;
    if (!validityYears || validityYears <= 0) {
      return { testDate: testDateStr, expiryDate: null, expired: false, noExpiry: true };
    }
    const expiryDate = D.addYears(testDateStr, validityYears);
    return {
      testDate: testDateStr,
      expiryDate,
      expired: D.compare(D.today(), expiryDate) > 0,
      noExpiry: false,
    };
  }

  // UK 稅年由4月6日開始,至翌年4月5日。
  function taxYearStartingYear(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const isOnOrAfterApr6 = m > 4 || (m === 4 && d >= 6);
    return isOnOrAfterApr6 ? y : y - 1;
  }

  /**
   * 根據「首次抵英日」,粗略估算「首個成為英國稅務居民嘅稅年」,
   * 用嚟預填「稅務/考試」分頁嘅輸入框(用戶可以隨時自行覆蓋)。
   * 計法:睇下首次抵英當年嘅稅年入面,由抵英日到嗰稅年尾(4月5日)有幾多日,
   * 用 SRT(Statutory Residence Test)「第一個自動居民測試」嘅183日門檻做粗略判斷 ——
   * >=183日就當呢個稅年已經係稅務居民,否則就當落喺下一個稅年先開始。
   * 呢個純粹係假設抵英後一直留喺英國(冇扣返出境日數),亦冇考慮ties test、
   * split year treatment 等其他SRT因素,只係一個輔助估算,唔係實際SRT判定,
   * 使用者仍然需要自行核對實際情況。
   */
  function suggestFirstTaxResidentYear(profile) {
    if (!profile || !profile.firstArrivalDate) return null;
    const arrivalYearStart = taxYearStartingYear(profile.firstArrivalDate);
    const taxYearEnd = `${arrivalYearStart + 1}-04-05`;
    const daysInFirstYear = D.diffDays(profile.firstArrivalDate, taxYearEnd) + 1;
    return daysInFirstYear >= 183 ? arrivalYearStart : arrivalYearStart + 1;
  }

  /**
   * PDF報告嘅檔案名生成邏輯,格式: {名}-{護照號碼}-{ILR或BC}-Absence_Report-{日期}.pdf
   * 護照號碼淨係選填,冇填就直接省略嗰一段,唔會留低多餘嘅「-」。
   * 日期格式做 YYYY-MMM-DD(月份用英文縮寫大寫,例如 2026-SEP-20)。
   * 呢個特登放喺 calc.js(純函數、冇DOM依賴)而唔係 app.js,方便喺 Node 入面
   * 直接unit test —— 因為曾經發現部分瀏覽器(尤其headless測試環境)嘅
   * <a download> fallback,對於含有非拉丁字元(例如中文檔案名稱)嘅
   * download屬性會整個唔生效、變返做通用嘅「download」檔案名。呢個係
   * 瀏覽器/HTML download屬性本身嘅限制,唔係呢個function嘅邏輯錯誤,
   * 所以用純函數喺Node直接驗證返呢個function本身輸出正確,唔靠瀏覽器
   * 嘅download事件嚟驗證檔案名。
   */
  function sanitizeFilenamePart(str) {
    return (str || '').replace(/[\\/:*?"<>|]/g, '').trim();
  }

  function formatFilenameDate(iso) {
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const [y, m, d] = iso.split('-').map(Number);
    return `${y}-${months[m - 1]}-${String(d).padStart(2, '0')}`;
  }

  function buildReportFilename(profile, reportTypeLabel, todayIso) {
    const nameSeg = sanitizeFilenamePart((profile && profile.name) || 'profile').replace(/\s+/g, '_');
    const passportSeg = sanitizeFilenamePart((profile && profile.passportNo) || '').replace(/\s+/g, '');
    const parts = [nameSeg || 'profile'];
    if (passportSeg) parts.push(passportSeg);
    parts.push(reportTypeLabel, 'Absence_Report', formatFilenameDate(todayIso));
    return `${parts.join('-')}.pdf`;
  }

  const Calc = {
    DEFAULT_SETTINGS,
    mergeSettings,
    buildAbsenceIntervals,
    ilrQualifyingDate,
    ilrEarliestApplyDate,
    bcEarliestApplyDate,
    ilrComplianceReport,
    naturalisationQualifyingYears,
    naturalisationTotalLimit,
    naturalisationComplianceReport,
    findOverlappingTrips,
    findAllOverlaps,
    figWindow,
    testExpiry,
    suggestFirstTaxResidentYear,
    buildReportFilename,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Calc;
  } else {
    global.Calc = Calc;
  }
})(typeof window !== 'undefined' ? window : globalThis);
