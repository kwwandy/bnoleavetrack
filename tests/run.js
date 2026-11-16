/*
 * 核心計算邏輯測試 —— 用 `node tests/run.js` 執行,冇用任何測試框架,
 * 純粹用 Node 內建 assert,方便喺冇裝 npm 套件嘅環境都跑得到。
 */
const assert = require('assert');
const path = require('path');

const D = require(path.join(__dirname, '..', 'js', 'dates.js'));
const Calc = require(path.join(__dirname, '..', 'js', 'calc.js'));
const ThemeCore = require(path.join(__dirname, '..', 'js', 'theme.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${e.message}`);
  }
}

console.log('=== DateUtils 基本運算 ===');

test('addDays 基本', () => {
  assert.strictEqual(D.addDays('2026-01-01', 9), '2026-01-10');
});

test('addYears 閏年 clamp (2024-02-29 +1年 -> 2025-02-28)', () => {
  assert.strictEqual(D.addYears('2024-02-29', 1), '2025-02-28');
});

test('addMonths 月尾 clamp (2026-01-31 +1個月 -> 2026-02-28)', () => {
  assert.strictEqual(D.addMonths('2026-01-31', 1), '2026-02-28');
});

test('diffDays 基本', () => {
  assert.strictEqual(D.diffDays('2026-01-01', '2026-01-10'), 9);
});

console.log('=== 缺勤日數(整日制,離境/返英日不計) ===');

test('1月1日離境、1月10日返英 = 8日缺勤', () => {
  assert.strictEqual(D.tripAbsenceDays('2026-01-01', '2026-01-10'), 8);
});

test('1月1日離境、1月2日返英 = 0日缺勤(第二日就返)', () => {
  assert.strictEqual(D.tripAbsenceDays('2026-01-01', '2026-01-02'), 0);
});

test('即日走即日返 = 0日缺勤', () => {
  assert.strictEqual(D.tripAbsenceDays('2026-01-01', '2026-01-01'), 0);
});

test('GOV.UK 例子:缺勤180日,第181日先返到,唔會超過180日', () => {
  // 假設離境日係 D,第180日已經開始返程,實際第181日先抵達
  const departure = '2026-01-01';
  const arrival = D.addDays(departure, 181); // 返英日 = 離境日 + 181日
  assert.strictEqual(D.tripAbsenceDays(departure, arrival), 180);
});

test('返英日早過離境日應該報錯', () => {
  assert.throws(() => D.tripAbsenceDays('2026-01-10', '2026-01-01'));
});

console.log('=== 簽證生效日 -> 首次抵英日 隱含缺勤 ===');

test('同一日批出同抵英 = 0日隱含缺勤', () => {
  assert.strictEqual(D.implicitEntryGapDays('2021-02-01', '2021-02-01'), 0);
});

test('批出後4日先抵英 = 4日隱含缺勤(批出當日都計)', () => {
  assert.strictEqual(D.implicitEntryGapDays('2021-02-01', '2021-02-05'), 4);
});

console.log('=== 區間重疊/滾動窗口 ===');

test('sumOverlapDays 基本重疊計算', () => {
  const intervals = D.mergeIntervals([
    { start: '2026-01-05', end: '2026-01-10' }, // 6日
    { start: '2026-02-01', end: '2026-02-05' }, // 5日
  ]);
  assert.strictEqual(D.sumOverlapDays(intervals, '2026-01-01', '2026-01-31'), 6);
  assert.strictEqual(D.sumOverlapDays(intervals, '2026-01-01', '2026-02-28'), 11);
});

test('mergeIntervals 會合併相鄰/重疊區間', () => {
  const merged = D.mergeIntervals([
    { start: '2026-01-01', end: '2026-01-05' },
    { start: '2026-01-06', end: '2026-01-10' }, // 緊接住前一個,應該合併
    { start: '2026-01-20', end: '2026-01-25' },
  ]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].start, '2026-01-01');
  assert.strictEqual(merged[0].end, '2026-01-10');
});

test('rollingWindowMax 揾到超標嘅12個月窗口', () => {
  // 單一長行程(2026-01-01 至 2026-07-20,共201日,inclusive計),
  // 應該喺任何包含成程行程嘅12個月窗口都超過180
  const intervals = [{ start: '2026-01-01', end: '2026-07-20' }];
  const expectedDays = D.diffDays('2026-01-01', '2026-07-20') + 1; // 201
  const best = D.rollingWindowMax(intervals, '2025-06-01', '2026-12-31', 1);
  assert.strictEqual(best.days, expectedDays);
  assert.ok(best.days > 180);
});

