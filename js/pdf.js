/*
 * pdf.js — 用 jsPDF 生成英文版出入境紀錄報告(供 Home Office 使用)。
 * 報告分兩種用途,各自淨係顯示同嗰個申請相關嘅合規指標,唔會混埋一齊:
 *   - generateIlrReport():俾 ILR(永久居留)申請用 —— 只顯示「任何連續12個月」
 *     嘅180日滾動缺勤檢查。
 *   - generateNaturalisationReport():俾 BC(入籍)申請用 —— 只顯示入籍專用嘅
 *     「過去N年」(3或5年)同「過去12個月」缺勤檢查,唔會摻雜 ILR 嗰把尺。
 * 咁樣分開嘅原因:兩種申請嘅缺勤規則完全獨立(例如入籍嘅「過去12個月90日」
 * 同 ILR 嘅「任何12個月180日」睇落相似但其實唔同一套規則),混喺同一份文件
 * 容易誤導閱讀者(包括申請人自己同Home Office職員)以為兩者有關連。
 * 報告內容只包括:出入境紀錄表 + 該申請相關嘅缺勤合規摘要。唔包括稅務/考試資料,
 * 亦唔會顯示同任何法定上限都對應唔上嘅「歷來總缺勤日數」呢類模糊數字。
 */
(function (global) {
  'use strict';

  const D = global.DateUtils;
  const Calc = global.Calc;

  function fmtEN(iso) {
    if (!iso) return '-';
    const [y, m, d] = iso.split('-').map(Number);
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return `${String(d).padStart(2, '0')} ${months[m - 1]} ${y}`;
  }

  /**
   * jsPDF 內置標準字型(helvetica)只支援 WinAnsi(大致等於 Latin-1)字元集,
   * 中文/廣東話字元會變亂碼。呢個 function 用嚟保護任何有機會混入 PDF 嘅
   * 使用者自訂文字(例如檔案名稱),如發現有唔支援嘅字元就用替代文字頂住,
   * 好過印一堆亂碼出嚟。
   */
  function toPdfSafeText(str, fallbackNote) {
    if (!str) return '';
    const hasUnsupported = /[^\x00-\xFF]/.test(str);
    return hasUnsupported ? fallbackNote : str;
  }

  function buildRows(profile, trips) {
    const rows = [];
    if (profile.visaGrantDate && profile.firstArrivalDate) {
      const gapDays = D.implicitEntryGapDays(profile.visaGrantDate, profile.firstArrivalDate);
      if (gapDays > 0) {
        rows.push({
          departure: profile.visaGrantDate,
          ret: profile.firstArrivalDate,
          days: gapDays,
          outbound: '',
          inbound: '',
          note: 'Gap between visa grant and first entry to the UK',
        });
      }
    }
    (trips || []).forEach((t) => {
      if (!t.departureDate || !t.returnDate) return;
      // 備註/航班編號都係使用者自訂文字,用 toPdfSafeText 保護一下 ——
      // jsPDF內置字型(helvetica)唔支援中文,若果打咗中文就用提示文字頂住,
      // 好過印一堆亂碼。建議喺app入面用英文/數字輸入呢兩類欄位。
      const noteParts = [];
      if (t.reason) {
        noteParts.push(toPdfSafeText(t.reason, '(note uses non-Latin characters - please re-enter in English)'));
      }
      if (t.isEstimated) noteParts.push('Estimated / not yet confirmed');
      rows.push({
        departure: t.departureDate,
        ret: t.returnDate,
        days: D.tripAbsenceDays(t.departureDate, t.returnDate),
        outbound: toPdfSafeText(t.outboundFlightNo, '?'),
        inbound: toPdfSafeText(t.inboundFlightNo, '?'),
        note: noteParts.join(' - '),
      });
    });
    rows.sort((a, b) => D.compare(a.departure, b.departure));
    return rows;
  }

  function newDoc() {
    if (!global.jspdf || !global.jspdf.jsPDF) {
      throw new Error('jsPDF library not loaded');
    }
    const { jsPDF } = global.jspdf;
    // 用橫向(landscape),因為表格加咗航班編號兩欄之後,直向A4闊度唔夠位。
    return new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
  }

  function drawHeaderBlock(doc, ctx, title, profile) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    // 標題(尤其入籍版)可能太長,一行喺16pt bold下會超出版面闊度而被裁走,
    // 所以要用 splitTextToSize 確保會自動換行,唔會有文字消失。
    const titleLines = doc.splitTextToSize(title, ctx.pageWidth - ctx.marginX * 2);
    doc.text(titleLines, ctx.marginX, ctx.y);
    ctx.y += 20 * Math.max(1, titleLines.length) + 2;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const safeName = toPdfSafeText(
      profile.name,
      '(name uses non-Latin characters - please re-enter using English/Latin letters for this report)'
    );
    const nameLines = doc.splitTextToSize(`Name: ${safeName || '-'}`, ctx.pageWidth - ctx.marginX * 2);
    doc.text(nameLines, ctx.marginX, ctx.y);
    ctx.y += 14 * Math.max(1, nameLines.length);
    // 護照號碼淨係選填,得填咗先會印落嚟(冇填就完全唔顯示呢行,唔會印
    // 「Passport No: -」呢類空白資訊)。
    if (profile.passportNo) {
      const safePassportNo = toPdfSafeText(
        profile.passportNo,
        '(passport number uses non-Latin characters - please re-enter using English/Latin letters and digits)'
      );
      const passportLines = doc.splitTextToSize(`Passport No: ${safePassportNo}`, ctx.pageWidth - ctx.marginX * 2);
      doc.text(passportLines, ctx.marginX, ctx.y);
      ctx.y += 14 * Math.max(1, passportLines.length);
    }
    doc.text(`Visa grant date: ${fmtEN(profile.visaGrantDate)}`, ctx.marginX, ctx.y);
    ctx.y += 14;
    doc.text(`First entry to the UK: ${fmtEN(profile.firstArrivalDate)}`, ctx.marginX, ctx.y);
    ctx.y += 14;
    doc.text(`Report generated: ${fmtEN(D.today())}`, ctx.marginX, ctx.y);
    ctx.y += 24;
  }

  function drawTable(doc, ctx, rows) {
    const colX = {
      departure: ctx.marginX,
      ret: ctx.marginX + 78,
      days: ctx.marginX + 156,
      outbound: ctx.marginX + 228,
      inbound: ctx.marginX + 312,
      note: ctx.marginX + 396,
    };
    const colW = { note: ctx.pageWidth - ctx.marginX - colX.note };

    function drawHeader() {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('Departure', colX.departure, ctx.y);
      doc.text('Return', colX.ret, ctx.y);
      doc.text('Days absent', colX.days, ctx.y);
      doc.text('Outbound flt', colX.outbound, ctx.y);
      doc.text('Inbound flt', colX.inbound, ctx.y);
      doc.text('Notes', colX.note, ctx.y);
      ctx.y += 6;
      doc.setLineWidth(0.5);
      doc.line(ctx.marginX, ctx.y, ctx.pageWidth - ctx.marginX, ctx.y);
      ctx.y += 14;
      doc.setFont('helvetica', 'normal');
    }

    drawHeader();
    if (rows.length === 0) {
      doc.text('No travel records.', colX.departure, ctx.y);
      ctx.y += 16;
    }
    rows.forEach((r) => {
      ctx.ensureSpace(16);
      const noteLines = doc.splitTextToSize(r.note || '-', colW.note);
      doc.text(fmtEN(r.departure), colX.departure, ctx.y);
      doc.text(fmtEN(r.ret), colX.ret, ctx.y);
      doc.text(String(r.days), colX.days, ctx.y);
      doc.text(r.outbound || '-', colX.outbound, ctx.y);
      doc.text(r.inbound || '-', colX.inbound, ctx.y);
      doc.text(noteLines, colX.note, ctx.y);
      const linesUsed = Math.max(1, noteLines.length);
      ctx.y += 14 * linesUsed;
    });

    ctx.ensureSpace(10);
    doc.setLineWidth(0.5);
    doc.line(ctx.marginX, ctx.y, ctx.pageWidth - ctx.marginX, ctx.y);
    ctx.y += 20;
  }

  function drawDisclaimer(doc, ctx, extraNote) {
    ctx.ensureSpace(40);
    doc.setFontSize(8);
    doc.setTextColor(110);
    const disclaimer =
      'Absence calculations follow the "whole day" rule (day of departure and day of return are not counted, ' +
      'per Home Office guidance "Indefinite leave to remain: calculating continuous period in UK"). ' +
      (extraNote ? extraNote : '');
    const disclaimerLines = doc.splitTextToSize(disclaimer, ctx.pageWidth - ctx.marginX * 2);
    doc.text(disclaimerLines, ctx.marginX, ctx.y);
    doc.setTextColor(0);
  }

  function makeContext(doc) {
    const ctx = {
      pageWidth: doc.internal.pageSize.getWidth(),
      pageHeight: doc.internal.pageSize.getHeight(),
      marginX: 40,
      y: 50,
    };
    ctx.ensureSpace = (lineHeight) => {
      if (ctx.y + lineHeight > ctx.pageHeight - 50) {
        doc.addPage();
        ctx.y = 50;
        return true;
      }
      return false;
    };
    return ctx;
  }

  /**
   * ILR(永久居留)申請用報告 —— 只顯示出入境紀錄同「任何連續12個月」180日滾動檢查。
   */
  function generateIlrReport({ profile, trips, settings }) {
    const doc = newDoc();
    const ctx = makeContext(doc);

    drawHeaderBlock(doc, ctx, 'UK Travel / Absence Record - Settlement (ILR) Application', profile);
    drawTable(doc, ctx, buildRows(profile, trips));

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Compliance summary - Settlement (ILR)', ctx.marginX, ctx.y);
    ctx.y += 18;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);

    if (profile.visaGrantDate) {
      const ilr = Calc.ilrComplianceReport(profile, trips, settings);
      ctx.ensureSpace(30);
      doc.text(
        `Highest absence in any rolling 12-month period during the qualifying period: ${ilr.worst.days} day(s) ` +
          `(limit ${ilr.limit}) between ${fmtEN(ilr.worst.windowStart)} and ${fmtEN(ilr.worst.windowEnd)} - ` +
          `${ilr.passed ? 'WITHIN LIMIT' : 'EXCEEDS LIMIT'}`,
        ctx.marginX,
        ctx.y,
        { maxWidth: ctx.pageWidth - ctx.marginX * 2 }
      );
      ctx.y += 30;
    } else {
      doc.text('Visa grant date not set - compliance summary unavailable.', ctx.marginX, ctx.y);
      ctx.y += 20;
    }

    drawDisclaimer(
      doc,
      ctx,
      'This summary covers the Settlement (ILR) "no more than 180 days absent in any rolling 12-month period" rule only, and does not cover naturalisation absence rules.'
    );
    return doc;
  }

  /**
   * BC(入籍/Naturalisation)申請用報告 —— 只顯示出入境紀錄同入籍專用嘅
   * 「過去N年」(3或5年,視乎是否配偶為英國公民)同「過去12個月」缺勤檢查。
   * applicationDate 應該同「里程碑」分頁入面嘅「假設申請日」一致(由呼叫方傳入),
   * 確保 app 畫面同呢份 PDF 顯示嘅數字唔會兜唔埋。
   */
  function generateNaturalisationReport({ profile, trips, settings, applicationDate }) {
    const doc = newDoc();
    const ctx = makeContext(doc);

    drawHeaderBlock(doc, ctx, 'UK Travel / Absence Record - Naturalisation (British Citizenship) Application', profile);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Assumed / actual application date used for this report: ${fmtEN(applicationDate)}`, ctx.marginX, ctx.y);
    ctx.y += 20;

    drawTable(doc, ctx, buildRows(profile, trips));

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Compliance summary - Naturalisation', ctx.marginX, ctx.y);
    ctx.y += 18;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);

    if (profile.visaGrantDate && applicationDate) {
      const nat = Calc.naturalisationComplianceReport(profile, trips, settings, applicationDate);
      const routeLabel = profile.marriedToBritishCitizen
        ? 'Section 6(2) spouse/civil partner route'
        : 'Section 6(1) general route';
      ctx.ensureSpace(16);
      doc.text(`Route: ${routeLabel}`, ctx.marginX, ctx.y);
      ctx.y += 16;

      ctx.ensureSpace(30);
      doc.text(
        `Absence in the ${nat.qualifyingYears}-year qualifying period ending ${fmtEN(applicationDate)}: ` +
          `${nat.totalPeriod.days} day(s) (limit ${nat.totalPeriod.limit}) - ` +
          `${nat.totalPeriod.passed ? 'WITHIN LIMIT' : 'EXCEEDS LIMIT'}`,
        ctx.marginX,
        ctx.y,
        { maxWidth: ctx.pageWidth - ctx.marginX * 2 }
      );
      ctx.y += 30;

      ctx.ensureSpace(30);
      doc.text(
        `Absence in the 12 months ending ${fmtEN(applicationDate)}: ${nat.twelveMonth.days} day(s) ` +
          `(limit ${nat.twelveMonth.limit}) - ${nat.twelveMonth.passed ? 'WITHIN LIMIT' : 'EXCEEDS LIMIT'}`,
        ctx.marginX,
        ctx.y,
        { maxWidth: ctx.pageWidth - ctx.marginX * 2 }
      );
      ctx.y += 26;
    } else {
      doc.text('Visa grant date or application date not set - compliance summary unavailable.', ctx.marginX, ctx.y);
      ctx.y += 20;
    }

    drawDisclaimer(
      doc,
      ctx,
      'This summary covers the naturalisation absence rules only (based on the chosen application date above), and does not cover the separate Settlement (ILR) "180 days in any rolling 12-month period" rule.'
    );
    return doc;
  }

  global.PdfReport = {
    generateIlrReport,
    generateNaturalisationReport,
    buildRows,
  };
})(typeof window !== 'undefined' ? window : globalThis);
