(function () {
  "use strict";

  const APP_NAME = "家系図ノート";
  const APP_VERSION = "1.0.0-prototype.4-fix.4-spine.2";
  const SCHEMA_VERSION = 4;
  const DB_NAME = "family-tree-note";
  const DB_VERSION = 4;
  const STORE_PERSONS = "persons";
  const STORE_RELATIONSHIPS = "relationships";
  const STORE_SETTINGS = "settings";
  const STORE_DUPLICATE_EXCLUSIONS = "duplicateExclusions";
  const STORE_TREES = "trees";
  const STORE_EVENTS = "events";
  const STORE_SOURCES = "sources";
  const STORE_CITATIONS = "citations";
  const STORE_ATTACHMENTS = "attachments";
  const STORE_SNAPSHOTS = "snapshots";
  const SETTINGS_KEY = "app";
  const DEFAULT_TREE_ID = "tree-default";
  const PARENT_TYPES = new Set(["biological", "adoptive", "step"]);
  const PARTNER_TYPES = new Set(["marriage", "partnership"]);
  const PARTNER_STATUSES = new Set(["current", "divorced", "separated", "ended", "unknown"]);
  const ALLOWED_GENDERS = new Set(["", "female", "male", "nonbinary", "other", "undisclosed"]);
  const DATE_PRECISIONS = new Set(["day", "month", "year", "unknown"]);
  const TREE_VIEW_MODES = new Set(["all", "direct", "ancestors", "descendants", "lineage", "blood", "kinship"]);
  const PRIVACY_MODES = new Set(["all", "hide-dates", "hide-photo-dates", "initials"]);
  const PAPER_SIZES = new Set(["auto", "a4-portrait", "a4-landscape", "a3-portrait", "a3-landscape"]);
  let databasePromise = null;

  function makeId(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return prefix + "-" + globalThis.crypto.randomUUID();
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() { return new Date().toISOString(); }

  function requestAsPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("データベース操作に失敗しました。")); };
    });
  }

  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onabort = function () { reject(transaction.error || new Error("保存処理が中断されました。")); };
      transaction.onerror = function () { reject(transaction.error || new Error("保存処理に失敗しました。")); };
    });
  }

  function cleanString(value, maxLength) {
    if (value === null || value === undefined) return "";
    return String(value).trim().slice(0, maxLength || 5000);
  }

  function valueOr(input, key, fallback) {
    return input && Object.prototype.hasOwnProperty.call(input, key) ? input[key] : fallback;
  }

  function inferDatePrecision(value) {
    const text = cleanString(value, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return "day";
    if (/^\d{4}-\d{2}$/.test(text)) return "month";
    if (/^\d{4}$/.test(text)) return "year";
    return "unknown";
  }

  function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

  function normalizePartialDate(value, precision) {
    const text = cleanString(value, 10);
    if (precision === "unknown" || !text) return "";
    const match = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(text);
    if (!match) throw new Error("年月日の形式が正しくありません。");
    const year = Number(match[1]);
    const month = Number(match[2] || 0);
    const day = Number(match[3] || 0);
    if (year < 1 || year > 9999) throw new Error("年は1から9999の範囲で入力してください。");
    if (precision === "year") return String(year).padStart(4, "0");
    if (month < 1 || month > 12) throw new Error("月を正しく入力してください。");
    const yearMonth = String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0");
    if (precision === "month") return yearMonth;
    if (precision !== "day" || day < 1 || day > daysInMonth(year, month)) throw new Error("日を正しく入力してください。");
    return yearMonth + "-" + String(day).padStart(2, "0");
  }

  function dateBounds(value, precision) {
    if (!value || precision === "unknown") return null;
    const parts = value.split("-").map(Number);
    const year = parts[0];
    const month = precision === "year" ? 1 : parts[1];
    const endMonth = precision === "year" ? 12 : parts[1];
    const startDay = precision === "day" ? parts[2] : 1;
    const endDay = precision === "day" ? parts[2] : daysInMonth(year, endMonth);
    return {
      start: String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(startDay).padStart(2, "0"),
      end: String(year).padStart(4, "0") + "-" + String(endMonth).padStart(2, "0") + "-" + String(endDay).padStart(2, "0")
    };
  }

  function normalizeSortOrder(value, fallback) {
    if (value === null) return null;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.round(number);
    if (fallback === null) return null;
    const fallbackNumber = Number(fallback);
    return Number.isFinite(fallbackNumber) && fallbackNumber >= 0 ? Math.round(fallbackNumber) : null;
  }

  function defaultPrintSettings() {
    return {
      paperSize: "auto",
      title: "家系図ノート",
      note: "",
      showDate: true,
      showGenerationLabels: false,
      privacyMode: "hide-dates",
      scope: "current"
    };
  }

  function defaultSettings() {
    return {
      focusPersonId: "",
      orientation: "vertical",
      scale: 1,
      schemaVersion: SCHEMA_VERSION,
      sampleInitialized: false,
      treeViewMode: "all",
      kinshipDepth: "unlimited",
      includePartners: true,
      showGenerationLabels: false,
      outputPrivacyMode: "hide-dates",
      printSettings: defaultPrintSettings()
    };
  }

  function normalizePrintSettings(value) {
    const defaults = defaultPrintSettings();
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const privacyMode = PRIVACY_MODES.has(source.privacyMode) ? source.privacyMode : defaults.privacyMode;
    return {
      paperSize: PAPER_SIZES.has(source.paperSize) ? source.paperSize : defaults.paperSize,
      title: cleanString(source.title === undefined ? defaults.title : source.title, 120),
      note: cleanString(source.note, 500),
      showDate: source.showDate === undefined ? defaults.showDate : Boolean(source.showDate),
      showGenerationLabels: Boolean(source.showGenerationLabels),
      privacyMode: privacyMode,
      scope: source.scope === "all" ? "all" : "current"
    };
  }

  function normalizeSettings(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const settings = Object.assign(defaultSettings(), source);
    settings.schemaVersion = SCHEMA_VERSION;
    settings.orientation = "vertical";
    const parsedScale = Number(settings.scale);
    settings.scale = Number.isFinite(parsedScale) ? Math.max(0.25, Math.min(2.5, parsedScale)) : 1;
    settings.treeViewMode = TREE_VIEW_MODES.has(settings.treeViewMode) ? settings.treeViewMode : "all";
    settings.kinshipDepth = settings.kinshipDepth === "unlimited" || /^[1-5]$/.test(String(settings.kinshipDepth)) ? String(settings.kinshipDepth) : "unlimited";
    settings.includePartners = settings.includePartners === undefined ? true : Boolean(settings.includePartners);
    settings.showGenerationLabels = Boolean(settings.showGenerationLabels);
    settings.outputPrivacyMode = PRIVACY_MODES.has(settings.outputPrivacyMode) ? settings.outputPrivacyMode : "hide-dates";
    settings.printSettings = normalizePrintSettings(settings.printSettings);
    return settings;
  }

  function migrateToVersion2(transaction) {
    if (transaction.objectStoreNames.contains(STORE_RELATIONSHIPS)) {
      transaction.objectStore(STORE_RELATIONSHIPS).openCursor().onsuccess = function (event) {
        const cursor = event.target.result;
        if (!cursor) return;
        const value = cursor.value;
        let changed = false;
        if (!("status" in value)) { value.status = value.type === "partner" ? "current" : ""; changed = true; }
        if (!("sortOrder" in value)) { value.sortOrder = null; changed = true; }
        if (changed) cursor.update(value);
        cursor.continue();
      };
    }
  }

  function migrateToVersion3(transaction) {
    if (transaction.objectStoreNames.contains(STORE_PERSONS)) {
      transaction.objectStore(STORE_PERSONS).openCursor().onsuccess = function (event) {
        const cursor = event.target.result;
        if (!cursor) return;
        const person = cursor.value;
        let changed = false;
        const additions = {
          birthDatePrecision: inferDatePrecision(person.birthDate),
          deathDatePrecision: inferDatePrecision(person.deathDate),
          birthDateApproximate: false,
          deathDateApproximate: false,
          nickname: "",
          otherNames: "",
          honorific: "",
          nameMemo: ""
        };
        Object.keys(additions).forEach(function (key) {
          if (!(key in person)) { person[key] = additions[key]; changed = true; }
        });
        if (changed) cursor.update(person);
        cursor.continue();
      };
    }
    if (transaction.objectStoreNames.contains(STORE_SETTINGS)) {
      const store = transaction.objectStore(STORE_SETTINGS);
      const request = store.get(SETTINGS_KEY);
      request.onsuccess = function () {
        if (request.result) store.put(normalizeSettings(request.result), SETTINGS_KEY);
      };
    }
  }

  function migrateToVersion4(transaction) {
    const timestamp = nowIso();
    const treeStore = transaction.objectStore(STORE_TREES);
    const settingsStore = transaction.objectStore(STORE_SETTINGS);
    const settingsRequest = settingsStore.get(SETTINGS_KEY);
    settingsRequest.onsuccess = function () {
      const oldSettings = normalizeSettings(settingsRequest.result);
      const nextSettings = Object.assign({}, oldSettings, {
        activeTreeId: DEFAULT_TREE_ID,
        migrationV4Complete: true,
        schemaVersion: 4
      });
      treeStore.put({
        id: DEFAULT_TREE_ID,
        name: "家族の家系図",
        description: "",
        rootPersonId: oldSettings.focusPersonId || "",
        coverColor: "#557c64",
        createdAt: timestamp,
        updatedAt: timestamp,
        isArchived: false
      });
      settingsStore.put(nextSettings, SETTINGS_KEY);
      settingsStore.put(Object.assign({}, oldSettings, { treeId: DEFAULT_TREE_ID, schemaVersion: 4 }), "tree:" + DEFAULT_TREE_ID);
    };
    function addTreeFields(storeName, extra) {
      if (!transaction.objectStoreNames.contains(storeName)) return;
      transaction.objectStore(storeName).openCursor().onsuccess = function (event) {
        const cursor = event.target.result;
        if (!cursor) return;
        const value = cursor.value;
        let changed = false;
        if (!value.treeId) { value.treeId = DEFAULT_TREE_ID; changed = true; }
        Object.keys(extra || {}).forEach(function (key) {
          if (!(key in value)) { value[key] = extra[key]; changed = true; }
        });
        if (changed) cursor.update(value);
        cursor.continue();
      };
    }
    addTreeFields(STORE_PERSONS, { verificationStatus: "unconfirmed" });
    addTreeFields(STORE_RELATIONSHIPS, { verificationStatus: "unconfirmed" });
    addTreeFields(STORE_DUPLICATE_EXCLUSIONS, {});
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise(function (resolve, reject) {
      if (!("indexedDB" in globalThis)) { reject(new Error("このブラウザでは端末内保存を利用できません。")); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function (event) {
        const db = event.target.result;
        const transaction = event.target.transaction;
        if (!db.objectStoreNames.contains(STORE_PERSONS)) {
          const persons = db.createObjectStore(STORE_PERSONS, { keyPath: "id" });
          persons.createIndex("familyName", "familyName", { unique: false });
          persons.createIndex("givenName", "givenName", { unique: false });
          persons.createIndex("updatedAt", "updatedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_RELATIONSHIPS)) {
          const relationships = db.createObjectStore(STORE_RELATIONSHIPS, { keyPath: "id" });
          relationships.createIndex("type", "type", { unique: false });
          relationships.createIndex("fromPersonId", "fromPersonId", { unique: false });
          relationships.createIndex("toPersonId", "toPersonId", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) db.createObjectStore(STORE_SETTINGS);
        if (!db.objectStoreNames.contains(STORE_DUPLICATE_EXCLUSIONS)) db.createObjectStore(STORE_DUPLICATE_EXCLUSIONS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_TREES)) db.createObjectStore(STORE_TREES, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_EVENTS)) db.createObjectStore(STORE_EVENTS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_SOURCES)) db.createObjectStore(STORE_SOURCES, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_CITATIONS)) db.createObjectStore(STORE_CITATIONS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) db.createObjectStore(STORE_ATTACHMENTS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) db.createObjectStore(STORE_SNAPSHOTS, { keyPath: "id" });
        function ensureIndex(storeName, indexName, keyPath) {
          const store = transaction.objectStore(storeName);
          if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath, { unique: false });
        }
        ensureIndex(STORE_PERSONS, "treeId", "treeId");
        ensureIndex(STORE_RELATIONSHIPS, "treeId", "treeId");
        ensureIndex(STORE_DUPLICATE_EXCLUSIONS, "treeId", "treeId");
        ensureIndex(STORE_EVENTS, "treeId", "treeId");
        ensureIndex(STORE_SOURCES, "treeId", "treeId");
        ensureIndex(STORE_CITATIONS, "treeId", "treeId");
        ensureIndex(STORE_CITATIONS, "sourceId", "sourceId");
        ensureIndex(STORE_CITATIONS, "targetKey", "targetKey");
        ensureIndex(STORE_ATTACHMENTS, "treeId", "treeId");
        ensureIndex(STORE_ATTACHMENTS, "sourceId", "sourceId");
        ensureIndex(STORE_SNAPSHOTS, "treeId", "treeId");
        if (event.oldVersion > 0 && event.oldVersion < 2) migrateToVersion2(transaction);
        if (event.oldVersion > 0 && event.oldVersion < 3) migrateToVersion3(transaction);
        if (event.oldVersion > 0 && event.oldVersion < 4) migrateToVersion4(transaction);
      };
      request.onsuccess = function () {
        const db = request.result;
        db.onversionchange = function () { db.close(); databasePromise = null; };
        resolve(db);
      };
      request.onerror = function () { databasePromise = null; reject(request.error || new Error("データベースを開けませんでした。")); };
      request.onblocked = function () { databasePromise = null; reject(new Error("別の画面で古い家系図ノートが開かれています。ほかの画面を閉じて再読み込みしてください。")); };
    });
    return databasePromise;
  }

  function normalizePerson(input, existing) {
    const source = input || {};
    const current = existing || {};
    const timestamp = nowIso();
    const birthRaw = valueOr(source, "birthDate", current.birthDate || "");
    const deathRaw = valueOr(source, "deathDate", current.deathDate || "");
    const birthPrecision = DATE_PRECISIONS.has(valueOr(source, "birthDatePrecision", current.birthDatePrecision))
      ? valueOr(source, "birthDatePrecision", current.birthDatePrecision) : inferDatePrecision(birthRaw);
    const deathPrecision = DATE_PRECISIONS.has(valueOr(source, "deathDatePrecision", current.deathDatePrecision))
      ? valueOr(source, "deathDatePrecision", current.deathDatePrecision) : inferDatePrecision(deathRaw);
    const person = {
      id: cleanString(source.id || current.id || makeId("person"), 150),
      familyName: cleanString(valueOr(source, "familyName", current.familyName), 60),
      givenName: cleanString(valueOr(source, "givenName", current.givenName), 60),
      formerFamilyName: cleanString(valueOr(source, "formerFamilyName", current.formerFamilyName), 60),
      familyNameKana: cleanString(valueOr(source, "familyNameKana", current.familyNameKana), 80),
      givenNameKana: cleanString(valueOr(source, "givenNameKana", current.givenNameKana), 80),
      nickname: cleanString(valueOr(source, "nickname", current.nickname), 80),
      otherNames: cleanString(valueOr(source, "otherNames", current.otherNames), 300),
      honorific: cleanString(valueOr(source, "honorific", current.honorific), 40),
      nameMemo: cleanString(valueOr(source, "nameMemo", current.nameMemo), 500),
      gender: ALLOWED_GENDERS.has(valueOr(source, "gender", current.gender)) ? valueOr(source, "gender", current.gender) : "",
      birthDate: normalizePartialDate(birthRaw, birthPrecision),
      birthDatePrecision: birthPrecision,
      birthDateApproximate: birthPrecision !== "unknown" && Boolean(valueOr(source, "birthDateApproximate", current.birthDateApproximate)),
      deathDate: normalizePartialDate(deathRaw, deathPrecision),
      deathDatePrecision: deathPrecision,
      deathDateApproximate: deathPrecision !== "unknown" && Boolean(valueOr(source, "deathDateApproximate", current.deathDateApproximate)),
      isDeceased: Boolean(valueOr(source, "isDeceased", current.isDeceased)),
      birthplace: cleanString(valueOr(source, "birthplace", current.birthplace), 120),
      photo: typeof valueOr(source, "photo", current.photo) === "string" ? valueOr(source, "photo", current.photo) : "",
      memo: cleanString(valueOr(source, "memo", current.memo), 3000),
      createdAt: current.createdAt || cleanString(source.createdAt, 40) || timestamp,
      updatedAt: timestamp
    };
    if (!person.givenName) throw new Error("名を入力してください。");
    const birthBounds = dateBounds(person.birthDate, person.birthDatePrecision);
    const deathBounds = dateBounds(person.deathDate, person.deathDatePrecision);
    if (birthBounds && deathBounds && deathBounds.end < birthBounds.start) throw new Error("没年月日は生年月日以降にしてください。");
    return person;
  }

  function hydratePerson(value) {
    const person = Object.assign({}, value || {});
    person.birthDatePrecision = DATE_PRECISIONS.has(person.birthDatePrecision) ? person.birthDatePrecision : inferDatePrecision(person.birthDate);
    person.deathDatePrecision = DATE_PRECISIONS.has(person.deathDatePrecision) ? person.deathDatePrecision : inferDatePrecision(person.deathDate);
    person.birthDateApproximate = person.birthDatePrecision !== "unknown" && Boolean(person.birthDateApproximate);
    person.deathDateApproximate = person.deathDatePrecision !== "unknown" && Boolean(person.deathDateApproximate);
    ["nickname", "otherNames", "honorific", "nameMemo"].forEach(function (key) { person[key] = cleanString(person[key], key === "nameMemo" ? 500 : 300); });
    return person;
  }

  function normalizeRelationship(input, existing) {
    const source = input || {};
    const current = existing || {};
    const timestamp = nowIso();
    const type = cleanString(valueOr(source, "type", current.type), 30);
    const rawStatus = valueOr(source, "status", current.status);
    const relationship = {
      id: cleanString(source.id || current.id || makeId("relation"), 150),
      type: type,
      fromPersonId: cleanString(valueOr(source, "fromPersonId", current.fromPersonId), 150),
      toPersonId: cleanString(valueOr(source, "toPersonId", current.toPersonId), 150),
      relationshipType: cleanString(valueOr(source, "relationshipType", current.relationshipType), 30),
      startDate: cleanString(valueOr(source, "startDate", current.startDate), 10),
      endDate: cleanString(valueOr(source, "endDate", current.endDate), 10),
      status: type === "partner" ? (PARTNER_STATUSES.has(rawStatus) ? rawStatus : (rawStatus ? "unknown" : "current")) : "",
      sortOrder: normalizeSortOrder(valueOr(source, "sortOrder", current.sortOrder), current.sortOrder),
      memo: cleanString(valueOr(source, "memo", current.memo), 1000),
      createdAt: current.createdAt || cleanString(source.createdAt, 40) || timestamp,
      updatedAt: timestamp
    };
    if (relationship.startDate && relationship.endDate && relationship.startDate > relationship.endDate) throw new Error("終了日は開始日以降の日付にしてください。");
    return relationship;
  }

  function hydrateRelationship(value) {
    const relationship = Object.assign({}, value);
    relationship.status = relationship.type === "partner" ? (PARTNER_STATUSES.has(relationship.status) ? relationship.status : (relationship.status ? "unknown" : "current")) : "";
    relationship.sortOrder = normalizeSortOrder(relationship.sortOrder, null);
    return relationship;
  }

  async function readAll() {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_PERSONS, STORE_RELATIONSHIPS, STORE_SETTINGS, STORE_DUPLICATE_EXCLUSIONS], "readonly");
    const values = await Promise.all([
      requestAsPromise(transaction.objectStore(STORE_PERSONS).getAll()),
      requestAsPromise(transaction.objectStore(STORE_RELATIONSHIPS).getAll()),
      requestAsPromise(transaction.objectStore(STORE_SETTINGS).get(SETTINGS_KEY)),
      requestAsPromise(transaction.objectStore(STORE_DUPLICATE_EXCLUSIONS).getAll())
    ]);
    return {
      persons: values[0].map(hydratePerson),
      relationships: values[1].map(hydrateRelationship),
      settings: normalizeSettings(values[2]),
      duplicateExclusions: values[3] || []
    };
  }

  function hasParentPath(startId, targetId, relationships, ignoredId) {
    const childrenByParent = new Map();
    relationships.forEach(function (relationship) {
      if (relationship.type !== "parent-child" || relationship.id === ignoredId) return;
      if (!childrenByParent.has(relationship.fromPersonId)) childrenByParent.set(relationship.fromPersonId, []);
      childrenByParent.get(relationship.fromPersonId).push(relationship.toPersonId);
    });
    const queue = [startId];
    const visited = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (id === targetId) return true;
      if (visited.has(id)) continue;
      visited.add(id);
      (childrenByParent.get(id) || []).forEach(function (childId) { queue.push(childId); });
    }
    return false;
  }

  function relationshipKey(relationship) {
    if (relationship.type === "partner") return "partner:" + [relationship.fromPersonId, relationship.toPersonId].sort().join(":");
    return "parent-child:" + relationship.fromPersonId + ":" + relationship.toPersonId;
  }

  function validateRelationship(relationship, persons, relationships, ignoredId) {
    if (relationship.type !== "parent-child" && relationship.type !== "partner") throw new Error("対応していない関係の種類です。");
    if (!relationship.fromPersonId || !relationship.toPersonId) throw new Error("関係する人物を選んでください。");
    if (relationship.fromPersonId === relationship.toPersonId) throw new Error("自分自身との関係は登録できません。");
    const personIds = new Set(persons.map(function (person) { return person.id; }));
    if (!personIds.has(relationship.fromPersonId) || !personIds.has(relationship.toPersonId)) throw new Error("関係する人物が見つかりません。");
    if (relationship.type === "parent-child" && !PARENT_TYPES.has(relationship.relationshipType)) throw new Error("親子関係の詳細が正しくありません。");
    if (relationship.type === "partner" && !PARTNER_TYPES.has(relationship.relationshipType)) throw new Error("パートナー関係の詳細が正しくありません。");
    if (relationship.type === "partner" && !PARTNER_STATUSES.has(relationship.status)) throw new Error("パートナー関係の状態が正しくありません。");
    const key = relationshipKey(relationship);
    if (relationships.some(function (item) { return item.id !== ignoredId && relationshipKey(item) === key; })) throw new Error("同じ関係がすでに登録されています。");
    if (relationship.type === "parent-child") {
      const reverseExists = relationships.some(function (item) {
        return item.id !== ignoredId && item.type === "parent-child" && item.fromPersonId === relationship.toPersonId && item.toPersonId === relationship.fromPersonId;
      });
      if (reverseExists) throw new Error("2人の親子関係の向きが矛盾するため登録できません。");
      if (hasParentPath(relationship.toPersonId, relationship.fromPersonId, relationships, ignoredId)) throw new Error("親子関係が循環するため登録できません。");
    }
  }

  function validateWholeDataset(persons, relationships, settings, exclusions) {
    if (!Array.isArray(persons) || !Array.isArray(relationships) || !settings || typeof settings !== "object") throw new Error("バックアップのデータ構造が正しくありません。");
    const personIds = new Set();
    persons.forEach(function (person, index) {
      if (!person || typeof person !== "object") throw new Error("人物データ " + (index + 1) + " が正しくありません。");
      if (typeof person.id !== "string" || !person.id || personIds.has(person.id)) throw new Error("人物IDが不正または重複しています。");
      if (typeof person.givenName !== "string" || !person.givenName.trim()) throw new Error("名が空の人物データがあります。");
      if (!DATE_PRECISIONS.has(person.birthDatePrecision) || !DATE_PRECISIONS.has(person.deathDatePrecision)) throw new Error("年月日の精度情報が正しくありません。");
      if (typeof person.birthDateApproximate !== "boolean" || typeof person.deathDateApproximate !== "boolean") throw new Error("年月日の概算情報が正しくありません。");
      if (typeof person.photo !== "string" || (person.photo && !/^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(person.photo))) throw new Error("写真データの形式が正しくありません。");
      if (typeof person.isDeceased !== "boolean") throw new Error("故人情報の形式が正しくありません。");
      personIds.add(person.id);
    });
    const relationIds = new Set();
    const relationKeys = new Set();
    relationships.forEach(function (relationship) {
      if (!relationship || typeof relationship !== "object" || typeof relationship.id !== "string" || !relationship.id || relationIds.has(relationship.id)) throw new Error("関係IDが不正または重複しています。");
      if (!personIds.has(relationship.fromPersonId) || !personIds.has(relationship.toPersonId)) throw new Error("存在しない人物を参照する関係があります。");
      if (relationship.fromPersonId === relationship.toPersonId) throw new Error("自分自身を参照する関係があります。");
      if (relationship.type === "parent-child" && !PARENT_TYPES.has(relationship.relationshipType)) throw new Error("不正な親子関係があります。");
      if (relationship.type === "partner" && !PARTNER_TYPES.has(relationship.relationshipType)) throw new Error("不正なパートナー関係があります。");
      if (relationship.type !== "parent-child" && relationship.type !== "partner") throw new Error("不正な関係種別があります。");
      const key = relationshipKey(relationship);
      if (relationKeys.has(key)) throw new Error("重複した関係があります。");
      relationKeys.add(key); relationIds.add(relationship.id);
    });
    const childrenByParent = new Map();
    relationships.filter(function (item) { return item.type === "parent-child"; }).forEach(function (relationship) {
      if (!childrenByParent.has(relationship.fromPersonId)) childrenByParent.set(relationship.fromPersonId, []);
      childrenByParent.get(relationship.fromPersonId).push(relationship.toPersonId);
    });
    const active = new Set();
    const finished = new Set();
    function visit(personId) {
      if (active.has(personId)) throw new Error("循環する親子関係が含まれています。");
      if (finished.has(personId)) return;
      active.add(personId);
      (childrenByParent.get(personId) || []).forEach(visit);
      active.delete(personId); finished.add(personId);
    }
    personIds.forEach(visit);
    if (settings.focusPersonId && !personIds.has(settings.focusPersonId)) settings.focusPersonId = "";
    Object.assign(settings, normalizeSettings(settings));
    if (exclusions !== undefined && !Array.isArray(exclusions)) throw new Error("重複候補の除外情報が正しくありません。");
    (exclusions || []).forEach(function (item) {
      if (!item || typeof item.id !== "string" || !personIds.has(item.personAId) || !personIds.has(item.personBId) || item.personAId === item.personBId) throw new Error("重複候補の除外情報が不正です。");
    });
  }

  async function savePerson(input) {
    const db = await openDatabase();
    let existing = null;
    if (input.id) existing = await requestAsPromise(db.transaction(STORE_PERSONS, "readonly").objectStore(STORE_PERSONS).get(input.id));
    const person = normalizePerson(input, existing && hydratePerson(existing));
    const transaction = db.transaction(STORE_PERSONS, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_PERSONS).put(person);
    await done;
    return person;
  }

  async function saveRelativePerson(basePersonId, personInput, relationInput) {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_PERSONS, STORE_RELATIONSHIPS], "readwrite");
    const done = transactionDone(transaction);
    const personStore = transaction.objectStore(STORE_PERSONS);
    const relationshipStore = transaction.objectStore(STORE_RELATIONSHIPS);
    try {
      const values = await Promise.all([requestAsPromise(personStore.getAll()), requestAsPromise(relationshipStore.getAll())]);
      const persons = values[0].map(hydratePerson);
      const relationships = values[1].map(hydrateRelationship);
      if (!persons.some(function (person) { return person.id === basePersonId; })) throw new Error("基準となる人物が見つかりません。");
      const person = normalizePerson(personInput, null);
      if (persons.some(function (item) { return item.id === person.id; })) throw new Error("人物IDが重複しています。");
      let fromPersonId;
      let toPersonId;
      if (relationInput.role === "parent") { fromPersonId = person.id; toPersonId = basePersonId; }
      else if (relationInput.role === "child") { fromPersonId = basePersonId; toPersonId = person.id; }
      else if (relationInput.role === "partner") { fromPersonId = basePersonId; toPersonId = person.id; }
      else throw new Error("親族の種類が正しくありません。");
      const relationship = normalizeRelationship(Object.assign({}, relationInput, { type: relationInput.role === "partner" ? "partner" : "parent-child", fromPersonId: fromPersonId, toPersonId: toPersonId }));
      validateRelationship(relationship, persons.concat(person), relationships);
      personStore.add(person); relationshipStore.add(relationship);
      await done;
      return { person: person, relationship: relationship };
    } catch (error) {
      try { transaction.abort(); } catch (abortError) {}
      try { await done; } catch (transactionError) {}
      throw error;
    }
  }

  async function deletePerson(personId) {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_PERSONS, STORE_RELATIONSHIPS, STORE_SETTINGS, STORE_DUPLICATE_EXCLUSIONS], "readwrite");
    const done = transactionDone(transaction);
    const relationshipsStore = transaction.objectStore(STORE_RELATIONSHIPS);
    const relationships = await requestAsPromise(relationshipsStore.getAll());
    relationships.forEach(function (relationship) { if (relationship.fromPersonId === personId || relationship.toPersonId === personId) relationshipsStore.delete(relationship.id); });
    transaction.objectStore(STORE_PERSONS).delete(personId);
    const settingsStore = transaction.objectStore(STORE_SETTINGS);
    const settings = normalizeSettings(await requestAsPromise(settingsStore.get(SETTINGS_KEY)));
    if (settings.focusPersonId === personId) { settings.focusPersonId = ""; settingsStore.put(settings, SETTINGS_KEY); }
    const exclusionStore = transaction.objectStore(STORE_DUPLICATE_EXCLUSIONS);
    const exclusions = await requestAsPromise(exclusionStore.getAll());
    exclusions.forEach(function (item) { if (item.personAId === personId || item.personBId === personId) exclusionStore.delete(item.id); });
    await done;
  }

  async function saveRelationship(input) {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_PERSONS, STORE_RELATIONSHIPS], "readwrite");
    const done = transactionDone(transaction);
    const personStore = transaction.objectStore(STORE_PERSONS);
    const relationshipStore = transaction.objectStore(STORE_RELATIONSHIPS);
    try {
      const values = await Promise.all([requestAsPromise(personStore.getAll()), requestAsPromise(relationshipStore.getAll())]);
      const persons = values[0].map(hydratePerson);
      const relationships = values[1].map(hydrateRelationship);
      const existing = input.id ? relationships.find(function (item) { return item.id === input.id; }) : null;
      if (input.id && !existing) throw new Error("編集する関係が見つかりません。");
      const relationship = normalizeRelationship(input, existing);
      validateRelationship(relationship, persons, relationships, existing && existing.id);
      relationshipStore.put(relationship);
      await done;
      return relationship;
    } catch (error) {
      try { transaction.abort(); } catch (abortError) {}
      try { await done; } catch (transactionError) {}
      throw error;
    }
  }

  async function deleteRelationship(relationshipId) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_RELATIONSHIPS, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_RELATIONSHIPS).delete(relationshipId);
    await done;
  }

  async function saveRelationshipOrders(updates) {
    if (!Array.isArray(updates) || !updates.length) return;
    const db = await openDatabase();
    const transaction = db.transaction(STORE_RELATIONSHIPS, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE_RELATIONSHIPS);
    try {
      const relationships = await requestAsPromise(store.getAll());
      const byId = new Map(relationships.map(function (item) { return [item.id, item]; }));
      updates.forEach(function (update) {
        const current = byId.get(update.id);
        if (!current) throw new Error("並べ替える関係が見つかりません。");
        current.sortOrder = normalizeSortOrder(update.sortOrder, null); current.updatedAt = nowIso(); store.put(current);
      });
      await done;
    } catch (error) {
      try { transaction.abort(); } catch (abortError) {}
      try { await done; } catch (transactionError) {}
      throw error;
    }
  }

  async function saveSettings(changes) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_SETTINGS, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE_SETTINGS);
    const current = normalizeSettings(await requestAsPromise(store.get(SETTINGS_KEY)));
    const next = Object.assign({}, current, changes || {});
    if (changes && changes.printSettings) next.printSettings = Object.assign({}, current.printSettings, changes.printSettings);
    const settings = normalizeSettings(next);
    store.put(settings, SETTINGS_KEY);
    await done;
    return settings;
  }

  function exclusionId(personAId, personBId) {
    return [personAId, personBId].sort().map(encodeURIComponent).join("|");
  }

  async function saveDuplicateExclusion(personAId, personBId) {
    if (!personAId || !personBId || personAId === personBId) throw new Error("除外する人物の組み合わせが正しくありません。");
    const db = await openDatabase();
    const transaction = db.transaction([STORE_PERSONS, STORE_DUPLICATE_EXCLUSIONS], "readwrite");
    const done = transactionDone(transaction);
    const persons = await requestAsPromise(transaction.objectStore(STORE_PERSONS).getAll());
    const ids = new Set(persons.map(function (person) { return person.id; }));
    if (!ids.has(personAId) || !ids.has(personBId)) { try { transaction.abort(); } catch (error) {} try { await done; } catch (error) {} throw new Error("人物が見つかりません。"); }
    const pair = [personAId, personBId].sort();
    const record = { id: exclusionId(pair[0], pair[1]), personAId: pair[0], personBId: pair[1], createdAt: nowIso() };
    transaction.objectStore(STORE_DUPLICATE_EXCLUSIONS).put(record);
    await done;
    return record;
  }

  function normalizeSearchText(value) {
    return cleanString(value, 1000).toLocaleLowerCase("ja").replace(/[\s・･.,，．\-ー_]/g, "").replace(/[ァ-ヶ]/g, function (char) { return String.fromCharCode(char.charCodeAt(0) - 0x60); });
  }

  function bigramSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    const grams = new Map();
    for (let i = 0; i < a.length - 1; i += 1) grams.set(a.slice(i, i + 2), (grams.get(a.slice(i, i + 2)) || 0) + 1);
    let matches = 0;
    for (let i = 0; i < b.length - 1; i += 1) { const gram = b.slice(i, i + 2); const count = grams.get(gram) || 0; if (count) { matches += 1; grams.set(gram, count - 1); } }
    return (2 * matches) / ((a.length - 1) + (b.length - 1));
  }

  function relativeSets(personId, relationships) {
    const result = { parents: new Set(), partners: new Set(), children: new Set() };
    relationships.forEach(function (item) {
      if (item.type === "parent-child" && item.toPersonId === personId) result.parents.add(item.fromPersonId);
      else if (item.type === "parent-child" && item.fromPersonId === personId) result.children.add(item.toPersonId);
      else if (item.type === "partner" && (item.fromPersonId === personId || item.toPersonId === personId)) result.partners.add(item.fromPersonId === personId ? item.toPersonId : item.fromPersonId);
    });
    return result;
  }

  function intersects(a, b) { return Array.from(a).some(function (value) { return b.has(value); }); }

  function detectDuplicateCandidates(persons, relationships, exclusions) {
    const excluded = new Set((exclusions || []).map(function (item) { return item.id; }));
    const relativeCache = new Map();
    function relatives(id) { if (!relativeCache.has(id)) relativeCache.set(id, relativeSets(id, relationships)); return relativeCache.get(id); }
    const candidates = [];
    for (let i = 0; i < persons.length; i += 1) {
      for (let j = i + 1; j < persons.length; j += 1) {
        const a = persons[i]; const b = persons[j];
        if (excluded.has(exclusionId(a.id, b.id))) continue;
        const nameA = normalizeSearchText((a.familyName || "") + (a.givenName || ""));
        const nameB = normalizeSearchText((b.familyName || "") + (b.givenName || ""));
        const kanaA = normalizeSearchText((a.familyNameKana || "") + (a.givenNameKana || ""));
        const kanaB = normalizeSearchText((b.familyNameKana || "") + (b.givenNameKana || ""));
        const familyNamesA = new Set([a.familyName, a.formerFamilyName].map(normalizeSearchText).filter(Boolean));
        const familyNamesB = new Set([b.familyName, b.formerFamilyName].map(normalizeSearchText).filter(Boolean));
        const yearA = (a.birthDate || "").slice(0, 4); const yearB = (b.birthDate || "").slice(0, 4);
        const reasons = []; let score = 0;
        if (nameA && nameA === nameB) { score += 5; reasons.push("姓名が一致"); }
        else if (bigramSimilarity(nameA, nameB) >= 0.72) { score += 3; reasons.push("氏名が似ています"); }
        if (kanaA && kanaA === kanaB) { score += 4; reasons.push("よみがなが一致"); }
        if (intersects(familyNamesA, familyNamesB)) { score += 1; if (!reasons.includes("姓名が一致")) reasons.push("姓・旧姓が一致"); }
        if (a.birthDate && b.birthDate && a.birthDate === b.birthDate) { score += 4; reasons.push("生年月日が一致"); }
        else if (yearA && yearA === yearB) { score += 3; reasons.push("生年が一致"); }
        const ra = relatives(a.id); const rb = relatives(b.id);
        if (intersects(ra.parents, rb.parents)) { score += 2; reasons.push("共通の親"); }
        if (intersects(ra.partners, rb.partners)) { score += 2; reasons.push("共通の配偶者・パートナー"); }
        if (intersects(ra.children, rb.children)) { score += 2; reasons.push("共通の子ども"); }
        if (score >= 5) candidates.push({ personAId: a.id, personBId: b.id, score: score, reasons: reasons });
      }
    }
    return candidates.sort(function (a, b) { return b.score - a.score || a.personAId.localeCompare(b.personAId); });
  }

  function selectMergedValue(keep, merge, field, selections) {
    if (selections && selections[field] === "merge") return merge[field];
    if (selections && selections[field] === "keep") return keep[field];
    return keep[field] !== "" && keep[field] !== null && keep[field] !== undefined ? keep[field] : merge[field];
  }

  async function mergePersons(keepPersonId, mergePersonId, selections) {
    if (!keepPersonId || !mergePersonId || keepPersonId === mergePersonId) throw new Error("統合する2人を正しく選んでください。");
    const db = await openDatabase();
    const transaction = db.transaction([STORE_PERSONS, STORE_RELATIONSHIPS, STORE_SETTINGS, STORE_DUPLICATE_EXCLUSIONS], "readwrite");
    const done = transactionDone(transaction);
    try {
      const personStore = transaction.objectStore(STORE_PERSONS);
      const relationshipStore = transaction.objectStore(STORE_RELATIONSHIPS);
      const settingsStore = transaction.objectStore(STORE_SETTINGS);
      const exclusionStore = transaction.objectStore(STORE_DUPLICATE_EXCLUSIONS);
      const values = await Promise.all([requestAsPromise(personStore.getAll()), requestAsPromise(relationshipStore.getAll()), requestAsPromise(settingsStore.get(SETTINGS_KEY)), requestAsPromise(exclusionStore.getAll())]);
      const persons = values[0].map(hydratePerson);
      const keep = persons.find(function (person) { return person.id === keepPersonId; });
      const merge = persons.find(function (person) { return person.id === mergePersonId; });
      if (!keep || !merge) throw new Error("統合する人物が見つかりません。");
      const directFields = ["familyName", "givenName", "formerFamilyName", "nickname", "otherNames", "honorific", "nameMemo", "gender", "birthplace", "photo", "memo"];
      const combined = Object.assign({}, keep);
      directFields.forEach(function (field) { combined[field] = selectMergedValue(keep, merge, field, selections); });
      ["familyNameKana", "givenNameKana"].forEach(function (field) { combined[field] = selectMergedValue(keep, merge, field, { [field]: selections && selections.reading }); });
      const birthSource = selections && selections.birth === "merge" ? merge : (selections && selections.birth === "keep" ? keep : (keep.birthDate ? keep : merge));
      ["birthDate", "birthDatePrecision", "birthDateApproximate"].forEach(function (field) { combined[field] = birthSource[field]; });
      const deathSource = selections && selections.death === "merge" ? merge : (selections && selections.death === "keep" ? keep : ((keep.deathDate || keep.isDeceased) ? keep : merge));
      ["deathDate", "deathDatePrecision", "deathDateApproximate", "isDeceased"].forEach(function (field) { combined[field] = deathSource[field]; });
      combined.id = keep.id;
      combined.createdAt = [keep.createdAt, merge.createdAt].filter(Boolean).sort()[0] || nowIso();
      combined.updatedAt = nowIso();
      const normalizedCombined = normalizePerson(combined, Object.assign({}, combined, { createdAt: combined.createdAt }));
      const mappedRelationships = values[1].map(hydrateRelationship).map(function (item) {
        const next = Object.assign({}, item);
        if (next.fromPersonId === mergePersonId) next.fromPersonId = keepPersonId;
        if (next.toPersonId === mergePersonId) next.toPersonId = keepPersonId;
        return next;
      }).filter(function (item) { return item.fromPersonId !== item.toPersonId; });
      const relationshipMap = new Map();
      mappedRelationships.forEach(function (item) {
        const key = relationshipKey(item);
        if (!relationshipMap.has(key)) { relationshipMap.set(key, item); return; }
        const current = relationshipMap.get(key);
        ["startDate", "endDate", "memo"].forEach(function (field) { if (!current[field] && item[field]) current[field] = item[field]; });
        if (current.sortOrder === null && item.sortOrder !== null) current.sortOrder = item.sortOrder;
        current.updatedAt = nowIso();
      });
      const nextPersons = persons.filter(function (person) { return person.id !== mergePersonId && person.id !== keepPersonId; }).concat(normalizedCombined);
      const nextRelationships = Array.from(relationshipMap.values());
      const settings = normalizeSettings(values[2]);
      if (settings.focusPersonId === mergePersonId) settings.focusPersonId = keepPersonId;
      const exclusions = values[3].filter(function (item) { return ![keepPersonId, mergePersonId].includes(item.personAId) && ![keepPersonId, mergePersonId].includes(item.personBId); });
      validateWholeDataset(nextPersons, nextRelationships, settings, exclusions);
      personStore.clear(); relationshipStore.clear(); exclusionStore.clear();
      nextPersons.forEach(function (person) { personStore.put(person); });
      nextRelationships.forEach(function (relationship) { relationshipStore.put(relationship); });
      exclusions.forEach(function (item) { exclusionStore.put(item); });
      settingsStore.put(settings, SETTINGS_KEY);
      await done;
      return { person: normalizedCombined, removedPersonId: mergePersonId, relationships: nextRelationships };
    } catch (error) {
      try { transaction.abort(); } catch (abortError) {}
      try { await done; } catch (transactionError) {}
      throw error;
    }
  }

  function sampleDataset() {
    const createdAt = "2026-01-01T00:00:00.000Z";
    function person(value) {
      return Object.assign({ formerFamilyName: "", familyNameKana: "", givenNameKana: "", nickname: "", otherNames: "", honorific: "", nameMemo: "", gender: "", birthDate: "", birthDatePrecision: "unknown", birthDateApproximate: false, deathDate: "", deathDatePrecision: "unknown", deathDateApproximate: false, isDeceased: false, birthplace: "", photo: "", memo: "", createdAt: createdAt, updatedAt: createdAt }, value);
    }
    const persons = [
      person({ id: "sample-shigeru", familyName: "森川", givenName: "茂", familyNameKana: "もりかわ", givenNameKana: "しげる", honorific: "祖父", gender: "male", birthDate: "1938-05-12", birthDatePrecision: "day", deathDate: "2016-09-21", deathDatePrecision: "day", isDeceased: true, birthplace: "長野県松本市", memo: "庭木を育てることが好きだった。" }),
      person({ id: "sample-kazuko", familyName: "森川", givenName: "和子", formerFamilyName: "小林", familyNameKana: "もりかわ", givenNameKana: "かずこ", nickname: "かずちゃん", gender: "female", birthDate: "1941-11", birthDatePrecision: "month", birthplace: "長野県安曇野市", memo: "家族の行事を大切にしている。" }),
      person({ id: "sample-takashi", familyName: "森川", givenName: "隆", familyNameKana: "もりかわ", givenNameKana: "たかし", gender: "male", birthDate: "1965", birthDatePrecision: "year", birthDateApproximate: true, birthplace: "長野県松本市" }),
      person({ id: "sample-megumi", familyName: "森川", givenName: "恵", formerFamilyName: "佐藤", familyNameKana: "もりかわ", givenNameKana: "めぐみ", otherNames: "惠", gender: "female", birthDate: "1967-07-09", birthDatePrecision: "day", birthplace: "東京都" }),
      person({ id: "sample-naoko", familyName: "井上", givenName: "直子", familyNameKana: "いのうえ", givenNameKana: "なおこ", gender: "female", birthDate: "1966", birthDatePrecision: "year", birthplace: "東京都", memo: "過去のパートナー関係の表示確認用。" }),
      person({ id: "sample-yumi", familyName: "青木", givenName: "由美", formerFamilyName: "森川", familyNameKana: "あおき", givenNameKana: "ゆみ", gender: "female", birthDate: "1968-10-26", birthDatePrecision: "day", birthplace: "長野県松本市" }),
      person({ id: "sample-haruka", familyName: "森川", givenName: "遥", familyNameKana: "もりかわ", givenNameKana: "はるか", gender: "female", birthDate: "1994-04-15", birthDatePrecision: "day", birthplace: "東京都", memo: "写真を撮ることが好き。" }),
      person({ id: "sample-kenta", familyName: "森川", givenName: "健太", familyNameKana: "もりかわ", givenNameKana: "けんた", gender: "male", birthDate: "1997-12-01", birthDatePrecision: "day", birthplace: "東京都" }),
      person({ id: "sample-sota", familyName: "森川", givenName: "颯太", familyNameKana: "もりかわ", givenNameKana: "そうた", gender: "male", birthDate: "2001-06-20", birthDatePrecision: "day", birthplace: "東京都" }),
      person({ id: "sample-daichi", familyName: "山本", givenName: "大地", familyNameKana: "やまもと", givenNameKana: "だいち", gender: "male", birthDate: "1993-09-08", birthDatePrecision: "day", birthplace: "神奈川県" })
    ];
    function relation(id, type, from, to, relationshipType, extra) { return Object.assign({ id: id, type: type, fromPersonId: from, toPersonId: to, relationshipType: relationshipType, startDate: "", endDate: "", status: type === "partner" ? "current" : "", sortOrder: null, memo: "", createdAt: createdAt, updatedAt: createdAt }, extra || {}); }
    const relationships = [
      relation("sample-rel-1", "partner", "sample-shigeru", "sample-kazuko", "marriage", { startDate: "1962-04-08", sortOrder: 10 }),
      relation("sample-rel-2", "parent-child", "sample-shigeru", "sample-takashi", "biological", { sortOrder: 10 }),
      relation("sample-rel-3", "parent-child", "sample-kazuko", "sample-takashi", "biological", { sortOrder: 10 }),
      relation("sample-rel-4", "parent-child", "sample-shigeru", "sample-yumi", "biological", { sortOrder: 20 }),
      relation("sample-rel-5", "parent-child", "sample-kazuko", "sample-yumi", "biological", { sortOrder: 20 }),
      relation("sample-rel-6", "partner", "sample-takashi", "sample-megumi", "marriage", { startDate: "1991-05-19", status: "current", sortOrder: 10 }),
      relation("sample-rel-7", "partner", "sample-takashi", "sample-naoko", "partnership", { startDate: "1987-03-01", endDate: "1989-12-15", status: "ended", sortOrder: 20 }),
      relation("sample-rel-8", "parent-child", "sample-takashi", "sample-haruka", "biological", { sortOrder: 10 }),
      relation("sample-rel-9", "parent-child", "sample-megumi", "sample-haruka", "biological", { sortOrder: 10 }),
      relation("sample-rel-10", "parent-child", "sample-takashi", "sample-kenta", "biological", { sortOrder: 20 }),
      relation("sample-rel-11", "parent-child", "sample-megumi", "sample-kenta", "adoptive", { sortOrder: 20 }),
      relation("sample-rel-12", "parent-child", "sample-takashi", "sample-sota", "biological", { sortOrder: 30 }),
      relation("sample-rel-13", "parent-child", "sample-megumi", "sample-sota", "biological", { sortOrder: 30 }),
      relation("sample-rel-14", "partner", "sample-haruka", "sample-daichi", "marriage", { startDate: "2021-10-10", status: "current", sortOrder: 10 })
    ];
    return { persons: persons, relationships: relationships, settings: Object.assign(defaultSettings(), { focusPersonId: "sample-takashi", sampleInitialized: true }), duplicateExclusions: [] };
  }

  async function replaceAll(persons, relationships, settings, exclusions) {
    validateWholeDataset(persons, relationships, settings, exclusions || []);
    const db = await openDatabase();
    const transaction = db.transaction([STORE_PERSONS, STORE_RELATIONSHIPS, STORE_SETTINGS, STORE_DUPLICATE_EXCLUSIONS], "readwrite");
    const done = transactionDone(transaction);
    const personStore = transaction.objectStore(STORE_PERSONS);
    const relationshipStore = transaction.objectStore(STORE_RELATIONSHIPS);
    const settingsStore = transaction.objectStore(STORE_SETTINGS);
    const exclusionStore = transaction.objectStore(STORE_DUPLICATE_EXCLUSIONS);
    personStore.clear(); relationshipStore.clear(); settingsStore.clear(); exclusionStore.clear();
    persons.forEach(function (person) { personStore.put(person); });
    relationships.forEach(function (relationship) { relationshipStore.put(relationship); });
    (exclusions || []).forEach(function (item) { exclusionStore.put(item); });
    settingsStore.put(Object.assign(normalizeSettings(settings), { sampleInitialized: true }), SETTINGS_KEY);
    await done;
  }

  async function resetSampleData() {
    const sample = sampleDataset();
    await replaceAll(sample.persons, sample.relationships, sample.settings, sample.duplicateExclusions);
    return readAll();
  }

  async function clearAll() {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_PERSONS, STORE_RELATIONSHIPS, STORE_SETTINGS, STORE_DUPLICATE_EXCLUSIONS], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_PERSONS).clear();
    transaction.objectStore(STORE_RELATIONSHIPS).clear();
    transaction.objectStore(STORE_DUPLICATE_EXCLUSIONS).clear();
    transaction.objectStore(STORE_SETTINGS).put(Object.assign(defaultSettings(), { sampleInitialized: true }), SETTINGS_KEY);
    await done;
  }

  async function initialize() {
    await openDatabase();
    const data = await readAll();
    if (!data.settings.sampleInitialized) {
      if (data.persons.length) { data.settings = await saveSettings({ sampleInitialized: true }); return data; }
      return resetSampleData();
    }
    return data;
  }

  function assertOptionalType(value, key, type) {
    if (value && Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] !== type) throw new Error("人物の追加項目「" + key + "」の形式が正しくありません。");
  }

  function normalizeImportedPerson(value) {
    ["nickname", "otherNames", "honorific", "nameMemo"].forEach(function (key) { assertOptionalType(value, key, "string"); });
    ["birthDateApproximate", "deathDateApproximate"].forEach(function (key) { assertOptionalType(value, key, "boolean"); });
    const birthPrecision = DATE_PRECISIONS.has(value && value.birthDatePrecision) ? value.birthDatePrecision : inferDatePrecision(value && value.birthDate);
    const deathPrecision = DATE_PRECISIONS.has(value && value.deathDatePrecision) ? value.deathDatePrecision : inferDatePrecision(value && value.deathDate);
    const createdAt = cleanString(value && value.createdAt, 40) || nowIso();
    const updatedAt = cleanString(value && value.updatedAt, 40) || createdAt;
    const person = normalizePerson(Object.assign({}, value || {}, { birthDatePrecision: birthPrecision, deathDatePrecision: deathPrecision }), { createdAt: createdAt, updatedAt: updatedAt });
    person.createdAt = createdAt;
    person.updatedAt = updatedAt;
    return person;
  }

  function normalizeImportedRelationship(value, isLegacy) {
    const type = cleanString(value && value.type, 30);
    const rawStatus = value && value.status;
    return {
      id: cleanString(value && value.id, 150), type: type,
      fromPersonId: cleanString(value && value.fromPersonId, 150), toPersonId: cleanString(value && value.toPersonId, 150),
      relationshipType: cleanString(value && value.relationshipType, 30), startDate: cleanString(value && value.startDate, 10), endDate: cleanString(value && value.endDate, 10),
      status: type === "partner" ? (PARTNER_STATUSES.has(rawStatus) ? rawStatus : (isLegacy || !rawStatus ? "current" : "unknown")) : "",
      sortOrder: normalizeSortOrder(value && value.sortOrder, null), memo: cleanString(value && value.memo, 1000),
      createdAt: cleanString(value && value.createdAt, 40) || nowIso(), updatedAt: cleanString(value && value.updatedAt, 40) || nowIso()
    };
  }

  function normalizeImportedExclusions(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("重複候補の除外情報は配列である必要があります。");
    return value.map(function (item) {
      if (!item || typeof item.personAId !== "string" || typeof item.personBId !== "string") throw new Error("重複候補の除外情報が正しくありません。");
      const pair = [cleanString(item.personAId, 150), cleanString(item.personBId, 150)].sort();
      return { id: exclusionId(pair[0], pair[1]), personAId: pair[0], personBId: pair[1], createdAt: cleanString(item.createdAt, 40) || nowIso() };
    });
  }

  async function createBackup() {
    const data = await readAll();
    return {
      format: "family-tree-note-backup", appName: APP_NAME, appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION, exportedAt: nowIso(),
      persons: data.persons, relationships: data.relationships, settings: normalizeSettings(data.settings), duplicateExclusions: data.duplicateExclusions
    };
  }

  async function restoreBackup(value) {
    if (!value || typeof value !== "object") throw new Error("バックアップの内容が正しくありません。");
    const isLegacy = Boolean(value.data && Number(value.schemaVersion) === 1);
    const source = isLegacy ? value.data : value;
    if (value.format !== "family-tree-note-backup" || !source || !Array.isArray(source.persons) || !Array.isArray(source.relationships)) throw new Error("家系図ノートのバックアップではありません。人物・関係の配列を確認してください。");
    const persons = source.persons.map(normalizeImportedPerson);
    const relationships = source.relationships.map(function (item) { return normalizeImportedRelationship(item, isLegacy); });
    const settings = normalizeSettings(Object.assign({}, source.settings || {}, { sampleInitialized: true }));
    const exclusions = normalizeImportedExclusions(source.duplicateExclusions);
    validateWholeDataset(persons, relationships, settings, exclusions);
    await replaceAll(persons, relationships, settings, exclusions);
    return readAll();
  }

  globalThis.FamilyTreeDB = Object.freeze({
    APP_NAME: APP_NAME, APP_VERSION: APP_VERSION, SCHEMA_VERSION: SCHEMA_VERSION, DB_NAME: DB_NAME, DB_VERSION: DB_VERSION,
    initialize: initialize, readAll: readAll, savePerson: savePerson, saveRelativePerson: saveRelativePerson, deletePerson: deletePerson,
    saveRelationship: saveRelationship, deleteRelationship: deleteRelationship, saveRelationshipOrders: saveRelationshipOrders,
    saveSettings: saveSettings, saveDuplicateExclusion: saveDuplicateExclusion, detectDuplicateCandidates: detectDuplicateCandidates,
    mergePersons: mergePersons, resetSampleData: resetSampleData, clearAll: clearAll, createBackup: createBackup, restoreBackup: restoreBackup,
    validateRelationship: validateRelationship, validateWholeDataset: validateWholeDataset, sampleDataset: sampleDataset,
    inferDatePrecision: inferDatePrecision, dateBounds: dateBounds, normalizeSearchText: normalizeSearchText
  });
}());