test('rollingWindowAsOf 只計窗口內嘅缺勤', () => {
  const intervals = [{ start: '2025-01-01', end: '2025-01-31' }]; // 31日,喺一年前
  const result = D.rollingWindowAsOf(intervals, '2026-06-01', 1); // 窗口: 2025-06-02 ~ 2026-06-01
  assert.strictEqual(result.days, 0); // 2025年1月唔喺窗口入面
});

console.log('=== 里程碑計算(Calc) ===');

test('ILR 最早申請日 = 簽證生效日 + 5年 - 28日', () => {
  const settings = Calc.mergeSettings();
  const profile = { visaGrantDate: '2021-02-19' };
  assert.strictEqual(Calc.ilrQualifyingDate(profile, settings), '2026-02-19');
  assert.strictEqual(Calc.ilrEarliestApplyDate(profile, settings), '2026-01-22');
});

test('BC 最早申請日(非配偶英籍人士) = ILR批出日 + 12個月', () => {
  const settings = Calc.mergeSettings();
  const profile = { visaGrantDate: '2021-02-19', ilrGrantDate: '2026-03-01', marriedToBritishCitizen: false };
  assert.strictEqual(Calc.bcEarliestApplyDate(profile, settings), '2027-03-01');
});

test('BC 最早申請日(配偶係英國公民) = ILR批出日即可', () => {
  const settings = Calc.mergeSettings();
  const profile = { visaGrantDate: '2021-02-19', ilrGrantDate: '2026-03-01', marriedToBritishCitizen: true };
  assert.strictEqual(Calc.bcEarliestApplyDate(profile, settings), '2026-03-01');
});

test('ILR 合規報告:超過180日應該 flag 唔合格', () => {
  const settings = Calc.mergeSettings();
  const profile = { visaGrantDate: '2021-02-19', firstArrivalDate: '2021-02-19' };
  const trips = [{ departureDate: '2022-01-01', returnDate: '2022-08-01' }]; // 缺勤 = diff-1 = 211日
  const report = Calc.ilrComplianceReport(profile, trips, settings);
  assert.strictEqual(report.passed, false);
  assert.ok(report.worst.days >= 180);
});

test('ILR 合規報告:正常短行程應該合格', () => {
  const settings = Calc.mergeSettings();
  const profile = { visaGrantDate: '2021-02-19', firstArrivalDate: '2021-02-19' };
  const trips = [
    { departureDate: '2022-01-01', returnDate: '2022-01-15' },
    { departureDate: '2023-06-01', returnDate: '2023-06-20' },
  ];
  const report = Calc.ilrComplianceReport(profile, trips, settings);
  assert.strictEqual(report.passed, true);
});

test('入籍合規報告(非配偶,5年路線):過去5年/12個月分開計算', () => {
  const settings = Calc.mergeSettings();
  const profile = { visaGrantDate: '2021-02-19', firstArrivalDate: '2021-02-19', marriedToBritishCitizen: false };
  const trips = [{ departureDate: '2022-01-01', returnDate: '2022-01-31' }]; // 29日缺勤,喺5年前
  const applicationDate = '2027-03-01';
  const report = Calc.naturalisationComplianceReport(profile, trips, settings, applicationDate);
  assert.strictEqual(report.qualifyingYears, 5);
  assert.strictEqual(report.totalPeriod.limit, 450);
  assert.strictEqual(report.totalPeriod.passed, true);
  assert.strictEqual(report.twelveMonth.passed, true);
  assert.strictEqual(report.twelveMonth.days, 0); // 2022年嗰程唔喺過去12個月入面
});

test('入籍合規報告(配偶為英國公民,3年路線):用270日/3年上限', () => {
  const settings = Calc.mergeSettings();
  const profile = { visaGrantDate: '2021-02-19', firstArrivalDate: '2021-02-19', marriedToBritishCitizen: true };
  const trips = [{ departureDate: '2022-01-01', returnDate: '2022-08-01' }]; // 211日缺勤
  const applicationDate = '2027-03-01'; // 3年前 = 2024-03-02,程行程仲喺2022年,唔喺3年窗口入面
  const report = Calc.naturalisationComplianceReport(profile, trips, settings, applicationDate);
  assert.strictEqual(report.qualifyingYears, 3);
  assert.strictEqual(report.totalPeriod.limit, 270);
  assert.strictEqual(report.totalPeriod.days, 0);
  assert.strictEqual(report.totalPeriod.passed, true);
});

test('入籍官方例子對照:申請日2022-09-01、5年期,合資格期開始日應為2017-09-02', () => {
  const settings = Calc.mergeSettings();
  const profile = { visaGrantDate: '2010-01-01', firstArrivalDate: '2010-01-01', marriedToBritishCitizen: false };
  const report = Calc.naturalisationComplianceReport(profile, [], settings, '2022-09-01');
  assert.strictEqual(report.totalPeriod.start, '2017-09-02');
});

