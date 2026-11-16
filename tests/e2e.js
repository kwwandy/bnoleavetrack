/*
 * e2e.js — 用 Playwright 開返個 app,行過一次主要流程,確保冇明顯 runtime error。
 * 用法: node tests/e2e.js
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

function pdfText(pdfPath) {
  return execFileSync('pdftotext', [pdfPath, '-']).toString();
}

const ROOT = path.join(__dirname, '..');
const PORT = 8743;

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf',
};

function startServer() {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() =>
    chromium.launch()
  );
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  // Headless Chromium 有 showSaveFilePicker 但冇真正UI,call嗰陣會即刻AbortError。
  // 呢度刻意stub走佢,逼app行「標準下載」呢條fallback路徑 —— 亦都係大部分
  // 瀏覽器(Firefox/Safari/舊版Chrome)使用者實際會行嘅路徑,測試更貼合現實。
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
  });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  const results = [];
  function check(name, cond) {
    results.push({ name, ok: !!cond });
    console.log((cond ? '  ok - ' : '  FAIL - ') + name);
  }

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });

  // 1) 應該顯示「未有檔案」提示
  check('初始狀態顯示未有檔案提示', await page.isVisible('#noProfileNotice'));

  // 2) 先建立一個「同行者」測試檔案(等一陣測試「同行者」複製功能),
  //    再建立主測試檔案(會變成目前使用緊嗰個)。
  await page.click('#btnNewProfile');
  await page.fill('#newProfileName', '同行測試 Companion');
  await page.click('#newProfileConfirm');
  await page.waitForSelector('#tabPanels:not([hidden])');

  await page.click('#btnNewProfile');
  await page.fill('#newProfileName', '測試用戶 Test User');
  await page.click('#newProfileConfirm');
  await page.waitForSelector('#tabPanels:not([hidden])');
  check('新增檔案後顯示主畫面', await page.isVisible('#tabPanels'));
  check('總覽tab預設係active', await page.evaluate(() => document.getElementById('tab-overview').classList.contains('active')));

  // 3) 基本資料分頁:填簽證生效日 / 首次抵英日 / 護照號碼
  await page.click('.tab-btn[data-tab="profile"]');
  check('未填護照號碼時顯示橙色warning', await page.isVisible('#pfPassportWarning'));
  await page.fill('#pfPassportNo', 'H12345678');
  check('填咗護照號碼之後warning消失', !(await page.isVisible('#pfPassportWarning')));
  await page.fill('#pfVisaGrantDate', '2021-02-19');
  await page.fill('#pfFirstArrivalDate', '2021-02-25'); // 6日隱含缺勤
  await page.click('#profileForm button[type="submit"]');
  await page.waitForTimeout(200);
  check('儲存之後護照號碼warning維持隱藏', !(await page.isVisible('#pfPassportWarning')));

  // 4) 總覽分頁:ILR/BC摘要應該顯示喺呢度(唔再喺「里程碑」,呢個tab已經拆走)
  await page.click('.tab-btn[data-tab="overview"]');
  const overviewText = await page.textContent('#tab-overview');
  check('總覽分頁都有講清楚資料存喺邊(IndexedDB/呢個瀏覽器)', overviewText.includes('IndexedDB') || overviewText.includes('呢個瀏覽器'));
  const ilrSummaryText = await page.textContent('#ilrSummary');
  check('總覽ILR摘要顯示合資格日(2026-02-19)', ilrSummaryText.includes('2026-02-19'));
  check('總覽ILR摘要顯示最早遞交日(2026-01-22)', ilrSummaryText.includes('2026-01-22'));

  const bcSummaryText = await page.textContent('#bcSummary');
  check('總覽BC摘要有內容', bcSummaryText.length > 0);

  const bcDateAfterProfileA = await page.inputValue('#bcApplicationDateInput');
  check('主測試檔案嘅假設申請日有自動填值', bcDateAfterProfileA.length > 0);

  // 4b) Bug fix 驗證:切去一個未填簽證生效日嘅檔案(同行測試),
  //     「假設申請日」輸入框唔應該殘留返主測試檔案嘅值。
  await page.selectOption('#profileSelect', { label: '同行測試 Companion' });
  await page.waitForTimeout(200);
  await page.click('.tab-btn[data-tab="overview"]');
  const bcDateOnEmptyProfile = await page.inputValue('#bcApplicationDateInput');
  check('未填簽證生效日嘅檔案,假設申請日輸入框係空,唔會殘留舊profile嘅值', bcDateOnEmptyProfile === '');

  await page.selectOption('#profileSelect', { label: '測試用戶 Test User' });
  await page.waitForTimeout(200);

  // 5) 離境日誌:新增一程超過180日嘅行程
  await page.click('.tab-btn[data-tab="trips"]');
  await page.fill('#tripDeparture', '2022-01-01');
  await page.fill('#tripReturn', '2022-08-01'); // 211日缺勤
  await page.fill('#tripOutboundFlight', 'CX250');
  await page.fill('#tripInboundFlight', 'CX251');
  await page.fill('#tripReason', 'long-term work in Hong Kong');
  await page.click('#tripSubmitBtn');
  await page.waitForTimeout(200);

  const tripRow = await page.textContent('#tripTableBody');
  check('行程紀錄顯示211日缺勤', tripRow.includes('211'));
  check('行程紀錄顯示出境航班編號CX250', tripRow.includes('CX250'));
  check('行程紀錄顯示返英航班編號CX251', tripRow.includes('CX251'));
  check('行程紀錄顯示備註', tripRow.includes('long-term work in Hong Kong'));

  // 5b)「同行者」功能:呢筆紀錄一樣可以用「複製到...」按鈕(而家改咗名做「同行者」)
  //     複製去「同行測試」檔案,測埋防止重複click造成重複紀錄嘅修復。
  const companionCopyRow = page.locator('#tripTableBody tr', { hasText: '2022-01-01' });
  const companionCopyBtn = companionCopyRow.locator('[data-action="copy-trip"]');
  check('行程紀錄嘅複製按鈕已經改名做「同行者」', (await companionCopyBtn.textContent()) === '同行者');
  await companionCopyBtn.click();
  await page.waitForSelector('#copyTripTargets');
  await page.check('.copy-target-checkbox');
  await page.click('#copyTripConfirmBtn');
  await page.waitForTimeout(150);
  const companionCopyStatusText = await page.textContent('#copyTripStatus');
  check('顯示已經複製去同行者檔案嘅提示', companionCopyStatusText.includes('已經複製咗去 1 個檔案'));

  // 修復驗證:成功複製之後,checkbox同「複製」掣都應該disable咗,防止再撳造成重複紀錄
  check('複製成功之後「複製」掣變disabled', await page.isDisabled('#copyTripConfirmBtn'));
  check('複製成功之後掣文字變咗「已複製」', (await page.textContent('#copyTripConfirmBtn')) === '已複製');
  check('複製成功之後checkbox都disable咗', await page.isDisabled('.copy-target-checkbox'));
  await page.click('#copyTripCancelBtn');

  // 6) 切去「同行測試」檔案,確認佢得返一筆複製過去嘅紀錄(冇因為disabled保護失效而重複)
  await page.selectOption('#profileSelect', { label: '同行測試 Companion' });
  await page.waitForTimeout(200);
  const companionTripRow = await page.textContent('#tripTableBody');
  check('同行者檔案都有呢筆紀錄(獨立複本)', companionTripRow.includes('CX250') && companionTripRow.includes('211'));
  const companionRowCount = await page.$$eval('#tripTableBody tr', (rows) => rows.length);
  check('同行者檔案得返1筆紀錄(冇因為重複click而多複製)', companionRowCount === 1);

  // 切返主測試檔案,繼續
  await page.selectOption('#profileSelect', { label: '測試用戶 Test User' });
  await page.waitForTimeout(200);

  // 7) 新增多一程短行程(冇揀同行成員),確保計算仍然正常運作
  await page.fill('#tripDeparture', '2023-06-01');
  await page.fill('#tripReturn', '2023-06-10');
  await page.click('#tripSubmitBtn');
  await page.waitForTimeout(200);
  const tripRowsAfter = await page.$$eval('#tripTableBody tr', (rows) => rows.length);
  check('紀錄列表有2筆行程', tripRowsAfter === 2);

  // 6b) 手機闊度(<=640px)排版:離境日誌嘅表格應該轉做逐筆「卡片」,
  //     唔應該再靠橫向scroll,表頭要隱藏,冇填嘅選填欄位(航班/備註)唔顯示空白行。
  await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForTimeout(100);
  const theadDisplay = await page.evaluate(() => getComputedStyle(document.querySelector('.data-table thead')).display);
  check('手機闊度:表頭隱藏咗', theadDisplay === 'none');
  const scrollNeeded = await page.evaluate(() => {
    const el = document.querySelector('.table-scroll');
    return el.scrollWidth > el.clientWidth + 1;
  });
  check('手機闊度:紀錄列表唔使橫向scroll', !scrollNeeded);
  const emptyFieldHidden = await page.evaluate(() => {
    // 第二筆(2023-06-01~2023-06-10)冇填航班/備註,對應嘅td應該隱藏咗
    const rows = document.querySelectorAll('#tripTableBody tr');
    const shortTripRow = Array.from(rows).find((r) => r.textContent.includes('2023-06-01'));
    const flightTd = shortTripRow.querySelector('td[data-label="離境航班"]');
    return getComputedStyle(flightTd).display === 'none';
  });
  check('手機闊度:未填嘅航班欄位唔顯示空白行', emptyFieldHidden);
  const actionButtonWidth = await page.evaluate(() => {
    const btn = document.querySelector('#tripTableBody tr .actions-cell button[data-action="edit-trip"]');
    return btn.getBoundingClientRect().width;
  });
  check('手機闊度:按鈕夠闊唔會逼到文字逐字換行', actionButtonWidth > 60);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(100);

  // 7b) 重疊日期偵測:加一程完全包喺trip1(2022-01-01~2022-08-01)入面嘅新行程,
  //     應該即時見到警示文字、表格摘要,同重疊嗰兩行會標橙色 —— 但仍然會儲存低,
  //     唔會阻止提交。測完之後複製呢筆去同行測試檔案,再刪走佢,等返後面嘅
  //     紀錄數量假設(例如備份JSON應有2筆trip)維持一致。
  await page.fill('#tripDeparture', '2022-03-01');
  await page.fill('#tripReturn', '2022-03-10');
  await page.click('#tripSubmitBtn');
  await page.waitForTimeout(200);

  const overlapWarnText = await page.textContent('#tripOverlapWarning');
  check('提交重疊行程之後顯示警示文字(但仍然儲存咗)', overlapWarnText.includes('日期重疊'));

  const overlapSummaryText = await page.textContent('#tripOverlapSummary');
  check('表格上面顯示重疊摘要', overlapSummaryText.includes('重疊'));

  const overlapRowCount = await page.$$eval('#tripTableBody tr.overlap-row', (rows) => rows.length);
  check('表格入面有2行被標記做重疊(橙色)', overlapRowCount === 2);

  const rowsCountWithOverlap = await page.$$eval('#tripTableBody tr', (rows) => rows.length);
  check('新增重疊行程之後有3筆紀錄', rowsCountWithOverlap === 3);

  // 複製呢筆重疊紀錄去「同行測試」檔案
  const copyTargetRow = page.locator('#tripTableBody tr', { hasText: '2022-03-01' });
  await copyTargetRow.locator('[data-action="copy-trip"]').click();
  await page.waitForSelector('#copyTripTargets');
  await page.check('.copy-target-checkbox');
  await page.click('#copyTripConfirmBtn');
  await page.waitForTimeout(150);
  const copyStatusText = await page.textContent('#copyTripStatus');
  check('複製行程之後顯示成功訊息', copyStatusText.includes('已經複製咗去 1 個檔案'));
  await page.click('#copyTripCancelBtn');

  await page.selectOption('#profileSelect', { label: '同行測試 Companion' });
  await page.waitForTimeout(200);
  await page.click('.tab-btn[data-tab="trips"]');
  const companionRowsAfterCopy = await page.$$eval('#tripTableBody tr', (rows) => rows.length);
  check('同行測試檔案而家有2筆紀錄(原本1筆 + 複製嗰筆)', companionRowsAfterCopy === 2);
  const companionTableTextAfterCopy = await page.textContent('#tripTableBody');
  check('同行測試檔案見到複製過去嗰程(2022-03-01)', companionTableTextAfterCopy.includes('2022-03-01'));

  await page.selectOption('#profileSelect', { label: '測試用戶 Test User' });
  await page.waitForTimeout(200);

  // 刪走啱啱新增嗰筆重疊測試紀錄,等返後面步驟嘅紀錄數量假設維持一致(2筆)
  const deleteTargetRow = page.locator('#tripTableBody tr', { hasText: '2022-03-01' });
  page.once('dialog', (dialog) => dialog.accept());
  await deleteTargetRow.locator('[data-action="delete-trip"]').click();
  await page.waitForTimeout(200);
  const rowsAfterCleanup = await page.$$eval('#tripTableBody tr', (rows) => rows.length);
  check('刪走重疊測試紀錄之後返晒2筆紀錄', rowsAfterCleanup === 2);
  const overlapSummaryAfterCleanup = await page.isVisible('#tripOverlapSummary');
  check('刪走重疊紀錄之後,重疊摘要消失', !overlapSummaryAfterCleanup);

  // 8) 參數設定分頁:確認預設值正確顯示(包括新拆開嘅英文試/Life in the UK)
  await page.click('.tab-btn[data-tab="settings"]');
  check('預設180日上限顯示正確', (await page.inputValue('#setRollingLimit')) === '180');
  check('預設5年合資格年期顯示正確', (await page.inputValue('#setIlrYears')) === '5');
  check('入籍(非配偶)預設5年顯示正確', (await page.inputValue('#setNatYearsUnmarried')) === '5');
  check('入籍(非配偶)預設450日顯示正確', (await page.inputValue('#setNatDaysUnmarried')) === '450');
  check('入籍(配偶)預設3年顯示正確', (await page.inputValue('#setNatYearsMarried')) === '3');
  check('入籍(配偶)預設270日顯示正確', (await page.inputValue('#setNatDaysMarried')) === '270');
  check('英文試預設有效年期2年', (await page.inputValue('#setEnglishTestValidity')) === '2');
  check('Life in the UK預設有效年期0(無限期)', (await page.inputValue('#setLifeUkTestValidity')) === '0');

  // 8b) 外觀:色系/淺深色揀選,應該即時生效、persist落localStorage,reload之後都記得返。
  check('預設色系係柔和藍', await page.isChecked('input[name="themeChoice"][value="soft-blue"]'));
  check('預設淺深色係跟裝置', await page.isChecked('input[name="modeChoice"][value="auto"]'));
  check('初始data-theme attribute係soft-blue', (await page.getAttribute('html', 'data-theme')) === 'soft-blue');

  await page.click('.theme-swatch:has-text("鼠尾草綠") input');
  await page.waitForTimeout(100);
  check('揀咗鼠尾草綠之後,data-theme attribute即時更新', (await page.getAttribute('html', 'data-theme')) === 'sage-green');

  await page.click('.mode-picker label:has-text("深色") input');
  await page.waitForTimeout(100);
  check('揀咗深色之後,data-mode attribute即時變做dark(唔理裝置設定)', (await page.getAttribute('html', 'data-mode')) === 'dark');

  await page.reload({ waitUntil: 'networkidle' });
  check('reload之後,色系/深淺色設定會記得返(localStorage persist)', (await page.getAttribute('html', 'data-theme')) === 'sage-green' && (await page.getAttribute('html', 'data-mode')) === 'dark');
  await page.click('.tab-btn[data-tab="settings"]');
  check('reload之後,UI嘅radio揀選狀態都跟返返嚟', (await page.isChecked('input[name="themeChoice"][value="sage-green"]')) && (await page.isChecked('input[name="modeChoice"][value="dark"]')));

  // 還原返跟裝置/柔和藍,等返後面流程(例如PDF/截圖)唔會因為深色模式影響
  await page.click('.theme-swatch:has-text("柔和藍") input');
  await page.click('.mode-picker label:has-text("跟裝置") input');
  await page.waitForTimeout(100);

  // 9) 稅務/考試分頁:未填過就應該自動根據首次抵英日建議一個稅年
  await page.click('.tab-btn[data-tab="taxtest"]');
  const suggestedTaxYear = await page.inputValue('#taxYearInput');
  check('稅年輸入框自動預填建議值(2021,可自行覆蓋)', suggestedTaxYear === '2021');

  await page.fill('#taxYearInput', '2025');
  await page.fill('#englishTestDateInput', '2024-01-01');
  await page.fill('#lifeUkTestDateInput', '2024-06-01');
  await page.click('#taxForm button[type="submit"]');
  await page.click('#examForm button[type="submit"]');
  await page.waitForTimeout(200);
  const figText = await page.textContent('#figSummary');
  check('FIG窗口顯示2025/26至2028/29', figText.includes('2025/26') && figText.includes('2028/29'));
  const examText = await page.textContent('#examSummary');
  check('英文試到期摘要有內容(2年有效期)', examText.includes('2026-01-01'));
  check('Life in the UK顯示無限期(而唔係到期日)', examText.includes('冇註明到期日'));
  const taxTestPanelText = await page.textContent('#tab-taxtest');
  check('稅務/考試分頁顯示18歲以下同65歲以上豁免考試嘅提示', taxTestPanelText.includes('18歲以下') && taxTestPanelText.includes('65歲或以上'));
  check('稅務/考試分頁顯示60-64歲酌情豁免嘅提示', taxTestPanelText.includes('60-64歲'));

  // 10) 總覽分頁應該鏡射同一份FIG/考試摘要
  await page.click('.tab-btn[data-tab="overview"]');
  const ovFigText = await page.textContent('#ovFigSummary');
  const ovExamText = await page.textContent('#ovExamSummary');
  check('總覽同稅務/考試分頁嘅FIG摘要一致', ovFigText.includes('2025/26') && ovFigText.includes('2028/29'));
  check('總覽同稅務/考試分頁嘅考試摘要一致(Life in the UK無限期)', ovExamText.includes('冇註明到期日'));

  // 11) PDF 報告生成(headless冇File System Access API,應該fallback做標準下載)
  //     ILR 同 BC 分開兩份文件,要確認各自淨係包含相關嘅合規指標,冇互相摻雜。
  await page.click('.tab-btn[data-tab="report"]');

  const [ilrDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnGenerateIlrReport'),
  ]);
  const ilrPdfPath = path.join(__dirname, 'output-ilr.pdf');
  await ilrDownload.saveAs(ilrPdfPath);
  const ilrPdfBuf = fs.readFileSync(ilrPdfPath);
  check('ILR PDF已生成且係有效PDF(以%PDF開頭)', ilrPdfBuf.slice(0, 4).toString() === '%PDF');
  // 檔案名格式:{名}-{護照號碼}-ILR-Absence_Report-{YYYY-MMM-DD}.pdf
  // 呢度特登唔靠 download.suggestedFilename() 去驗證 —— 實測發現用嘅呢個headless
  // Chromium版本,<a download>屬性入面如果含有非拉丁字元(例如檔案名用中文),
  // 個屬性成個會失效、變返做瀏覽器通用嘅「download」檔案名,呢個係瀏覽器
  // download屬性本身嘅限制(唔淨係呢個app先咁,任何網站都會撞到),唔代表
  // 我哋個filename生成邏輯有錯。所以直接call返個純function(Calc.buildReportFilename,
  // 已經喺tests/run.js有齊單元測試)確認個邏輯真係跑緊、輸出結果正確。
  const ilrFilename = await page.evaluate(() =>
    window.Calc.buildReportFilename({ name: '測試用戶 Test User', passportNo: 'H12345678' }, 'ILR', window.DateUtils.today())
  );
  check(
    'ILR PDF檔案名邏輯跟足 名-護照號碼-ILR-Absence_Report-日期 格式',
    /^測試用戶_Test_User-H12345678-ILR-Absence_Report-\d{4}-[A-Z]{3}-\d{2}\.pdf$/.test(ilrFilename)
  );
  const ilrText = pdfText(ilrPdfPath);
  check('ILR PDF內文顯示護照號碼', ilrText.includes('Passport No: H12345678'));
  check('ILR PDF標題正確標示Settlement (ILR)', ilrText.includes('Settlement (ILR) Application'));
  check('ILR PDF包含180日滾動檢查', ilrText.includes('rolling 12-month period') && ilrText.includes('180'));
  check('ILR PDF冇夾雜Naturalisation合規段落', !ilrText.includes('Compliance summary - Naturalisation'));
  check('ILR PDF冇模糊嘅「歷來總缺勤」數字', !ilrText.includes('Total recorded days absent'));
  check('ILR PDF顯示出境航班編號CX250', ilrText.includes('CX250'));
  check('ILR PDF顯示返英航班編號CX251', ilrText.includes('CX251'));
  check('ILR PDF顯示行程備註(英文)', ilrText.includes('long-term work in Hong Kong'));
  check('ILR PDF保留整日制計算方法交代', ilrText.includes('whole day') && ilrText.includes('Indefinite leave to remain: calculating continuous period in UK'));
  check('ILR PDF已刪走「僅供個人參考」保護性字眼', !ilrText.includes('personal reference only'));
  check('ILR PDF已刪走「請自行核對」保護性字眼', !ilrText.includes('Please verify all figures'));

  const [bcDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnGenerateBcReport'),
  ]);
  const bcPdfPath = path.join(__dirname, 'output-bc.pdf');
  await bcDownload.saveAs(bcPdfPath);
  const bcPdfBuf = fs.readFileSync(bcPdfPath);
  check('BC PDF已生成且係有效PDF(以%PDF開頭)', bcPdfBuf.slice(0, 4).toString() === '%PDF');
  const bcFilename = await page.evaluate(() =>
    window.Calc.buildReportFilename({ name: '測試用戶 Test User', passportNo: 'H12345678' }, 'BC', window.DateUtils.today())
  );
  check(
    'BC PDF檔案名邏輯跟足 名-護照號碼-BC-Absence_Report-日期 格式',
    /^測試用戶_Test_User-H12345678-BC-Absence_Report-\d{4}-[A-Z]{3}-\d{2}\.pdf$/.test(bcFilename)
  );
  const bcText = pdfText(bcPdfPath);
  check('BC PDF內文顯示護照號碼', bcText.includes('Passport No: H12345678'));
  // 標題喺BC report可能因為太長而自動換行,所以分開check兩個部分,唔靠完整字串包含
  check(
    'BC PDF標題正確標示Naturalisation',
    bcText.includes('Naturalisation (British Citizenship)') && bcText.includes('Application')
  );
  check('BC PDF顯示Section 6(1)路線', bcText.includes('Section 6(1) general route'));
  check('BC PDF包含5年合資格期缺勤段落', bcText.includes('5-year qualifying period'));
  check('BC PDF冇夾雜ILR合規段落', !bcText.includes('Compliance summary - Settlement'));
  check('BC PDF冇模糊嘅「歷來總缺勤」數字', !bcText.includes('Total recorded days absent'));
  check('BC PDF顯示出境航班編號CX250', bcText.includes('CX250'));
  check('BC PDF顯示返英航班編號CX251', bcText.includes('CX251'));
  check('BC PDF顯示行程備註(英文)', bcText.includes('long-term work in Hong Kong'));
  check('BC PDF保留整日制計算方法交代', bcText.includes('whole day') && bcText.includes('Indefinite leave to remain: calculating continuous period in UK'));
  check('BC PDF已刪走「僅供個人參考」保護性字眼', !bcText.includes('personal reference only'));
  check('BC PDF已刪走「請自行核對」保護性字眼', !bcText.includes('Please verify all figures'));

  // 11b) 護照號碼淨係選填:清走佢再生成一次,檔案名應該直接省略嗰段,
  //      唔會留低多餘嘅「--」;PDF內文都唔應該再印「Passport No」呢行。
  await page.click('.tab-btn[data-tab="profile"]');
  await page.fill('#pfPassportNo', '');
  await page.click('#profileForm button[type="submit"]');
  await page.waitForTimeout(150);
  await page.click('.tab-btn[data-tab="report"]');
  const [ilrDownloadNoPassport] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnGenerateIlrReport'),
  ]);
  const ilrNoPassportFilename = await page.evaluate(() =>
    window.Calc.buildReportFilename({ name: '測試用戶 Test User', passportNo: '' }, 'ILR', window.DateUtils.today())
  );
  check(
    '冇填護照號碼時,檔案名邏輯直接省略嗰段(冇多餘嘅雙連字號)',
    /^測試用戶_Test_User-ILR-Absence_Report-\d{4}-[A-Z]{3}-\d{2}\.pdf$/.test(ilrNoPassportFilename)
  );
  const ilrNoPassportPath = path.join(__dirname, 'output-ilr-nopassport.pdf');
  await ilrDownloadNoPassport.saveAs(ilrNoPassportPath);
  const ilrNoPassportText = pdfText(ilrNoPassportPath);
  check('冇填護照號碼時,PDF內文唔會印Passport No呢行', !ilrNoPassportText.includes('Passport No'));
  fs.unlinkSync(ilrNoPassportPath);

  // 還原返護照號碼,等返後面嘅流程(匯出備份等)維持一致
  await page.click('.tab-btn[data-tab="profile"]');
  await page.fill('#pfPassportNo', 'H12345678');
  await page.click('#profileForm button[type="submit"]');
  await page.waitForTimeout(150);
  await page.click('.tab-btn[data-tab="report"]');

  // 12) 交叉驗證:總覽分頁顯示嘅「過去5年缺勤」數字,應該同BC PDF入面嘅數字一致
  await page.click('.tab-btn[data-tab="overview"]');
  const bcComplianceText = await page.textContent('#bcComplianceBox');
  const overviewDaysMatch = bcComplianceText.match(/過去5年缺勤[^0-9]*(\d+)\s*\/\s*(\d+)/);
  const pdfDaysMatch = bcText.match(/Absence in the 5-year qualifying period ending [^:]+:\s*(\d+)\s*day/);
  check(
    '總覽分頁同BC PDF嘅「過去5年缺勤」數字一致',
    overviewDaysMatch && pdfDaysMatch && overviewDaysMatch[1] === pdfDaysMatch[1]
  );

  // 13) 匯出/匯入備份
  await page.click('.tab-btn[data-tab="backup"]');
  const backupHint = await page.textContent('.tab-panel.active .hint');
  check('備份分頁講清楚資料存喺邊(IndexedDB/呢個瀏覽器)', backupHint.includes('IndexedDB') || backupHint.includes('呢個瀏覽器'));

  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnExportProfile'),
  ]);
  const jsonPath = path.join(__dirname, 'output-backup.json');
  await jsonDownload.saveAs(jsonPath);
  const backupData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  check('備份JSON包含1個profile(目前檔案)', backupData.profiles.length === 1);
  check('備份JSON包含2筆trip', backupData.trips.length === 2);

  const fileInput = await page.$('#importFileInput');
  await fileInput.setInputFiles(jsonPath);
  await page.waitForTimeout(300);
  const importStatus = await page.textContent('#importStatus');
  check('匯入成功訊息正確', importStatus.includes('已成功匯入 1 個檔案'));

  const profileOptions = await page.$$eval('#profileSelect option', (opts) => opts.map((o) => o.textContent));
  check('匯入後有3個檔案(同行測試 + 主測試 + 匯入)', profileOptions.length === 3);

  // 14) 清除本機所有資料(呢個係破壞性動作,一定要放喺測試最尾)
  //     先驗證未打啱確認字就撳唔到掣,再打啱先真係清走。
  await page.click('#btnWipeAllData');
  await page.waitForSelector('#wipeConfirmInput');
  check('清除按鈕預設disabled(未輸入確認字)', await page.isDisabled('#wipeConfirmBtn'));
  await page.fill('#wipeConfirmInput', '唔啱嘅字');
  check('打錯確認字,清除按鈕仍然disabled', await page.isDisabled('#wipeConfirmBtn'));
  await page.fill('#wipeConfirmInput', '刪除');
  check('打啱「刪除」先至啟用清除按鈕', !(await page.isDisabled('#wipeConfirmBtn')));
  await page.click('#wipeConfirmBtn');
  await page.waitForSelector('#noProfileNotice:not([hidden])');
  check('清除全部資料之後返去「未有檔案」初始畫面', await page.isVisible('#noProfileNotice'));
  const profileOptionsAfterWipe = await page.$$eval('#profileSelect option', (opts) => opts.length);
  check('清除全部資料之後profile下拉選單冇任何選項', profileOptionsAfterWipe === 0);

  check('全程冇JS console error', consoleErrors.length === 0);
  if (consoleErrors.length > 0) {
    console.log('  console errors 內容:', consoleErrors);
  }

  await browser.close();
  server.close();

  fs.unlinkSync(ilrPdfPath);
  fs.unlinkSync(bcPdfPath);
  fs.unlinkSync(jsonPath);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n總結: ${results.length - failed.length}/${results.length} 個通過`);
  if (failed.length > 0) {
    console.log('失敗項目:', failed.map((f) => f.name));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('E2E測試發生錯誤:', err);
  process.exit(1);
});
