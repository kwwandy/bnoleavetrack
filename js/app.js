/*
 * app.js — UI 邏輯:負責畫面渲染同事件處理,實際計算/資料操作交返
 * dates.js / calc.js / db.js / pdf.js 處理。
 */
(function () {
  'use strict';

  const D = window.DateUtils;
  const Calc = window.Calc;
  const DB = window.BnoDB;
  const Theme = window.ThemeManager;

  const state = {
    profiles: [],
    currentProfileId: null,
    currentProfile: null,
    settings: null,
    trips: [],
    editingTripId: null,
  };

  function $(id) { return document.getElementById(id); }

  // ---------------- 通用小工具 ----------------

  function badge(passed) {
    return passed
      ? '<span class="badge badge-ok">符合規定</span>'
      : '<span class="badge badge-danger">超出上限</span>';
  }

  function fmtHK(iso) {
    if (!iso) return '未填';
    return iso;
  }

  async function saveFile(blob, suggestedName) {
    if (window.showSaveFilePicker) {
      try {
        const ext = suggestedName.split('.').pop();
        const mimeType = ext === 'pdf' ? 'application/pdf' : 'application/json';
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [
            {
              description: ext.toUpperCase() + ' file',
              accept: { [mimeType]: ['.' + ext] },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { ok: true, method: 'picker' };
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false, method: 'cancelled' };
        console.warn('showSaveFilePicker 失敗,fallback 落標準下載', e);
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { ok: true, method: 'download' };
  }

  // ---------------- Modal ----------------

  function showModal(innerHtml, onMount) {
    const root = $('modalRoot');
    root.innerHTML = `<div class="modal-backdrop" id="modalBackdrop"><div class="modal-box">${innerHtml}</div></div>`;
    const backdrop = $('modalBackdrop');
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });
    if (onMount) onMount(root);
  }

  function closeModal() {
    $('modalRoot').innerHTML = '';
  }

  // ---------------- 初始化 / 檔案切換 ----------------

  async function init() {
    wireTabs();
    wireStaticForms();
    await refreshProfileList();
    const lastId = localStorage.getItem('bno.lastProfileId');
    if (state.profiles.length === 0) {
      $('noProfileNotice').hidden = false;
      $('tabPanels').hidden = true;
    } else {
      const toLoad = state.profiles.find((p) => p.id === lastId) || state.profiles[0];
      await loadProfile(toLoad.id);
    }
  }

  async function refreshProfileList() {
    state.profiles = await DB.listProfiles();
    const sel = $('profileSelect');
    sel.innerHTML = state.profiles
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name || '未命名')}</option>`)
      .join('');
    if (state.currentProfileId) sel.value = state.currentProfileId;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function loadProfile(id) {
    state.currentProfileId = id;
    localStorage.setItem('bno.lastProfileId', id);
    state.currentProfile = await DB.getProfile(id);
    state.settings = await DB.getSettings(id);
    state.trips = (await DB.listTrips(id)).sort((a, b) => D.compare(a.departureDate, b.departureDate));

    $('noProfileNotice').hidden = true;
    $('tabPanels').hidden = false;
    $('profileSelect').value = id;

    renderProfileForm();
    renderTaxTestTab();
    renderTripsTab();
    renderOverviewTab();
    renderSettingsForm();
    $('reportStatus').textContent = '';
  }

  // ---------------- Tabs ----------------

  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        $('tab-' + btn.dataset.tab).classList.add('active');
      });
    });
  }

  // ---------------- 出入境日誌 ----------------

  function computeRow(trip) {
    const days = D.tripAbsenceDays(trip.departureDate, trip.returnDate);
    return days;
  }

  function renderTripsTab() {
    const tbody = $('tripTableBody');

    // 偵測成個列表入面兩兩重疊嘅行程(日期範圍有撞),純粹做UI提醒/標記用,
    // 唔會影響缺勤計算(嗰邊已經用 mergeIntervals 處理咗,唔會重複計)。
    const overlapPairs = Calc.findAllOverlaps(state.trips);
    const overlappingIds = new Set();
    overlapPairs.forEach((pair) => {
      overlappingIds.add(pair.a.id);
      overlappingIds.add(pair.b.id);
    });
    const summaryEl = $('tripOverlapSummary');
    if (overlapPairs.length > 0) {
      summaryEl.textContent = `⚠ 偵測到 ${overlapPairs.length} 組行程日期重疊(下面橙色標記),缺勤計算唔會重複計,但建議check清楚係咪打錯。`;
      summaryEl.hidden = false;
    } else {
      summaryEl.hidden = true;
    }

    if (state.trips.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="hint">仲未有紀錄</td></tr>';
    } else {
      tbody.innerHTML = state.trips
        .map((t) => {
          const days = computeRow(t);
          const estTag = t.isEstimated ? ' <span class="badge badge-warn">預計</span>' : '';
          const rowClass = overlappingIds.has(t.id) ? ' class="overlap-row"' : '';
          return `<tr${rowClass}>
            <td data-label="離境日">${t.departureDate}</td>
            <td data-label="返英日">${t.returnDate}${estTag}</td>
            <td data-label="缺勤日數">${days}</td>
            <td data-label="離境航班">${escapeHtml(t.outboundFlightNo || '')}</td>
            <td data-label="返英航班">${escapeHtml(t.inboundFlightNo || '')}</td>
            <td class="wrap" data-label="備註">${escapeHtml(t.reason || '')}</td>
            <td class="actions-cell">
              <button class="btn-secondary" data-action="edit-trip" data-id="${t.id}">編輯</button>
              <button class="btn-secondary" data-action="copy-trip" data-id="${t.id}">同行者</button>
              <button class="btn-danger" data-action="delete-trip" data-id="${t.id}">刪除</button>
            </td>
          </tr>`;
        })
        .join('');
    }

    tbody.querySelectorAll('[data-action="edit-trip"]').forEach((btn) => {
      btn.addEventListener('click', () => startEditTrip(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="delete-trip"]').forEach((btn) => {
      btn.addEventListener('click', () => deleteTrip(btn.dataset.id));
    });
    tbody.querySelectorAll('[data-action="copy-trip"]').forEach((btn) => {
      btn.addEventListener('click', () => openCopyTripModal(btn.dataset.id));
    });
  }

  // ---------------- 複製單一行程去其他檔案(即「同行者」功能) ----------------

  function openCopyTripModal(tripId) {
    const trip = state.trips.find((t) => t.id === tripId);
    if (!trip) return;
    const others = state.profiles.filter((p) => p.id !== state.currentProfileId);
    if (others.length === 0) {
      showModal(
        `<h3>複製呢程行程</h3>
         <p class="hint">得返呢一個檔案,冇其他檔案可以複製過去。</p>
         <div class="form-actions"><button class="btn-secondary" id="copyTripCloseBtn">關閉</button></div>`,
        (root) => root.querySelector('#copyTripCloseBtn').addEventListener('click', closeModal)
      );
      return;
    }
    showModal(
      `<h3>複製呢程行程到其他檔案</h3>
       <p class="hint">${trip.departureDate} ~ ${trip.returnDate}。會喺揀咗嘅檔案各自新增一筆獨立紀錄,之後編輯/刪除唔會連動,想改要去返嗰個檔案自己編輯。</p>
       <div class="form-grid">
         <div class="checkbox-list" id="copyTripTargets">
           ${others
             .map(
               (p) =>
                 `<label class="checkbox-label"><input type="checkbox" class="copy-target-checkbox" value="${p.id}"> ${escapeHtml(p.name || '未命名')}</label>`
             )
             .join('')}
         </div>
         <p class="hint" id="copyTripStatus" hidden></p>
         <div class="form-actions">
           <button class="btn-primary" id="copyTripConfirmBtn">複製</button>
           <button class="btn-secondary" id="copyTripCancelBtn">取消</button>
         </div>
       </div>`,
      (root) => {
        root.querySelector('#copyTripCancelBtn').addEventListener('click', closeModal);
        const confirmBtn = root.querySelector('#copyTripConfirmBtn');
        confirmBtn.addEventListener('click', async () => {
          const statusEl = root.querySelector('#copyTripStatus');
          const targetIds = Array.from(root.querySelectorAll('.copy-target-checkbox:checked')).map((el) => el.value);
          if (targetIds.length === 0) {
            statusEl.textContent = '請先勾選至少一個檔案。';
            statusEl.hidden = false;
            return;
          }
          const payload = {
            departureDate: trip.departureDate,
            returnDate: trip.returnDate,
            isEstimated: !!trip.isEstimated,
            outboundFlightNo: trip.outboundFlightNo || '',
            inboundFlightNo: trip.inboundFlightNo || '',
            reason: trip.reason || '',
          };
          for (const pid of targetIds) {
            await DB.addTrip(pid, payload);
          }
          statusEl.textContent = `已經複製咗去 ${targetIds.length} 個檔案。`;
          statusEl.hidden = false;
          // 成功之後即刻disable埋啲checkbox同「複製」掣,防止用戶再撳多幾下
          // 造成重複紀錄;想再複製多一次要重新開返個modal。
          root.querySelectorAll('.copy-target-checkbox').forEach((el) => { el.disabled = true; });
          confirmBtn.disabled = true;
          confirmBtn.textContent = '已複製';
        });
      }
    );
  }

  function startEditTrip(id) {
    const trip = state.trips.find((t) => t.id === id);
    if (!trip) return;
    state.editingTripId = id;
    $('tripId').value = id;
    $('tripDeparture').value = trip.departureDate;
    $('tripReturn').value = trip.returnDate;
    $('tripEstimated').checked = !!trip.isEstimated;
    $('tripOutboundFlight').value = trip.outboundFlightNo || '';
    $('tripInboundFlight').value = trip.inboundFlightNo || '';
    $('tripReason').value = trip.reason || '';
    $('tripSubmitBtn').textContent = '更新紀錄';
    $('tripCancelEdit').hidden = false;
    if ($('tripOverlapWarning')) $('tripOverlapWarning').hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetTripForm() {
    state.editingTripId = null;
    $('tripId').value = '';
    $('tripForm').reset();
    $('tripSubmitBtn').textContent = '新增紀錄';
    $('tripCancelEdit').hidden = true;
    $('tripFormError').hidden = true;
  }

  async function deleteTrip(id) {
    if (!confirm('確定刪除呢筆紀錄?')) return;
    await DB.deleteTrip(id);
    state.trips = (await DB.listTrips(state.currentProfileId)).sort((a, b) => D.compare(a.departureDate, b.departureDate));
    renderTripsTab();
  }

  // ---------------- 個人資料 / 里程碑 ----------------

  function renderProfileForm() {
    const p = state.currentProfile;
    $('pfName').value = p.name || '';
    $('pfPassportNo').value = p.passportNo || '';
    updatePassportWarning();
    $('pfVisaGrantDate').value = p.visaGrantDate || '';
    $('pfFirstArrivalDate').value = p.firstArrivalDate || '';
    $('pfMarried').checked = !!p.marriedToBritishCitizen;
    $('pfIlrGrantDate').value = p.ilrGrantDate || '';
  }

  // 護照號碼揀咗做選填,但因為會用嚟核對報告/檔案名,留空嘅話用橙色warning
  // 提醒一下(唔阻擋提交,純粹提示)。打字嗰陣即時更新,唔使等submit先見到。
  function updatePassportWarning() {
    const warnEl = $('pfPassportWarning');
    if (!warnEl) return;
    warnEl.hidden = !!$('pfPassportNo').value.trim();
  }

  function renderOverviewTab() {
    const p = state.currentProfile;
    const s = state.settings;
    const ilrEl = $('ilrSummary');
    const bcEl = $('bcSummary');

    if (!p.visaGrantDate) {
      ilrEl.innerHTML = '請先喺「基本資料」分頁填寫簽證生效日';
      bcEl.innerHTML = '請先喺「基本資料」分頁填寫簽證生效日';
      // 呢兩樣嘢喺下面先會重新填值/重新render,新profile未填簽證生效日就會喺呢度
      // 提早return,所以要喺度手動清走殘留內容,咪畀用戶以為「假設申請日」跟咗
      // 上一個profile(其實只係輸入框冇被reset)。
      $('bcApplicationDateInput').value = '';
      const staleContainer = document.getElementById('bcComplianceContainer');
      if (staleContainer) staleContainer.remove();
      return;
    }

    const qualifyingDate = Calc.ilrQualifyingDate(p, s);
    const earliestApply = Calc.ilrEarliestApplyDate(p, s);
    const ilrReport = Calc.ilrComplianceReport(p, state.trips, s);

    ilrEl.innerHTML = `
      <div class="status-line"><span>合資格日(滿${s.ilrQualifyingYears}年)</span><span>${qualifyingDate}</span></div>
      <div class="status-line"><span>最早可遞交日(提前${s.ilrEarlyApplyDays}日)</span><span>${earliestApply}</span></div>
      <div class="status-line"><span>缺勤合規</span><span>${badge(ilrReport.passed)}</span></div>
      <p class="hint">歷史最高12個月缺勤:${ilrReport.worst.days}/${ilrReport.limit} 日</p>
    `;

    const bcDate = Calc.bcEarliestApplyDate(p, s);
    // 「假設申請日」一律以profile入面已儲存嘅值為準(冇就用計算返嘅最早可遞交日做預設),
    // 呢個值會同PDF報告(BC版)共用,確保兩邊數字一致 —— 唔再靠「輸入框係咪空白」嚟判斷。
    $('bcApplicationDateInput').value = p.bcAssumedApplicationDate || bcDate;

    bcEl.innerHTML = `
      <div class="status-line"><span>${p.marriedToBritishCitizen ? '最早可遞交日(配偶為英籍,ILR批出即可)' : '最早可遞交日(ILR批出後 + ' + s.bcWaitAfterIlrMonths + ' 個月)'}</span><span>${bcDate}</span></div>
      <div class="status-line"><span>入籍路線</span><span>${p.marriedToBritishCitizen ? 'Section 6(2) 配偶路線(3年/270日)' : 'Section 6(1) 一般路線(5年/450日)'}</span></div>
      ${p.ilrGrantDate ? '' : '<p class="hint">未填「ILR實際批出日」,以上為根據合資格日推算嘅估計值。</p>'}
    `;

    renderBcCompliance();
  }

  async function onBcApplicationDateChange() {
    const val = $('bcApplicationDateInput').value;
    state.currentProfile = await DB.updateProfile(state.currentProfileId, {
      bcAssumedApplicationDate: val || null,
    });
    renderBcCompliance();
  }

  function renderBcCompliance() {
    const p = state.currentProfile;
    const s = state.settings;
    const appDate = $('bcApplicationDateInput').value;
    if (!appDate) return;
    const nat = Calc.naturalisationComplianceReport(p, state.trips, s, appDate);
    const html = `
      <div id="bcComplianceBox">
        <p class="hint">以假設申請日 ${appDate} 計算:</p>
        <div class="status-line"><span>過去${nat.qualifyingYears}年缺勤</span><span>${nat.totalPeriod.days} / ${nat.totalPeriod.limit} 日 ${badge(nat.totalPeriod.passed)}</span></div>
        <div class="status-line"><span>過去12個月缺勤</span><span>${nat.twelveMonth.days} / ${nat.twelveMonth.limit} 日 ${badge(nat.twelveMonth.passed)}</span></div>
      </div>`;
    const bcEl = $('bcSummary');
    // 保留上面已經 render 嘅摘要行,將 compliance box 放喺後面
    let container = document.getElementById('bcComplianceContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'bcComplianceContainer';
      bcEl.after(container);
    }
    container.innerHTML = html;
  }

  // ---------------- 稅務/考試 ----------------

  function renderTaxTestTab() {
    renderTaxTestForms();
    renderTaxTestSummaries();
  }

  // 淨係喺換檔案/剛載入嗰陣先叫,填返輸入框嘅值。
  // 千祈唔好喺表單submit之後叫呢個function,否則會沖走另一個表單未儲存嘅輸入。
  function renderTaxTestForms() {
    const p = state.currentProfile;
    if (p.uktaxResidentFromTaxYear) {
      $('taxYearInput').value = p.uktaxResidentFromTaxYear;
    } else {
      // 未填過就用「首次抵英日」輔助估算一個建議值填入輸入框(用戶可以自行覆蓋),
      // 唔會自動儲存落資料庫 —— 要用戶自己撳「儲存」先算數。
      const suggested = Calc.suggestFirstTaxResidentYear(p);
      $('taxYearInput').value = suggested || '';
    }
    $('englishTestDateInput').value = p.englishTestDate || '';
    $('lifeUkTestDateInput').value = p.lifeInUkTestDate || '';
  }

  // 喺「基本資料」分頁儲存首次抵英日之後,如果稅年輸入框仲係得閒(用戶未曾自己打過嘢,
  // 亦都未儲存過),就即刻補上建議值,唔使用戶要切檔案/重新整頁先見到。
  // 只有喺輸入框而家係空嘅先會填,唔會搶走用戶已經打緊、仲未儲存嘅稅務/考試表單內容。
  function refreshFigSuggestionIfEmpty() {
    const p = state.currentProfile;
    if (p.uktaxResidentFromTaxYear) return;
    const input = $('taxYearInput');
    if (!input || input.value) return;
    const suggested = Calc.suggestFirstTaxResidentYear(p);
    if (suggested) input.value = suggested;
  }

  // 淨係更新摘要顯示,唔會touch任何輸入框嘅值 —— 表單submit之後叫呢個就安全。
  // 同一份摘要會鏡射去「總覽」分頁嘅對應位置(ov 開頭嘅id),兩邊永遠一致。
  function renderTaxTestSummaries() {
    const p = state.currentProfile;
    const s = state.settings;

    const fig = Calc.figWindow(p, s);
    const figHtml = fig
      ? `<div class="status-line"><span>FIG 豁免窗口</span><span>${fig.startLabel} 至 ${fig.endLabel}</span></div>`
      : '未填稅務居民稅年,暫時冇資料。';
    $('figSummary').innerHTML = figHtml;
    if ($('ovFigSummary')) $('ovFigSummary').innerHTML = figHtml;

    const eng = Calc.testExpiry(p.englishTestDate, s.englishTestValidityYears);
    const life = Calc.testExpiry(p.lifeInUkTestDate, s.lifeInUkTestValidityYears);
    let html = '';
    if (eng) {
      html += eng.noExpiry
        ? `<div class="status-line"><span>英文試</span><span>已登記(現行參數設定為無時限)</span></div>`
        : `<div class="status-line"><span>英文試假設到期日</span><span>${eng.expiryDate} ${eng.expired ? '<span class="badge badge-danger">已過期</span>' : '<span class="badge badge-ok">有效</span>'}</span></div>`;
    }
    if (life) {
      html += life.noExpiry
        ? `<div class="status-line"><span>Life in the UK</span><span>已登記(現行官方指引冇註明到期日)</span></div>`
        : `<div class="status-line"><span>Life in the UK 假設到期日</span><span>${life.expiryDate} ${life.expired ? '<span class="badge badge-danger">已過期</span>' : '<span class="badge badge-ok">有效</span>'}</span></div>`;
    }
    const examHtml = html || '未填任何考試日期。';
    $('examSummary').innerHTML = examHtml;
    if ($('ovExamSummary')) $('ovExamSummary').innerHTML = examHtml;
  }

  // ---------------- 參數設定 ----------------

  function renderSettingsForm() {
    const s = state.settings;
    $('setRollingLimit').value = s.rollingAbsenceLimitDays;
    $('setIlrYears').value = s.ilrQualifyingYears;
    $('setIlrEarlyDays').value = s.ilrEarlyApplyDays;
    $('setNatYearsUnmarried').value = s.naturalisationQualifyingYearsUnmarried;
    $('setNatDaysUnmarried').value = s.naturalisationTotalAbsenceDaysUnmarried;
    $('setNatYearsMarried').value = s.naturalisationQualifyingYearsMarried;
    $('setNatDaysMarried').value = s.naturalisationTotalAbsenceDaysMarried;
    $('setNatLast12').value = s.naturalisationLast12MonthDays;
    $('setBcWaitMonths').value = s.bcWaitAfterIlrMonths;
    $('setEnglishTestValidity').value = s.englishTestValidityYears;
    $('setLifeUkTestValidity').value = s.lifeInUkTestValidityYears;
    $('setFigYears').value = s.figExemptionYears;
    $('setLastVerified').value = s.lastVerifiedDate || '';
    renderThemePicker();
  }

  // ---------------- 外觀(色系/淺深色) ----------------
  // 呢個係成個app嘅外觀設定,唔跟住個別檔案(profile),所以直接讀/寫
  // localStorage(由 theme.js 嘅 ThemeManager處理),唔使經過IndexedDB。

  function renderThemePicker() {
    if (!Theme) return;
    const theme = Theme.getTheme();
    const mode = Theme.getMode();
    document.querySelectorAll('input[name="themeChoice"]').forEach((el) => {
      el.checked = el.value === theme;
    });
    document.querySelectorAll('input[name="modeChoice"]').forEach((el) => {
      el.checked = el.value === mode;
    });
  }

  // ---------------- 表單事件綁定(只做一次) ----------------

  function wireStaticForms() {
    $('btnNewProfile').addEventListener('click', openNewProfileModal);
    $('btnManageProfile').addEventListener('click', openManageProfileModal);
    $('profileSelect').addEventListener('change', (e) => loadProfile(e.target.value));

    document.querySelectorAll('input[name="themeChoice"]').forEach((el) => {
      el.addEventListener('change', (e) => {
        if (Theme) Theme.setTheme(e.target.value);
      });
    });
    document.querySelectorAll('input[name="modeChoice"]').forEach((el) => {
      el.addEventListener('change', (e) => {
        if (Theme) Theme.setMode(e.target.value);
      });
    });

    $('tripForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const departureDate = $('tripDeparture').value;
      const returnDate = $('tripReturn').value;
      const errEl = $('tripFormError');
      const warnEl = $('tripOverlapWarning');
      errEl.hidden = true;
      if (warnEl) warnEl.hidden = true;
      if (!departureDate || !returnDate) {
        errEl.textContent = '離境日同返英日都係必填';
        errEl.hidden = false;
        return;
      }
      if (D.compare(returnDate, departureDate) < 0) {
        errEl.textContent = '返英日期唔可以早過離境日期';
        errEl.hidden = false;
        return;
      }
      // 重疊日期偵測:淨係提醒,唔會阻止提交(例如更正紀錄時,重疊可能係刻意嘅)。
      if (warnEl) {
        const overlaps = Calc.findOverlappingTrips(
          { id: state.editingTripId, departureDate, returnDate },
          state.trips
        );
        if (overlaps.length > 0) {
          const ranges = overlaps.map((t) => `${t.departureDate} ~ ${t.returnDate}`).join('、');
          warnEl.textContent = `⚠ 呢程同 ${ranges} 有日期重疊,已經幫你儲存,缺勤計算唔會重複計,但建議check清楚係咪打錯。`;
          warnEl.hidden = false;
        }
      }
      const payload = {
        departureDate,
        returnDate,
        isEstimated: $('tripEstimated').checked,
        outboundFlightNo: $('tripOutboundFlight').value.trim(),
        inboundFlightNo: $('tripInboundFlight').value.trim(),
        reason: $('tripReason').value.trim(),
      };
      try {
        if (state.editingTripId) {
          await DB.updateTrip(state.editingTripId, payload);
        } else {
          await DB.addTrip(state.currentProfileId, payload);
        }
        state.trips = (await DB.listTrips(state.currentProfileId)).sort((a, b) => D.compare(a.departureDate, b.departureDate));
        resetTripForm();
        renderTripsTab();
        renderOverviewTab();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });

    $('tripCancelEdit').addEventListener('click', resetTripForm);

    $('pfPassportNo').addEventListener('input', updatePassportWarning);

    $('profileForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = {
        name: $('pfName').value.trim() || '未命名',
        passportNo: $('pfPassportNo').value.trim() || null,
        visaGrantDate: $('pfVisaGrantDate').value || null,
        firstArrivalDate: $('pfFirstArrivalDate').value || null,
        marriedToBritishCitizen: $('pfMarried').checked,
        ilrGrantDate: $('pfIlrGrantDate').value || null,
      };
      state.currentProfile = await DB.updateProfile(state.currentProfileId, patch);
      await refreshProfileList();
      renderTripsTab();
      renderOverviewTab();
      refreshFigSuggestionIfEmpty();
    });

    $('bcApplicationDateInput').addEventListener('change', onBcApplicationDateChange);

    $('taxForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = $('taxYearInput').value;
      state.currentProfile = await DB.updateProfile(state.currentProfileId, {
        uktaxResidentFromTaxYear: val || null,
      });
      renderTaxTestSummaries();
    });

    $('examForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      state.currentProfile = await DB.updateProfile(state.currentProfileId, {
        englishTestDate: $('englishTestDateInput').value || null,
        lifeInUkTestDate: $('lifeUkTestDateInput').value || null,
      });
      renderTaxTestSummaries();
    });

    $('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = {
        rollingAbsenceLimitDays: Number($('setRollingLimit').value),
        ilrQualifyingYears: Number($('setIlrYears').value),
        ilrEarlyApplyDays: Number($('setIlrEarlyDays').value),
        naturalisationQualifyingYearsUnmarried: Number($('setNatYearsUnmarried').value),
        naturalisationTotalAbsenceDaysUnmarried: Number($('setNatDaysUnmarried').value),
        naturalisationQualifyingYearsMarried: Number($('setNatYearsMarried').value),
        naturalisationTotalAbsenceDaysMarried: Number($('setNatDaysMarried').value),
        naturalisationLast12MonthDays: Number($('setNatLast12').value),
        bcWaitAfterIlrMonths: Number($('setBcWaitMonths').value),
        englishTestValidityYears: Number($('setEnglishTestValidity').value) || 0,
        lifeInUkTestValidityYears: Number($('setLifeUkTestValidity').value) || 0,
        figExemptionYears: Number($('setFigYears').value),
        lastVerifiedDate: $('setLastVerified').value || null,
      };
      state.settings = await DB.saveSettings(state.currentProfileId, patch);
      renderTripsTab();
      renderOverviewTab();
      renderTaxTestSummaries();
    });

    $('btnResetDefaults').addEventListener('click', async () => {
      if (!confirm('確定要將全部參數還原做預設值?')) return;
      state.settings = await DB.saveSettings(state.currentProfileId, Calc.DEFAULT_SETTINGS);
      renderSettingsForm();
      renderTripsTab();
      renderOverviewTab();
      renderTaxTestSummaries();
    });

    async function generateAndSaveReport(doc, reportTypeLabel) {
      const statusEl = $('reportStatus');
      try {
        const blob = doc.output('blob');
        const filename = Calc.buildReportFilename(state.currentProfile, reportTypeLabel, D.today());
        const result = await saveFile(blob, filename);
        if (result.ok) {
          statusEl.textContent = result.method === 'picker' ? '已經儲存到你揀嘅位置。' : '已經下載到你嘅下載資料夾。';
        } else {
          statusEl.textContent = '已取消。';
        }
      } catch (err) {
        console.error(err);
        statusEl.textContent = '生成PDF時發生錯誤:' + err.message;
      }
    }

    $('btnGenerateIlrReport').addEventListener('click', async () => {
      try {
        const doc = window.PdfReport.generateIlrReport({
          profile: state.currentProfile,
          trips: state.trips,
          settings: state.settings,
        });
        await generateAndSaveReport(doc, 'ILR');
      } catch (err) {
        console.error(err);
        $('reportStatus').textContent = '生成PDF時發生錯誤:' + err.message;
      }
    });

    $('btnGenerateBcReport').addEventListener('click', async () => {
      try {
        const p = state.currentProfile;
        const applicationDate = p.bcAssumedApplicationDate || Calc.bcEarliestApplyDate(p, state.settings);
        const doc = window.PdfReport.generateNaturalisationReport({
          profile: p,
          trips: state.trips,
          settings: state.settings,
          applicationDate,
        });
        await generateAndSaveReport(doc, 'BC');
      } catch (err) {
        console.error(err);
        $('reportStatus').textContent = '生成PDF時發生錯誤:' + err.message;
      }
    });

    $('btnExportProfile').addEventListener('click', async () => {
      const data = await DB.exportProfile(state.currentProfileId);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      await saveFile(blob, `bno-backup-${(state.currentProfile.name || 'profile').replace(/\s+/g, '_')}-${D.today()}.json`);
    });

    $('btnExportAll').addEventListener('click', async () => {
      const data = await DB.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      await saveFile(blob, `bno-backup-all-${D.today()}.json`);
    });

    $('importFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const statusEl = $('importStatus');
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const result = await DB.importData(data);
        statusEl.textContent = `已成功匯入 ${result.importedProfiles} 個檔案。`;
        await refreshProfileList();
      } catch (err) {
        statusEl.textContent = '匯入失敗:' + err.message;
      } finally {
        e.target.value = '';
      }
    });

    $('btnWipeAllData').addEventListener('click', openWipeAllDataModal);
  }

  // ---------------- 清除本機所有資料 ----------------

  function openWipeAllDataModal() {
    const CONFIRM_WORD = '刪除';
    showModal(
      `<h3>清除本機所有資料</h3>
       <p class="hint">呢個會永久刪走呢個瀏覽器入面全部檔案、全部行程紀錄同全部參數設定,冇得還原。如果想保留紀錄,請先去「輸出備份」匯出。</p>
       <div class="form-grid">
         <label>肯定要刪嘅話,請喺下面打「${CONFIRM_WORD}」兩個字確認
           <input type="text" id="wipeConfirmInput" placeholder="${CONFIRM_WORD}">
         </label>
         <div class="form-actions">
           <button class="btn-danger" id="wipeConfirmBtn" disabled>永久刪除全部資料</button>
           <button class="btn-secondary" id="wipeCancelBtn">取消</button>
         </div>
       </div>`,
      (root) => {
        const input = root.querySelector('#wipeConfirmInput');
        const confirmBtn = root.querySelector('#wipeConfirmBtn');
        input.addEventListener('input', () => {
          confirmBtn.disabled = input.value.trim() !== CONFIRM_WORD;
        });
        root.querySelector('#wipeCancelBtn').addEventListener('click', closeModal);
        confirmBtn.addEventListener('click', async () => {
          if (input.value.trim() !== CONFIRM_WORD) return;
          await DB.wipeAllData();
          closeModal();
          localStorage.removeItem('bno.lastProfileId');
          state.profiles = [];
          state.currentProfileId = null;
          state.currentProfile = null;
          state.settings = null;
          state.trips = [];
          await refreshProfileList();
          $('noProfileNotice').hidden = false;
          $('tabPanels').hidden = true;
        });
      }
    );
  }

  // ---------------- 檔案管理 Modal ----------------

  function openNewProfileModal() {
    showModal(
      `<h3>新增檔案</h3>
       <div class="form-grid">
         <label>檔案名稱<input type="text" id="newProfileName" placeholder="例如:阿明"></label>
         <div class="form-actions">
           <button class="btn-primary" id="newProfileConfirm">建立</button>
           <button class="btn-secondary" id="newProfileCancel">取消</button>
         </div>
       </div>`,
      (root) => {
        root.querySelector('#newProfileCancel').addEventListener('click', closeModal);
        root.querySelector('#newProfileConfirm').addEventListener('click', async () => {
          const name = root.querySelector('#newProfileName').value.trim() || '未命名';
          const profile = await DB.createProfile({ name });
          closeModal();
          await refreshProfileList();
          await loadProfile(profile.id);
        });
      }
    );
  }

  function openManageProfileModal() {
    const p = state.currentProfile;
    showModal(
      `<h3>管理檔案</h3>
       <div class="form-grid">
         <label>改名<input type="text" id="renameInput" value="${escapeHtml(p.name)}"></label>
         <div class="form-actions">
           <button class="btn-primary" id="renameConfirm">儲存名稱</button>
         </div>
         <hr>
         <button class="btn-danger" id="deleteProfileBtn">刪除呢個檔案</button>
         <div class="form-actions">
           <button class="btn-secondary" id="manageCancel">關閉</button>
         </div>
       </div>`,
      (root) => {
        root.querySelector('#manageCancel').addEventListener('click', closeModal);
        root.querySelector('#renameConfirm').addEventListener('click', async () => {
          const name = root.querySelector('#renameInput').value.trim() || '未命名';
          await DB.updateProfile(p.id, { name });
          closeModal();
          await refreshProfileList();
          await loadProfile(p.id);
        });
        root.querySelector('#deleteProfileBtn').addEventListener('click', async () => {
          if (!confirm(`確定刪除檔案「${p.name}」?呢個動作唔可以還原。`)) return;
          await DB.deleteProfile(p.id);
          closeModal();
          state.currentProfileId = null;
          await refreshProfileList();
          if (state.profiles.length > 0) {
            await loadProfile(state.profiles[0].id);
          } else {
            $('noProfileNotice').hidden = false;
            $('tabPanels').hidden = true;
          }
        });
      }
    );
  }

  // ---------------- Service worker(離線支援,失敗都唔影響主功能) ----------------

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service worker 註冊失敗(唔影響基本功能):', err);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    init();
    registerServiceWorker();
  });
})();