test('FIG window 計算(4年豁免)', () => {
  const settings = Calc.mergeSettings();
  const profile = { uktaxResidentFromTaxYear: '2025' };
  const fig = Calc.figWindow(profile, settings);
  assert.strictEqual(fig.startTaxYear, 2025);
  assert.strictEqual(fig.endTaxYear, 2028);
  assert.strictEqual(fig.startLabel, '2025/26');
  assert.strictEqual(fig.endLabel, '2028/29');
});

test('testExpiry 計算到期日同是否過期(英文試,2年有效期)', () => {
  const settings = Calc.mergeSettings();
  const result = Calc.testExpiry('2024-01-01', settings.englishTestValidityYears);
  assert.strictEqual(result.expiryDate, '2026-01-01');
  assert.strictEqual(result.noExpiry, false);
});

test('testExpiry:validityYears=0 代表冇時限(noExpiry)', () => {
  const settings = Calc.mergeSettings();
  const result = Calc.testExpiry('2024-01-01', settings.lifeInUkTestValidityYears);
  assert.strictEqual(result.noExpiry, true);
  assert.strictEqual(result.expiryDate, null);
  assert.strictEqual(result.expired, false);
});

test('testExpiry:冇填日期就回傳null', () => {
  assert.strictEqual(Calc.testExpiry('', 2), null);
  assert.strictEqual(Calc.testExpiry(null, 2), null);
});

console.log('=== 首個稅務居民稅年輔助估算(suggestFirstTaxResidentYear) ===');

test('首次抵英日早於4月6日(2月),留喺英國到稅年尾>=183日 -> 建議嗰個稅年', () => {
  // 稅年 2020/21: 2020-04-06 ~ 2021-04-05。首次抵英 2021-02-19,
  // 到稅年尾(2021-04-05)有 46 日,唔夠183日 -> 應該建議下一個稅年(2021)
  const profile = { firstArrivalDate: '2021-02-19' };
  assert.strictEqual(Calc.suggestFirstTaxResidentYear(profile), 2021);
});

test('首次抵英日喺稅年頭(4月),留到稅年尾夠183日 -> 建議即個稅年', () => {
  // 首次抵英 2021-04-10(屬2021/22稅年,由2021-04-06開始),
  // 到2022-04-05有 361 日,>=183 -> 建議2021
  const profile = { firstArrivalDate: '2021-04-10' };
  assert.strictEqual(Calc.suggestFirstTaxResidentYear(profile), 2021);
});

test('冇填首次抵英日 -> 回傳null', () => {
  assert.strictEqual(Calc.suggestFirstTaxResidentYear({}), null);
});

console.log('=== 重疊行程偵測(findOverlappingTrips / findAllOverlaps) ===');

test('rangesOverlap:一程完全包喺另一程入面 -> 重疊', () => {
  assert.strictEqual(D.rangesOverlap('2025-08-02', '2025-09-01', '2025-08-20', '2025-08-29'), true);
});

test('rangesOverlap:兩程日期完全冇接觸 -> 唔重疊', () => {
  assert.strictEqual(D.rangesOverlap('2025-08-02', '2025-08-10', '2025-09-01', '2025-09-10'), false);
});

test('rangesOverlap:一程嘅返英日同另一程嘅離境日撞正同一日 -> 當重疊', () => {
  assert.strictEqual(D.rangesOverlap('2025-08-02', '2025-08-10', '2025-08-10', '2025-08-20'), true);
});

test('findOverlappingTrips:揾到重疊嗰程,唔會揾返自己', () => {
  const trips = [
    { id: 't1', departureDate: '2025-08-02', returnDate: '2025-09-01' },
    { id: 't2', departureDate: '2025-08-20', returnDate: '2025-08-29' },
    { id: 't3', departureDate: '2025-12-01', returnDate: '2025-12-10' },
  ];
  const overlaps = Calc.findOverlappingTrips({ id: 't1', departureDate: '2025-08-02', returnDate: '2025-09-01' }, trips);
  assert.strictEqual(overlaps.length, 1);
  assert.strictEqual(overlaps[0].id, 't2');
});

test('findAllOverlaps:成個列表揾晒所有重疊pair', () => {
  const trips = [
    { id: 't1', departureDate: '2025-08-02', returnDate: '2025-09-01' },
    { id: 't2', departureDate: '2025-08-20', returnDate: '2025-08-29' },
    { id: 't3', departureDate: '2025-12-01', returnDate: '2025-12-10' },
  ];
  const pairs = Calc.findAllOverlaps(trips);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].a.id, 't1');
  assert.strictEqual(pairs[0].b.id, 't2');
});

