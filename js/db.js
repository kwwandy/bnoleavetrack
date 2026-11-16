/*
 * db.js — IndexedDB 資料層:Profile / AbsenceEntry(Trip) / Settings 嘅 CRUD,
 * 支援多個 profile,同埋匯出/匯入 JSON 備份。
 * 全部 API 都係 Promise-based。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'bno-day-tracker';
  const DB_VERSION = 1;
  const STORE_PROFILES = 'profiles';
  const STORE_TRIPS = 'trips';
  const STORE_SETTINGS = 'settings';

  let dbPromise = null;

  function genId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error('呢個瀏覽器唔支援 IndexedDB,無法儲存資料'));
        return;
      }
      const req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PROFILES)) {
          db.createObjectStore(STORE_PROFILES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_TRIPS)) {
          const tripStore = db.createObjectStore(STORE_TRIPS, { keyPath: 'id' });
          tripStore.createIndex('profileId', 'profileId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'profileId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeNames, mode) {
    return openDB().then((db) => db.transaction(storeNames, mode));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------- Profiles ----------

  function listProfiles() {
    return tx([STORE_PROFILES], 'readonly').then((t) =>
      reqToPromise(t.objectStore(STORE_PROFILES).getAll())
    );
  }

  function getProfile(id) {
    return tx([STORE_PROFILES], 'readonly').then((t) =>
      reqToPromise(t.objectStore(STORE_PROFILES).get(id))
    );
  }

  function createProfile(data) {
    const profile = Object.assign(
      {
        id: genId(),
        name: '',
        visaGrantDate: null,
        firstArrivalDate: null,
        marriedToBritishCitizen: false,
        ilrGrantDate: null,
        // 「假設/實際 BC 申請日」—— 里程碑分頁同 PDF 報告(BC版)共用同一個數值,
        // 確保兩邊顯示嘅入籍缺勤計算一致,唔會出現兩個唔同嘅「過去N年缺勤」數字。
        bcAssumedApplicationDate: null,
        uktaxResidentFromTaxYear: null,
        englishTestDate: null,
        lifeInUkTestDate: null,
        createdAt: new Date().toISOString(),
      },
      data
    );
    return tx([STORE_PROFILES, STORE_SETTINGS], 'readwrite').then((t) => {
      t.objectStore(STORE_PROFILES).add(profile);
      t.objectStore(STORE_SETTINGS).add(
        Object.assign({ profileId: profile.id }, global.Calc.DEFAULT_SETTINGS)
      );
      return new Promise((resolve, reject) => {
        t.oncomplete = () => resolve(profile);
        t.onerror = () => reject(t.error);
      });
    });
  }

  function updateProfile(id, patch) {
    return tx([STORE_PROFILES], 'readwrite').then((t) => {
      const store = t.objectStore(STORE_PROFILES);
      return reqToPromise(store.get(id)).then((existing) => {
        if (!existing) throw new Error('搵唔到呢個檔案');
        const updated = Object.assign({}, existing, patch);
        store.put(updated);
        return new Promise((resolve, reject) => {
          t.oncomplete = () => resolve(updated);
          t.onerror = () => reject(t.error);
        });
      });
    });
  }

  function deleteProfile(id) {
    return tx([STORE_PROFILES, STORE_TRIPS, STORE_SETTINGS], 'readwrite').then((t) => {
      t.objectStore(STORE_PROFILES).delete(id);
      t.objectStore(STORE_SETTINGS).delete(id);
      const tripStore = t.objectStore(STORE_TRIPS);
      const idx = tripStore.index('profileId');
      const cursorReq = idx.openCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      return new Promise((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    });
  }

  // ---------- Trips (AbsenceEntry) ----------

  function listTrips(profileId) {
    return tx([STORE_TRIPS], 'readonly').then((t) => {
      const idx = t.objectStore(STORE_TRIPS).index('profileId');
      return reqToPromise(idx.getAll(IDBKeyRange.only(profileId)));
    });
  }

  function addTrip(profileId, data) {
    if (!data || !data.departureDate || !data.returnDate) {
      return Promise.reject(new Error('離境日同返英日都係必填'));
    }
    const trip = Object.assign(
      {
        id: genId(),
        profileId,
        departureDate: null,
        returnDate: null,
        isEstimated: false,
        reason: '',
        outboundFlightNo: '',
        inboundFlightNo: '',
      },
      data,
      { profileId }
    );
    return tx([STORE_TRIPS], 'readwrite').then((t) => {
      t.objectStore(STORE_TRIPS).add(trip);
      return new Promise((resolve, reject) => {
        t.oncomplete = () => resolve(trip);
        t.onerror = () => reject(t.error);
      });
    });
  }

  function updateTrip(id, patch) {
    return tx([STORE_TRIPS], 'readwrite').then((t) => {
      const store = t.objectStore(STORE_TRIPS);
      return reqToPromise(store.get(id)).then((existing) => {
        if (!existing) throw new Error('搵唔到呢筆紀錄');
        const updated = Object.assign({}, existing, patch);
        if (!updated.departureDate || !updated.returnDate) {
          throw new Error('離境日同返英日都係必填');
        }
        store.put(updated);
        return new Promise((resolve, reject) => {
          t.oncomplete = () => resolve(updated);
          t.onerror = () => reject(t.error);
        });
      });
    });
  }

  function deleteTrip(id) {
    return tx([STORE_TRIPS], 'readwrite').then((t) => {
      t.objectStore(STORE_TRIPS).delete(id);
      return new Promise((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    });
  }

  // ---------- Settings ----------

  function getSettings(profileId) {
    return tx([STORE_SETTINGS], 'readonly')
      .then((t) => reqToPromise(t.objectStore(STORE_SETTINGS).get(profileId)))
      .then((s) => Object.assign({}, global.Calc.DEFAULT_SETTINGS, s || {}, { profileId }));
  }

  function saveSettings(profileId, patch) {
    return getSettings(profileId).then((current) => {
      const updated = Object.assign({}, current, patch, { profileId });
      return tx([STORE_SETTINGS], 'readwrite').then((t) => {
        t.objectStore(STORE_SETTINGS).put(updated);
        return new Promise((resolve, reject) => {
          t.oncomplete = () => resolve(updated);
          t.onerror = () => reject(t.error);
        });
      });
    });
  }

  // ---------- 匯出 / 匯入 ----------

  function exportAll() {
    return Promise.all([listProfiles(), tx([STORE_TRIPS], 'readonly').then((t) => reqToPromise(t.objectStore(STORE_TRIPS).getAll())), tx([STORE_SETTINGS], 'readonly').then((t) => reqToPromise(t.objectStore(STORE_SETTINGS).getAll()))]).then(
      ([profiles, trips, settings]) => ({
        exportedAt: new Date().toISOString(),
        appVersion: '0.1.0',
        profiles,
        trips,
        settings,
      })
    );
  }

  function exportProfile(profileId) {
    return Promise.all([getProfile(profileId), listTrips(profileId), getSettings(profileId)]).then(
      ([profile, trips, settings]) => ({
        exportedAt: new Date().toISOString(),
        appVersion: '0.1.0',
        profiles: [profile],
        trips,
        settings: [settings],
      })
    );
  }

  /**
   * 匯入備份 JSON。為避免同現有資料撞 id,匯入時一律重新生成 id,
   * 並且將 trips/settings 入面嘅 profileId 對應返新嘅 id。
   */
  function importData(data) {
    if (!data || !Array.isArray(data.profiles)) {
      return Promise.reject(new Error('備份檔格式不正確'));
    }
    const idMap = {};
    const newProfiles = data.profiles.map((p) => {
      const newId = genId();
      idMap[p.id] = newId;
      return Object.assign({}, p, { id: newId, name: (p.name || '未命名') + '(匯入)' });
    });
    const newTrips = (data.trips || [])
      .filter((t) => idMap[t.profileId])
      .map((t) => Object.assign({}, t, { id: genId(), profileId: idMap[t.profileId] }));
    const newSettings = (data.settings || [])
      .filter((s) => idMap[s.profileId])
      .map((s) => Object.assign({}, s, { profileId: idMap[s.profileId] }));

    return tx([STORE_PROFILES, STORE_TRIPS, STORE_SETTINGS], 'readwrite').then((t) => {
      newProfiles.forEach((p) => t.objectStore(STORE_PROFILES).add(p));
      newTrips.forEach((tr) => t.objectStore(STORE_TRIPS).add(tr));
      newSettings.forEach((s) => t.objectStore(STORE_SETTINGS).add(s));
      // 保證每個匯入嘅 profile 都有一份 settings(舊備份可能冇)
      newProfiles.forEach((p) => {
        if (!newSettings.find((s) => s.profileId === p.id)) {
          t.objectStore(STORE_SETTINGS).add(
            Object.assign({ profileId: p.id }, global.Calc.DEFAULT_SETTINGS)
          );
        }
      });
      return new Promise((resolve, reject) => {
        t.oncomplete = () => resolve({ importedProfiles: newProfiles.length });
        t.onerror = () => reject(t.error);
      });
    });
  }

  /**
   * 一次過清空「全部」profiles/trips/settings —— 用嚟俾用戶喺公用電腦/
   * 交還借用電腦之前一鍵清走呢個瀏覽器入面所有本機儲存嘅資料,保障私隱。
   * 呢個動作唔可以還原,UI層應該要有強confirm先至叫呢個function。
   */
  function wipeAllData() {
    return tx([STORE_PROFILES, STORE_TRIPS, STORE_SETTINGS], 'readwrite').then((t) => {
      t.objectStore(STORE_PROFILES).clear();
      t.objectStore(STORE_TRIPS).clear();
      t.objectStore(STORE_SETTINGS).clear();
      return new Promise((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    });
  }

  global.BnoDB = {
    listProfiles,
    getProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    listTrips,
    addTrip,
    updateTrip,
    deleteTrip,
    getSettings,
    saveSettings,
    exportAll,
    exportProfile,
    importData,
    wipeAllData,
    genId,
  };
})(typeof window !== 'undefined' ? window : globalThis);
