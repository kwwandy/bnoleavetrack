/*
 * theme.js — 色系(淺色/深色之外加多幾款柔和色)管理。
 * 分兩部分:
 *   1. ThemeCore:純邏輯(邊幾款色系/模式係合法、「跟裝置」點解析做實際淺/深色),
 *      冇DOM依賴,方便喺 Node 用 tests/run.js 直接 unit test。
 *   2. 瀏覽器限定嘅DOM邏輯(讀寫 localStorage、set attribute、監聽OS淺深色轉變),
 *      掛喺 global.ThemeManager,俾 app.js 嘅「參數設定」分頁UI用。
 *
 * 呢個script特登擺喺 index.html 嘅 <head> 最頭(喺stylesheet之前都得,因為
 * 淨係set attribute,唔靠CSS),等個attribute喺瀏覽器開始畫面之前就set好,
 * 避免一打開app閃一閃「舊色系」先跳去「用戶揀開嗰個色系」。
 */
(function (global) {
  'use strict';

  const THEMES = ['soft-blue', 'sage-green', 'warm-sand'];
  const DEFAULT_THEME = 'soft-blue';
  const MODES = ['auto', 'light', 'dark'];
  const DEFAULT_MODE = 'auto';
  const STORAGE_THEME_KEY = 'bno-theme';
  const STORAGE_MODE_KEY = 'bno-color-mode';

  function isValidTheme(t) {
    return THEMES.indexOf(t) !== -1;
  }

  function isValidMode(m) {
    return MODES.indexOf(m) !== -1;
  }

  /**
   * 將用戶嘅模式選擇(auto/light/dark)解析做實際要用嘅淺/深色。
   * auto 嗰陣先會睇 prefersDark(由瀏覽器 matchMedia 查返嚟嘅布林值)。
   */
  function resolveMode(modePref, prefersDark) {
    if (modePref === 'light' || modePref === 'dark') return modePref;
    return prefersDark ? 'dark' : 'light';
  }

  const ThemeCore = {
    THEMES,
    DEFAULT_THEME,
    MODES,
    DEFAULT_MODE,
    STORAGE_THEME_KEY,
    STORAGE_MODE_KEY,
    isValidTheme,
    isValidMode,
    resolveMode,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThemeCore;
    return;
  }

  global.ThemeCore = ThemeCore;

  function getStoredTheme() {
    try {
      const t = global.localStorage.getItem(STORAGE_THEME_KEY);
      return isValidTheme(t) ? t : DEFAULT_THEME;
    } catch (e) {
      return DEFAULT_THEME;
    }
  }

  function getStoredMode() {
    try {
      const m = global.localStorage.getItem(STORAGE_MODE_KEY);
      return isValidMode(m) ? m : DEFAULT_MODE;
    } catch (e) {
      return DEFAULT_MODE;
    }
  }

  function prefersDark() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return false;
    }
  }

  function apply() {
    const theme = getStoredTheme();
    const resolvedMode = resolveMode(getStoredMode(), prefersDark());
    const root = global.document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-mode', resolvedMode);
  }

  function setTheme(theme) {
    if (!isValidTheme(theme)) return;
    try {
      global.localStorage.setItem(STORAGE_THEME_KEY, theme);
    } catch (e) {
      /* 私隱模式/儲存被鎖,唔緊要,淨係今次唔記得落localStorage */
    }
    apply();
  }

  function setMode(mode) {
    if (!isValidMode(mode)) return;
    try {
      global.localStorage.setItem(STORAGE_MODE_KEY, mode);
    } catch (e) {
      /* 同上 */
    }
    apply();
  }

  apply();

  try {
    const mq = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', () => {
        if (getStoredMode() === 'auto') apply();
      });
    }
  } catch (e) {
    /* 舊瀏覽器冇呢個API就算,頂多係跟裝置轉淺深色嗰刻唔會即時反應,
       重新開返個app仍然會攞返啱嘅色。 */
  }

  global.ThemeManager = {
    apply,
    setTheme,
    setMode,
    getTheme: getStoredTheme,
    getMode: getStoredMode,
  };
})(typeof window !== 'undefined' ? window : globalThis);