test('重疊行程唔會影響缺勤合規計算(mergeIntervals已經處理咗)', () => {
  const settings = Calc.mergeSettings();
  const profile = { visaGrantDate: '2021-02-19', firstArrivalDate: '2021-02-19' };
  const trips = [
    { departureDate: '2025-08-02', returnDate: '2025-09-01' }, // 29日
    { departureDate: '2025-08-20', returnDate: '2025-08-29' }, // 完全包喺上面果程入面,8日
  ];
  const report = Calc.ilrComplianceReport(profile, trips, settings);
  // 應該係29日(merge咗之後),唔係29+8=37日
  assert.strictEqual(report.worst.days, 29);
});

console.log('=== PDF報告檔案名生成(buildReportFilename) ===');

test('buildReportFilename:有填護照號碼,格式跟足 名-護照號碼-類型-Absence_Report-日期', () => {
  const filename = Calc.buildReportFilename({ name: 'Kwun Wai WONG', passportNo: '1235678' }, 'ILR', '2026-09-20');
  assert.strictEqual(filename, 'Kwun_Wai_WONG-1235678-ILR-Absence_Report-2026-SEP-20.pdf');
});

test('buildReportFilename:BC報告類型正確反映落檔案名', () => {
  const filename = Calc.buildReportFilename({ name: 'Kwun Wai WONG', passportNo: '1235678' }, 'BC', '2026-01-05');
  assert.strictEqual(filename, 'Kwun_Wai_WONG-1235678-BC-Absence_Report-2026-JAN-05.pdf');
});

test('buildReportFilename:冇填護照號碼,直接省略嗰段,唔留多餘嘅連字號', () => {
  const filename = Calc.buildReportFilename({ name: 'Kwun Wai WONG', passportNo: '' }, 'ILR', '2026-09-20');
  assert.strictEqual(filename, 'Kwun_Wai_WONG-ILR-Absence_Report-2026-SEP-20.pdf');
});

test('buildReportFilename:passportNo係null都當冇填處理', () => {
  const filename = Calc.buildReportFilename({ name: 'Kwun Wai WONG', passportNo: null }, 'ILR', '2026-09-20');
  assert.strictEqual(filename, 'Kwun_Wai_WONG-ILR-Absence_Report-2026-SEP-20.pdf');
});

test('buildReportFilename:保留中文檔案名稱(唔會亂碼/被拎走,純檔案系統層面唔似PDF字型咁有限制)', () => {
  const filename = Calc.buildReportFilename({ name: '測試用戶 Test User', passportNo: 'H12345678' }, 'ILR', '2026-09-20');
  assert.strictEqual(filename, '測試用戶_Test_User-H12345678-ILR-Absence_Report-2026-SEP-20.pdf');
});

test('buildReportFilename:護照號碼入面嘅空格會被拎走', () => {
  const filename = Calc.buildReportFilename({ name: 'Kwun Wai WONG', passportNo: 'H123 45678' }, 'ILR', '2026-09-20');
  assert.strictEqual(filename, 'Kwun_Wai_WONG-H12345678-ILR-Absence_Report-2026-SEP-20.pdf');
});

test('buildReportFilename:名/護照號碼入面嘅檔案系統違禁字元會被清走', () => {
  const filename = Calc.buildReportFilename({ name: 'A/B:C', passportNo: 'X*1?2' }, 'ILR', '2026-09-20');
  assert.strictEqual(filename, 'ABC-X12-ILR-Absence_Report-2026-SEP-20.pdf');
});

console.log('=== 外觀色系邏輯(ThemeCore) ===');

test('resolveMode:揀咗light/dark就直接用,唔理OS設定', () => {
  assert.strictEqual(ThemeCore.resolveMode('light', true), 'light');
  assert.strictEqual(ThemeCore.resolveMode('dark', false), 'dark');
});

test('resolveMode:auto就跟返OS嘅prefersDark', () => {
  assert.strictEqual(ThemeCore.resolveMode('auto', true), 'dark');
  assert.strictEqual(ThemeCore.resolveMode('auto', false), 'light');
});

test('isValidTheme:揀返有效色系名', () => {
  assert.strictEqual(ThemeCore.isValidTheme('soft-blue'), true);
  assert.strictEqual(ThemeCore.isValidTheme('sage-green'), true);
  assert.strictEqual(ThemeCore.isValidTheme('warm-sand'), true);
  assert.strictEqual(ThemeCore.isValidTheme('not-a-theme'), false);
  assert.strictEqual(ThemeCore.isValidTheme(undefined), false);
});

test('isValidMode:揀返有效模式名', () => {
  assert.strictEqual(ThemeCore.isValidMode('auto'), true);
  assert.strictEqual(ThemeCore.isValidMode('light'), true);
  assert.strictEqual(ThemeCore.isValidMode('dark'), true);
  assert.strictEqual(ThemeCore.isValidMode('blue'), false);
});

console.log(`\n總結: ${passed} 個通過, ${failed} 個失敗`);
if (failed > 0) {
  process.exit(1);
}
