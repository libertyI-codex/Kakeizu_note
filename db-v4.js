(function () {
  "use strict";

  const Legacy = globalThis.FamilyTreeDB;
  const APP_VERSION = "1.0.0-prototype.4-fix.4-spine.2";
  const SCHEMA_VERSION = 4;
  const DB_VERSION = 4;
  const DB_NAME = "family-tree-note";
  const DEFAULT_TREE_ID = "tree-default";
  const SETTINGS_KEY = "app";
  const STORE = Object.freeze({
    persons: "persons", relationships: "relationships", settings: "settings", exclusions: "duplicateExclusions",
    trees: "trees", events: "events", sources: "sources", citations: "citations", attachments: "attachments", snapshots: "snapshots"
  });
  const ALL_STORES = Object.freeze(Object.values(STORE));
  const VERIFICATION = new Set(["confirmed", "probable", "unconfirmed", "disputed"]);
  const SOURCE_TYPES = new Set(["family-register", "certificate", "photograph", "interview", "letter", "diary", "gravestone", "newspaper", "book", "website", "personal-memory", "other"]);
  const RELIABILITIES = new Set(["high", "medium", "low", "unknown"]);
  const EVENT_TYPES = new Set(["birth", "death", "marriage", "divorce", "adoption", "residence", "education", "occupation", "military", "immigration", "illness", "award", "burial", "custom"]);
  const TARGET_TYPES = new Set(["person", "relationship", "event"]);
  const ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
  const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
  const MAX_SOURCE_ATTACHMENT_BYTES = 50 * 1024 * 1024;
  let readyPromise = null;
  let connectionPromise = null;
  let lastSnapshotId = "";

  function nowIso() { return new Date().toISOString(); }
  function makeId(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return prefix + "-" + globalThis.crypto.randomUUID();
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  function clean(value, max) { return String(value === null || value === undefined ? "" : value).trim().slice(0, max || 5000); }
  function valueOr(source, key, fallback) { return source && Object.prototype.hasOwnProperty.call(source, key) ? source[key] : fallback; }
  function requestPromise(request) { return new Promise(function (resolve, reject) { request.onsuccess = function () { resolve(request.result); }; request.onerror = function () { reject(request.error || new Error("データベース操作に失敗しました。")); }; }); }
  function transactionPromise(transaction) { return new Promise(function (resolve, reject) { transaction.oncomplete = resolve; transaction.onabort = function () { reject(transaction.error || new Error("保存処理が中断されました。")); }; transaction.onerror = function () { reject(transaction.error || new Error("保存処理に失敗しました。")); }; }); }
  function abortTransaction(transaction, error) { try { transaction.abort(); } catch (ignored) {} return error; }
  function verification(value, fallback) { return VERIFICATION.has(value) ? value : (fallback || "unconfirmed"); }
  function treeSettingKey(treeId) { return "tree:" + treeId; }
  function cloneWithoutBlob(value) { const copy = Object.assign({}, value); delete copy.blob; return copy; }

  function defaultTreeSettings(treeId) {
    return {
      treeId: treeId, focusPersonId: "", orientation: "vertical", scale: 1, schemaVersion: 4, sampleInitialized: true,
      treeViewMode: "all", kinshipDepth: "unlimited", includePartners: true, showGenerationLabels: false,
      outputPrivacyMode: "hide-dates", printSettings: { paperSize: "auto", title: "家系図ノート", note: "", showDate: true, showGenerationLabels: false, privacyMode: "hide-dates", scope: "current" }
    };
  }

  function normalizeTreeSettings(value, treeId) {
    const base = defaultTreeSettings(treeId);
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const normalized = Object.assign({}, base, source, { treeId: treeId, schemaVersion: 4, sampleInitialized: true, orientation: "vertical" });
    normalized.scale = Number.isFinite(Number(normalized.scale)) ? Math.max(0.25, Math.min(2.5, Number(normalized.scale))) : 1;
    if (!new Set(["all", "direct", "ancestors", "descendants", "lineage", "blood", "kinship"]).has(normalized.treeViewMode)) normalized.treeViewMode = "all";
    normalized.kinshipDepth = normalized.kinshipDepth === "unlimited" || /^[1-5]$/.test(String(normalized.kinshipDepth)) ? String(normalized.kinshipDepth) : "unlimited";
    normalized.includePartners = normalized.includePartners !== false;
    normalized.showGenerationLabels = Boolean(normalized.showGenerationLabels);
    return normalized;
  }

  async function connect() {
    if (connectionPromise) return connectionPromise;
    connectionPromise = new Promise(function (resolve, reject) {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = function () { const db = request.result; db.onversionchange = function () { db.close(); connectionPromise = null; }; resolve(db); };
      request.onerror = function () { connectionPromise = null; reject(request.error || new Error("データベースを開けませんでした。")); };
      request.onblocked = function () { connectionPromise = null; reject(new Error("別の画面で古い家系図ノートが開かれています。ほかの画面を閉じて再読み込みしてください。")); };
    });
    return connectionPromise;
  }

  async function ensureReady() {
    if (readyPromise) return readyPromise;
    readyPromise = (async function () {
      // db.js owns the v1→v4 upgrade transaction. Calling it first guarantees the
      // old stores, new stores, indexes and one-time treeId migration exist.
      await Legacy.readAll();
      const db = await connect();
      const tx = db.transaction(ALL_STORES, "readwrite");
      const done = transactionPromise(tx);
      try {
        const treeStore = tx.objectStore(STORE.trees);
        const settingsStore = tx.objectStore(STORE.settings);
        const personStore = tx.objectStore(STORE.persons);
        const relationshipStore = tx.objectStore(STORE.relationships);
        const exclusionStore = tx.objectStore(STORE.exclusions);
        const values = await Promise.all([
          requestPromise(treeStore.getAll()), requestPromise(settingsStore.get(SETTINGS_KEY)), requestPromise(personStore.getAll()), requestPromise(relationshipStore.getAll()), requestPromise(exclusionStore.getAll())
        ]);
        let trees = values[0] || [];
        const globalSettings = Object.assign({}, values[1] || {});
        let activeTreeId = globalSettings.activeTreeId;
        if (!trees.length) {
          const stamp = nowIso();
          const legacyFocus = globalSettings.focusPersonId || "";
          const tree = { id: DEFAULT_TREE_ID, name: "家族の家系図", description: "", rootPersonId: legacyFocus, coverColor: "#557c64", createdAt: stamp, updatedAt: stamp, isArchived: false };
          treeStore.put(tree); trees = [tree]; activeTreeId = tree.id;
        }
        if (!trees.some(function (tree) { return tree.id === activeTreeId; })) activeTreeId = trees[0].id;
        values[2].forEach(function (person) { if (!person.treeId) { person.treeId = activeTreeId; person.verificationStatus = verification(person.verificationStatus); personStore.put(person); } });
        values[3].forEach(function (relationship) { if (!relationship.treeId) { relationship.treeId = activeTreeId; relationship.verificationStatus = verification(relationship.verificationStatus); relationshipStore.put(relationship); } });
        values[4].forEach(function (item) { if (!item.treeId) { item.treeId = activeTreeId; exclusionStore.put(item); } });
        if (!values[2].length && !globalSettings.sampleInitialized) {
          const sample = Legacy.sampleDataset();
          sample.persons.forEach(function (person) { personStore.put(Object.assign({}, person, { treeId: activeTreeId, verificationStatus: "confirmed" })); });
          sample.relationships.forEach(function (relationship) { relationshipStore.put(Object.assign({}, relationship, { treeId: activeTreeId, verificationStatus: "confirmed" })); });
          globalSettings.focusPersonId = sample.settings.focusPersonId;
          globalSettings.sampleInitialized = true;
        }
        globalSettings.activeTreeId = activeTreeId; globalSettings.schemaVersion = 4; globalSettings.migrationV4Complete = true;
        settingsStore.put(globalSettings, SETTINGS_KEY);
        const treeSettingsKey = treeSettingKey(activeTreeId);
        const existingTreeSettings = await requestPromise(settingsStore.get(treeSettingsKey));
        if (!existingTreeSettings) settingsStore.put(normalizeTreeSettings(globalSettings, activeTreeId), treeSettingsKey);
        await done;
      } catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; }
      return true;
    }()).catch(function (error) { readyPromise = null; throw error; });
    return readyPromise;
  }

  async function getGlobalSettings(transaction) {
    const settings = await requestPromise(transaction.objectStore(STORE.settings).get(SETTINGS_KEY));
    return Object.assign({ activeTreeId: DEFAULT_TREE_ID, schemaVersion: 4, migrationV4Complete: true }, settings || {});
  }

  async function activeTreeId(transaction) {
    const settings = await getGlobalSettings(transaction);
    return settings.activeTreeId || DEFAULT_TREE_ID;
  }

  function allForTree(store, treeId) {
    if (store.indexNames.contains("treeId")) return requestPromise(store.index("treeId").getAll(IDBKeyRange.only(treeId)));
    return requestPromise(store.getAll()).then(function (items) { return items.filter(function (item) { return item.treeId === treeId; }); });
  }

  function normalizeTree(input, existing) {
    const source = input || {}; const current = existing || {}; const stamp = nowIso();
    const name = clean(valueOr(source, "name", current.name), 100);
    if (!name) throw new Error("家系図名を入力してください。");
    return {
      id: clean(source.id || current.id || makeId("tree"), 150), name: name,
      description: clean(valueOr(source, "description", current.description), 1000),
      rootPersonId: clean(valueOr(source, "rootPersonId", current.rootPersonId), 150),
      coverColor: /^#[0-9a-f]{6}$/i.test(valueOr(source, "coverColor", current.coverColor)) ? valueOr(source, "coverColor", current.coverColor) : "#557c64",
      createdAt: current.createdAt || clean(source.createdAt, 40) || stamp, updatedAt: stamp,
      isArchived: Boolean(valueOr(source, "isArchived", current.isArchived))
    };
  }

  function normalizePartialDate(value, precision) {
    const text = clean(value, 10);
    const resolved = new Set(["day", "month", "year", "unknown"]).has(precision) ? precision : Legacy.inferDatePrecision(text);
    if (!text || resolved === "unknown") return { value: "", precision: "unknown" };
    if (resolved === "year" && /^\d{4}$/.test(text)) return { value: text, precision: resolved };
    if (resolved === "month" && /^\d{4}-(0[1-9]|1[0-2])$/.test(text)) return { value: text, precision: resolved };
    if (resolved === "day" && /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(text)) {
      const parts = text.split("-").map(Number); const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      if (date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2]) return { value: text, precision: resolved };
    }
    throw new Error("年月日の形式が正しくありません。");
  }

  function normalizePerson(input, existing, forcedTreeId) {
    const source = input || {}; const current = existing || {}; const stamp = nowIso();
    const birth = normalizePartialDate(valueOr(source, "birthDate", current.birthDate || ""), valueOr(source, "birthDatePrecision", current.birthDatePrecision));
    const death = normalizePartialDate(valueOr(source, "deathDate", current.deathDate || ""), valueOr(source, "deathDatePrecision", current.deathDatePrecision));
    const treeId = forcedTreeId || current.treeId || clean(source.treeId, 150);
    const person = {
      id: clean(source.id || current.id || makeId("person"), 150), treeId: treeId,
      familyName: clean(valueOr(source, "familyName", current.familyName), 60), givenName: clean(valueOr(source, "givenName", current.givenName), 60),
      formerFamilyName: clean(valueOr(source, "formerFamilyName", current.formerFamilyName), 60), familyNameKana: clean(valueOr(source, "familyNameKana", current.familyNameKana), 80), givenNameKana: clean(valueOr(source, "givenNameKana", current.givenNameKana), 80),
      nickname: clean(valueOr(source, "nickname", current.nickname), 80), otherNames: clean(valueOr(source, "otherNames", current.otherNames), 300), honorific: clean(valueOr(source, "honorific", current.honorific), 40), nameMemo: clean(valueOr(source, "nameMemo", current.nameMemo), 500),
      gender: new Set(["", "female", "male", "nonbinary", "other", "undisclosed"]).has(valueOr(source, "gender", current.gender)) ? valueOr(source, "gender", current.gender) : "",
      birthDate: birth.value, birthDatePrecision: birth.precision, birthDateApproximate: birth.precision !== "unknown" && Boolean(valueOr(source, "birthDateApproximate", current.birthDateApproximate)),
      deathDate: death.value, deathDatePrecision: death.precision, deathDateApproximate: death.precision !== "unknown" && Boolean(valueOr(source, "deathDateApproximate", current.deathDateApproximate)),
      isDeceased: Boolean(valueOr(source, "isDeceased", current.isDeceased)), birthplace: clean(valueOr(source, "birthplace", current.birthplace), 120),
      photo: typeof valueOr(source, "photo", current.photo) === "string" ? valueOr(source, "photo", current.photo) : "", memo: clean(valueOr(source, "memo", current.memo), 3000),
      verificationStatus: verification(valueOr(source, "verificationStatus", current.verificationStatus)),
      createdAt: current.createdAt || clean(source.createdAt, 40) || stamp, updatedAt: stamp
    };
    if (!person.givenName) throw new Error("名を入力してください。");
    const birthBounds = Legacy.dateBounds(person.birthDate, person.birthDatePrecision); const deathBounds = Legacy.dateBounds(person.deathDate, person.deathDatePrecision);
    if (birthBounds && deathBounds && deathBounds.end < birthBounds.start) throw new Error("没年月日は生年月日以降にしてください。");
    return person;
  }

  function relationKey(item) { return item.type === "partner" ? "partner:" + [item.fromPersonId, item.toPersonId].sort().join(":") : "parent-child:" + item.fromPersonId + ":" + item.toPersonId; }
  function normalizeRelationship(input, existing, forcedTreeId) {
    const source = input || {}; const current = existing || {}; const stamp = nowIso(); const type = clean(valueOr(source, "type", current.type), 30);
    const status = clean(valueOr(source, "status", current.status), 30);
    const item = {
      id: clean(source.id || current.id || makeId("relation"), 150), treeId: forcedTreeId || current.treeId || clean(source.treeId, 150), type: type,
      fromPersonId: clean(valueOr(source, "fromPersonId", current.fromPersonId), 150), toPersonId: clean(valueOr(source, "toPersonId", current.toPersonId), 150),
      relationshipType: clean(valueOr(source, "relationshipType", current.relationshipType), 30), startDate: clean(valueOr(source, "startDate", current.startDate), 10), endDate: clean(valueOr(source, "endDate", current.endDate), 10),
      status: type === "partner" ? (new Set(["current", "divorced", "separated", "ended", "unknown"]).has(status) ? status : "unknown") : "",
      sortOrder: valueOr(source, "sortOrder", current.sortOrder) === null || valueOr(source, "sortOrder", current.sortOrder) === undefined ? null : Math.max(0, Math.round(Number(valueOr(source, "sortOrder", current.sortOrder)) || 0)),
      memo: clean(valueOr(source, "memo", current.memo), 1000), verificationStatus: verification(valueOr(source, "verificationStatus", current.verificationStatus)),
      createdAt: current.createdAt || clean(source.createdAt, 40) || stamp, updatedAt: stamp
    };
    if (item.startDate && item.endDate && item.startDate > item.endDate) throw new Error("終了日は開始日以降の日付にしてください。");
    return item;
  }

  function validateTreeRelationships(persons, relationships) {
    const personMap = new Map(persons.map(function (person) { return [person.id, person]; })); const keys = new Set(); const ids = new Set();
    relationships.forEach(function (item) {
      if (!item.id || ids.has(item.id)) throw new Error("関係IDが重複しています。"); ids.add(item.id);
      const from = personMap.get(item.fromPersonId); const to = personMap.get(item.toPersonId);
      if (!from || !to) throw new Error("存在しない人物を参照する関係があります。");
      if (from.treeId !== to.treeId || item.treeId !== from.treeId) throw new Error("異なる家系図の人物同士には関係を作成できません。");
      if (item.fromPersonId === item.toPersonId) throw new Error("自分自身との関係は登録できません。");
      const key = relationKey(item); if (keys.has(key)) throw new Error("同じ関係がすでに登録されています。"); keys.add(key);
    });
    Legacy.validateWholeDataset(persons, relationships, normalizeTreeSettings({}, persons[0] ? persons[0].treeId : ""), []);
  }

  async function readAll() {
    await ensureReady(); const db = await connect(); const tx = db.transaction([STORE.trees, STORE.persons, STORE.relationships, STORE.settings, STORE.exclusions, STORE.events, STORE.sources, STORE.citations], "readonly");
    const globalSettings = await getGlobalSettings(tx); const treeId = globalSettings.activeTreeId;
    const values = await Promise.all([
      requestPromise(tx.objectStore(STORE.trees).getAll()), requestPromise(tx.objectStore(STORE.trees).get(treeId)),
      allForTree(tx.objectStore(STORE.persons), treeId), allForTree(tx.objectStore(STORE.relationships), treeId), requestPromise(tx.objectStore(STORE.settings).get(treeSettingKey(treeId))),
      allForTree(tx.objectStore(STORE.exclusions), treeId), allForTree(tx.objectStore(STORE.events), treeId), allForTree(tx.objectStore(STORE.sources), treeId), allForTree(tx.objectStore(STORE.citations), treeId)
    ]);
    return { trees: values[0], currentTree: values[1], persons: values[2], relationships: values[3], settings: normalizeTreeSettings(values[4], treeId), duplicateExclusions: values[5], events: values[6], sources: values[7].filter(function (source) { return !source.deletedAt; }), citations: values[8] };
  }

  async function readTreeData(treeId, includeAttachments) {
    await ensureReady(); const db = await connect(); const names = [STORE.trees, STORE.persons, STORE.relationships, STORE.settings, STORE.exclusions, STORE.events, STORE.sources, STORE.citations]; if (includeAttachments) names.push(STORE.attachments);
    const tx = db.transaction(names, "readonly");
    const data = {
      tree: await requestPromise(tx.objectStore(STORE.trees).get(treeId)), persons: await allForTree(tx.objectStore(STORE.persons), treeId), relationships: await allForTree(tx.objectStore(STORE.relationships), treeId),
      settings: normalizeTreeSettings(await requestPromise(tx.objectStore(STORE.settings).get(treeSettingKey(treeId))), treeId), duplicateExclusions: await allForTree(tx.objectStore(STORE.exclusions), treeId),
      events: await allForTree(tx.objectStore(STORE.events), treeId), sources: await allForTree(tx.objectStore(STORE.sources), treeId), citations: await allForTree(tx.objectStore(STORE.citations), treeId)
    };
    data.attachments = includeAttachments ? await allForTree(tx.objectStore(STORE.attachments), treeId) : [];
    return data;
  }

  async function savePerson(input) {
    await ensureReady(); const db = await connect(); const tx = db.transaction([STORE.persons, STORE.settings], "readwrite"); const done = transactionPromise(tx);
    try { const treeId = await activeTreeId(tx); const store = tx.objectStore(STORE.persons); const existing = input && input.id ? await requestPromise(store.get(input.id)) : null; if (existing && existing.treeId !== treeId) throw new Error("別の家系図の人物は編集できません。"); const person = normalizePerson(input, existing, treeId); store.put(person); await done; return person; }
    catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; }
  }

  async function saveRelativePerson(basePersonId, personInput, relationInput) {
    await ensureReady(); const db = await connect(); const tx = db.transaction([STORE.persons, STORE.relationships, STORE.settings], "readwrite"); const done = transactionPromise(tx);
    try {
      const treeId = await activeTreeId(tx); const personStore = tx.objectStore(STORE.persons); const relationStore = tx.objectStore(STORE.relationships);
      const persons = await allForTree(personStore, treeId); const relationships = await allForTree(relationStore, treeId); const base = persons.find(function (person) { return person.id === basePersonId; }); if (!base) throw new Error("基準となる人物が見つかりません。");
      const person = normalizePerson(personInput, null, treeId); if (persons.some(function (item) { return item.id === person.id; })) throw new Error("人物IDが重複しています。");
      let from = basePersonId; let to = person.id; const role = relationInput.role;
      if (role === "parent") { from = person.id; to = basePersonId; } else if (role !== "child" && role !== "partner") throw new Error("親族の種類が正しくありません。");
      const relationship = normalizeRelationship(Object.assign({}, relationInput, { type: role === "partner" ? "partner" : "parent-child", fromPersonId: from, toPersonId: to }), null, treeId);
      validateTreeRelationships(persons.concat(person), relationships.concat(relationship)); personStore.add(person); relationStore.add(relationship); await done; return { person: person, relationship: relationship };
    } catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; }
  }

  async function saveRelationship(input) {
    await ensureReady(); const db = await connect(); const tx = db.transaction([STORE.persons, STORE.relationships, STORE.settings], "readwrite"); const done = transactionPromise(tx);
    try { const treeId = await activeTreeId(tx); const personStore = tx.objectStore(STORE.persons); const relationStore = tx.objectStore(STORE.relationships); const persons = await allForTree(personStore, treeId); const relationships = await allForTree(relationStore, treeId); const existing = input.id ? relationships.find(function (item) { return item.id === input.id; }) : null; if (input.id && !existing) throw new Error("編集する関係が見つかりません。"); const item = normalizeRelationship(input, existing, treeId); validateTreeRelationships(persons, relationships.filter(function (current) { return current.id !== item.id; }).concat(item)); relationStore.put(item); await done; return item; }
    catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; }
  }

  async function saveRelationshipOrders(updates) {
    if (!Array.isArray(updates) || !updates.length) return; await ensureReady(); const db = await connect(); const tx = db.transaction([STORE.relationships, STORE.settings], "readwrite"); const done = transactionPromise(tx);
    try { const treeId = await activeTreeId(tx); const store = tx.objectStore(STORE.relationships); for (const update of updates) { const current = await requestPromise(store.get(update.id)); if (!current || current.treeId !== treeId) throw new Error("並べ替える関係が見つかりません。"); current.sortOrder = update.sortOrder === null ? null : Math.max(0, Math.round(Number(update.sortOrder) || 0)); current.updatedAt = nowIso(); store.put(current); } await done; }
    catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; }
  }

  async function saveSettings(changes) {
    await ensureReady(); const db = await connect(); const tx = db.transaction(STORE.settings, "readwrite"); const done = transactionPromise(tx); const globalSettings = await getGlobalSettings(tx); const treeId = globalSettings.activeTreeId; const key = treeSettingKey(treeId); const current = normalizeTreeSettings(await requestPromise(tx.objectStore(STORE.settings).get(key)), treeId); const next = Object.assign({}, current, changes || {}); if (changes && changes.printSettings) next.printSettings = Object.assign({}, current.printSettings, changes.printSettings); const normalized = normalizeTreeSettings(next, treeId); tx.objectStore(STORE.settings).put(normalized, key); await done; return normalized;
  }

  async function saveDuplicateExclusion(personAId, personBId) {
    if (!personAId || !personBId || personAId === personBId) throw new Error("除外する人物の組み合わせが正しくありません。"); await ensureReady(); const data = await readAll(); const pair = [personAId, personBId].sort(); if (!data.persons.some(function (person) { return person.id === pair[0]; }) || !data.persons.some(function (person) { return person.id === pair[1]; })) throw new Error("除外する人物が見つかりません。"); const db = await connect(); const tx = db.transaction(STORE.exclusions, "readwrite"); const done = transactionPromise(tx); const item = { id: data.currentTree.id + "|" + pair.map(encodeURIComponent).join("|"), treeId: data.currentTree.id, personAId: pair[0], personBId: pair[1], createdAt: nowIso() }; tx.objectStore(STORE.exclusions).put(item); await done; return item;
  }

  async function listTrees(includeArchived) { const data = await readAll(); return data.trees.filter(function (tree) { return includeArchived || !tree.isArchived; }).sort(function (a, b) { return a.name.localeCompare(b.name, "ja"); }); }
  async function createTree(input) { await ensureReady(); const db = await connect(); const tx = db.transaction([STORE.trees, STORE.settings], "readwrite"); const done = transactionPromise(tx); const tree = normalizeTree(input, null); if (await requestPromise(tx.objectStore(STORE.trees).get(tree.id))) throw abortTransaction(tx, new Error("家系図IDが重複しています。")); tx.objectStore(STORE.trees).add(tree); tx.objectStore(STORE.settings).put(defaultTreeSettings(tree.id), treeSettingKey(tree.id)); const globalSettings = await getGlobalSettings(tx); globalSettings.activeTreeId = tree.id; globalSettings.schemaVersion = 4; tx.objectStore(STORE.settings).put(globalSettings, SETTINGS_KEY); await done; return tree; }
  async function updateTree(input) { await ensureReady(); const db = await connect(); const tx = db.transaction(STORE.trees, "readwrite"); const done = transactionPromise(tx); const store = tx.objectStore(STORE.trees); const existing = await requestPromise(store.get(input.id)); if (!existing) throw abortTransaction(tx, new Error("家系図が見つかりません。")); const tree = normalizeTree(input, existing); store.put(tree); await done; return tree; }
  async function switchTree(treeId) { await ensureReady(); const db = await connect(); const tx = db.transaction([STORE.trees, STORE.settings], "readwrite"); const done = transactionPromise(tx); const tree = await requestPromise(tx.objectStore(STORE.trees).get(treeId)); if (!tree) throw abortTransaction(tx, new Error("家系図が見つかりません。")); const settings = await getGlobalSettings(tx); settings.activeTreeId = treeId; settings.schemaVersion = 4; tx.objectStore(STORE.settings).put(settings, SETTINGS_KEY); await done; return readAll(); }
  async function setTreeArchived(treeId, archived) { const tree = await updateTree({ id: treeId, isArchived: archived }); if (archived) { const data = await readAll(); if (data.currentTree.id === treeId) { const next = data.trees.find(function (item) { return item.id !== treeId && !item.isArchived; }); if (next) await switchTree(next.id); } } return tree; }

  async function snapshotPayload(treeId, title, reason, manual) {
    const data = await readTreeData(treeId, true); const attachmentRefs = data.attachments.map(cloneWithoutBlob); const payload = { tree: data.tree, persons: data.persons, relationships: data.relationships, events: data.events, sources: data.sources, citations: data.citations, duplicateExclusions: data.duplicateExclusions, settings: data.settings, attachmentRefs: attachmentRefs };
    return { id: makeId("snapshot"), treeId: treeId, title: clean(title || "自動スナップショット", 120), reason: clean(reason, 300), createdAt: nowIso(), appVersion: APP_VERSION, schemaVersion: 4, isManual: Boolean(manual), data: payload, approximateSize: new Blob([JSON.stringify(payload)]).size };
  }

  async function pruneAutomaticSnapshots(treeId) {
    const db = await connect(); const tx = db.transaction(STORE.snapshots, "readwrite"); const done = transactionPromise(tx); const items = (await allForTree(tx.objectStore(STORE.snapshots), treeId)).filter(function (item) { return !item.isManual; }).sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }); items.slice(10).forEach(function (item) { tx.objectStore(STORE.snapshots).delete(item.id); }); await done;
  }

  async function createSnapshot(options) { await ensureReady(); const data = await readAll(); const treeId = options && options.treeId || data.currentTree.id; const snapshot = await snapshotPayload(treeId, options && options.title, options && options.reason, options && options.manual); const db = await connect(); const tx = db.transaction(STORE.snapshots, "readwrite"); const done = transactionPromise(tx); tx.objectStore(STORE.snapshots).put(snapshot); await done; if (!snapshot.isManual) await pruneAutomaticSnapshots(treeId); lastSnapshotId = snapshot.id; return snapshot; }
  async function listSnapshots(treeId) { await ensureReady(); const data = await readAll(); const id = treeId || data.currentTree.id; const db = await connect(); const tx = db.transaction(STORE.snapshots, "readonly"); const items = id === "all" ? await requestPromise(tx.objectStore(STORE.snapshots).getAll()) : await allForTree(tx.objectStore(STORE.snapshots), id); return items.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }); }
  async function deleteSnapshot(id) { await ensureReady(); const db = await connect(); const tx = db.transaction(STORE.snapshots, "readwrite"); const done = transactionPromise(tx); tx.objectStore(STORE.snapshots).delete(id); await done; }

  function dispatchUndo(snapshot, label) { lastSnapshotId = snapshot.id; globalThis.dispatchEvent(new CustomEvent("family-tree-undo", { detail: { snapshotId: snapshot.id, label: label || "操作" } })); }

  async function deleteRecordsForTree(transaction, treeId, stores) {
    for (const storeName of stores) {
      const store = transaction.objectStore(storeName); const items = await allForTree(store, treeId); items.forEach(function (item) { store.delete(item.id); });
    }
  }

  async function restoreSnapshot(snapshotId, options) {
    await ensureReady(); const db = await connect(); const lookup = db.transaction(STORE.snapshots, "readonly"); const snapshot = await requestPromise(lookup.objectStore(STORE.snapshots).get(snapshotId)); if (!snapshot || !snapshot.data) throw new Error("スナップショットが見つかりません。");
    if (!options || !options.skipSafetySnapshot) { const current = await readAll(); const targetExists = current.trees.some(function (tree) { return tree.id === snapshot.treeId; }); await createSnapshot({ treeId: targetExists ? snapshot.treeId : current.currentTree.id, title: "復元直前", reason: "スナップショット復元前の現在状態", manual: false }); }
    const tx = db.transaction([STORE.trees, STORE.persons, STORE.relationships, STORE.settings, STORE.exclusions, STORE.events, STORE.sources, STORE.citations], "readwrite"); const done = transactionPromise(tx);
    try {
      const data = snapshot.data; await deleteRecordsForTree(tx, snapshot.treeId, [STORE.persons, STORE.relationships, STORE.exclusions, STORE.events, STORE.sources, STORE.citations]);
      if (data.tree) tx.objectStore(STORE.trees).put(data.tree);
      (data.persons || []).forEach(function (item) { tx.objectStore(STORE.persons).put(item); }); (data.relationships || []).forEach(function (item) { tx.objectStore(STORE.relationships).put(item); });
      (data.duplicateExclusions || []).forEach(function (item) { tx.objectStore(STORE.exclusions).put(item); }); (data.events || []).forEach(function (item) { tx.objectStore(STORE.events).put(item); });
      (data.sources || []).forEach(function (item) { tx.objectStore(STORE.sources).put(item); }); (data.citations || []).forEach(function (item) { tx.objectStore(STORE.citations).put(item); });
      tx.objectStore(STORE.settings).put(normalizeTreeSettings(data.settings, snapshot.treeId), treeSettingKey(snapshot.treeId));
      const globalSettings = await getGlobalSettings(tx); globalSettings.activeTreeId = snapshot.treeId; globalSettings.schemaVersion = 4; tx.objectStore(STORE.settings).put(globalSettings, SETTINGS_KEY);
      await done; return readAll();
    } catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; }
  }
  async function undoLast() { if (!lastSnapshotId) throw new Error("元に戻せる操作がありません。"); const id = lastSnapshotId; lastSnapshotId = ""; return restoreSnapshot(id, { skipSafetySnapshot: false }); }

  async function deleteRelationship(id) { const snapshot = await createSnapshot({ title: "関係解除の前", reason: "関係解除", manual: false }); const db = await connect(); const tx = db.transaction(STORE.relationships, "readwrite"); const done = transactionPromise(tx); const item = await requestPromise(tx.objectStore(STORE.relationships).get(id)); if (!item || item.treeId !== snapshot.treeId) throw abortTransaction(tx, new Error("関係が見つかりません。")); tx.objectStore(STORE.relationships).delete(id); await done; dispatchUndo(snapshot, "関係解除"); return { snapshotId: snapshot.id };
  }

  async function deletePerson(id) {
    const snapshot = await createSnapshot({ title: "人物削除の前", reason: "人物削除", manual: false }); const db = await connect(); const tx = db.transaction([STORE.persons, STORE.relationships, STORE.settings, STORE.exclusions, STORE.events, STORE.citations], "readwrite"); const done = transactionPromise(tx);
    try {
      const person = await requestPromise(tx.objectStore(STORE.persons).get(id)); if (!person || person.treeId !== snapshot.treeId) throw new Error("人物が見つかりません。");
      const relationships = await allForTree(tx.objectStore(STORE.relationships), snapshot.treeId); relationships.forEach(function (item) { if (item.fromPersonId === id || item.toPersonId === id) tx.objectStore(STORE.relationships).delete(item.id); });
      const events = await allForTree(tx.objectStore(STORE.events), snapshot.treeId); events.forEach(function (event) { if ((event.personIds || []).includes(id)) { event.personIds = event.personIds.filter(function (personId) { return personId !== id; }); if (event.personIds.length) tx.objectStore(STORE.events).put(event); else tx.objectStore(STORE.events).delete(event.id); } });
      const citations = await allForTree(tx.objectStore(STORE.citations), snapshot.treeId); citations.forEach(function (citation) { if (citation.targetType === "person" && citation.targetId === id) tx.objectStore(STORE.citations).delete(citation.id); });
      const exclusions = await allForTree(tx.objectStore(STORE.exclusions), snapshot.treeId); exclusions.forEach(function (item) { if (item.personAId === id || item.personBId === id) tx.objectStore(STORE.exclusions).delete(item.id); });
      tx.objectStore(STORE.persons).delete(id); const settings = normalizeTreeSettings(await requestPromise(tx.objectStore(STORE.settings).get(treeSettingKey(snapshot.treeId))), snapshot.treeId); if (settings.focusPersonId === id) { settings.focusPersonId = ""; tx.objectStore(STORE.settings).put(settings, treeSettingKey(snapshot.treeId)); }
      await done; dispatchUndo(snapshot, "人物削除"); return { snapshotId: snapshot.id };
    } catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; }
  }

  async function mergePersons(keepId, mergeId, selections) {
    const snapshot = await createSnapshot({ title: "人物統合の前", reason: "人物統合", manual: false }); const db = await connect(); const tx = db.transaction([STORE.persons, STORE.relationships, STORE.settings, STORE.exclusions, STORE.events, STORE.citations], "readwrite"); const done = transactionPromise(tx);
    try {
      const personStore = tx.objectStore(STORE.persons); const relationStore = tx.objectStore(STORE.relationships); const persons = await allForTree(personStore, snapshot.treeId); const relationships = await allForTree(relationStore, snapshot.treeId); const keep = persons.find(function (p) { return p.id === keepId; }); const merge = persons.find(function (p) { return p.id === mergeId; }); if (!keep || !merge || keepId === mergeId) throw new Error("統合する2人が見つかりません。");
      const combined = Object.assign({}, keep); const fields = ["familyName", "givenName", "formerFamilyName", "nickname", "otherNames", "honorific", "nameMemo", "gender", "birthplace", "photo", "memo", "verificationStatus"];
      fields.forEach(function (field) { if (selections && selections[field] === "merge" || (!combined[field] && merge[field])) combined[field] = merge[field]; });
      if (selections && selections.reading === "merge" || (!combined.familyNameKana && !combined.givenNameKana)) { combined.familyNameKana = merge.familyNameKana; combined.givenNameKana = merge.givenNameKana; }
      if (selections && selections.birth === "merge" || (!combined.birthDate && merge.birthDate)) ["birthDate", "birthDatePrecision", "birthDateApproximate"].forEach(function (field) { combined[field] = merge[field]; });
      if (selections && selections.death === "merge" || (!combined.deathDate && merge.deathDate)) ["deathDate", "deathDatePrecision", "deathDateApproximate", "isDeceased"].forEach(function (field) { combined[field] = merge[field]; });
      const mergedPerson = normalizePerson(Object.assign({}, combined, { id: keepId }), keep, snapshot.treeId); mergedPerson.createdAt = [keep.createdAt, merge.createdAt].filter(Boolean).sort()[0] || keep.createdAt;
      const mapped = relationships.map(function (item) { const next = Object.assign({}, item); if (next.fromPersonId === mergeId) next.fromPersonId = keepId; if (next.toPersonId === mergeId) next.toPersonId = keepId; return next; }).filter(function (item) { return item.fromPersonId !== item.toPersonId; });
      const unique = new Map(); mapped.forEach(function (item) { const key = relationKey(item); if (!unique.has(key)) unique.set(key, item); else { const first = unique.get(key); if (!first.memo && item.memo) first.memo = item.memo; } }); const nextRelations = Array.from(unique.values()); const nextPersons = persons.filter(function (person) { return person.id !== keepId && person.id !== mergeId; }).concat(mergedPerson); validateTreeRelationships(nextPersons, nextRelations);
      const events = await allForTree(tx.objectStore(STORE.events), snapshot.treeId); events.forEach(function (event) { if ((event.personIds || []).includes(mergeId)) { event.personIds = Array.from(new Set(event.personIds.map(function (id) { return id === mergeId ? keepId : id; }))); event.updatedAt = nowIso(); tx.objectStore(STORE.events).put(event); } });
      const citations = await allForTree(tx.objectStore(STORE.citations), snapshot.treeId); citations.forEach(function (citation) { if (citation.targetType === "person" && citation.targetId === mergeId) { citation.targetId = keepId; citation.targetKey = "person:" + keepId; citation.updatedAt = nowIso(); tx.objectStore(STORE.citations).put(citation); } });
      personStore.delete(mergeId); personStore.put(mergedPerson); relationships.forEach(function (item) { relationStore.delete(item.id); }); nextRelations.forEach(function (item) { relationStore.put(item); });
      const exclusions = await allForTree(tx.objectStore(STORE.exclusions), snapshot.treeId); exclusions.forEach(function (item) { if ([keepId, mergeId].includes(item.personAId) || [keepId, mergeId].includes(item.personBId)) tx.objectStore(STORE.exclusions).delete(item.id); });
      const settings = normalizeTreeSettings(await requestPromise(tx.objectStore(STORE.settings).get(treeSettingKey(snapshot.treeId))), snapshot.treeId); if (settings.focusPersonId === mergeId) { settings.focusPersonId = keepId; tx.objectStore(STORE.settings).put(settings, treeSettingKey(snapshot.treeId)); }
      await done; dispatchUndo(snapshot, "人物統合"); return { person: mergedPerson, removedPersonId: mergeId, relationships: nextRelations, snapshotId: snapshot.id };
    } catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; }
  }

  function normalizeSource(input, existing, treeId) { const source = input || {}; const current = existing || {}; const stamp = nowIso(); const title = clean(valueOr(source, "title", current.title), 200); if (!title) throw new Error("資料名を入力してください。"); const type = valueOr(source, "sourceType", current.sourceType); const reliable = valueOr(source, "reliability", current.reliability); return { id: clean(source.id || current.id || makeId("source"), 150), treeId: treeId, title: title, sourceType: SOURCE_TYPES.has(type) ? type : "other", author: clean(valueOr(source, "author", current.author), 150), publisher: clean(valueOr(source, "publisher", current.publisher), 150), issuedDate: clean(valueOr(source, "issuedDate", current.issuedDate), 30), obtainedDate: clean(valueOr(source, "obtainedDate", current.obtainedDate), 10), repository: clean(valueOr(source, "repository", current.repository), 200), referenceNumber: clean(valueOr(source, "referenceNumber", current.referenceNumber), 100), url: clean(valueOr(source, "url", current.url), 500), note: clean(valueOr(source, "note", current.note), 3000), reliability: RELIABILITIES.has(reliable) ? reliable : "unknown", attachmentIds: Array.isArray(valueOr(source, "attachmentIds", current.attachmentIds)) ? valueOr(source, "attachmentIds", current.attachmentIds).map(function (id) { return clean(id, 150); }) : [], createdAt: current.createdAt || clean(source.createdAt, 40) || stamp, updatedAt: stamp, deletedAt: "" }; }
  async function listSources(treeId) { const data = treeId ? await readTreeData(treeId, false) : await readAll(); return data.sources.filter(function (source) { return !source.deletedAt; }); }
  async function saveSource(input) { await ensureReady(); const data = await readAll(); const treeId = data.currentTree.id; const db = await connect(); const tx = db.transaction(STORE.sources, "readwrite"); const done = transactionPromise(tx); const store = tx.objectStore(STORE.sources); const existing = input.id ? await requestPromise(store.get(input.id)) : null; if (existing && existing.treeId !== treeId) throw abortTransaction(tx, new Error("別の家系図の資料は編集できません。")); const source = normalizeSource(input, existing, treeId); store.put(source); await done; return source; }
  async function deleteSource(id) { const snapshot = await createSnapshot({ title: "資料削除の前", reason: "資料削除", manual: false }); const db = await connect(); const tx = db.transaction([STORE.sources, STORE.citations, STORE.attachments, STORE.events], "readwrite"); const done = transactionPromise(tx); try { const source = await requestPromise(tx.objectStore(STORE.sources).get(id)); if (!source || source.treeId !== snapshot.treeId) throw new Error("資料が見つかりません。"); const citations = await allForTree(tx.objectStore(STORE.citations), snapshot.treeId); const citationCount = citations.filter(function (item) { return item.sourceId === id; }).length; citations.forEach(function (item) { if (item.sourceId === id) tx.objectStore(STORE.citations).delete(item.id); }); const events = await allForTree(tx.objectStore(STORE.events), snapshot.treeId); events.forEach(function (event) { if ((event.sourceIds || []).includes(id)) { event.sourceIds = event.sourceIds.filter(function (sourceId) { return sourceId !== id; }); event.updatedAt = nowIso(); tx.objectStore(STORE.events).put(event); } }); const attachments = await requestPromise(tx.objectStore(STORE.attachments).index("sourceId").getAll(IDBKeyRange.only(id))); attachments.forEach(function (item) { tx.objectStore(STORE.attachments).delete(item.id); }); tx.objectStore(STORE.sources).delete(id); await done; dispatchUndo(snapshot, "資料削除"); return { citationCount: citationCount, attachmentCount: attachments.length, snapshotId: snapshot.id }; } catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; } }

  async function saveAttachment(input) { await ensureReady(); const data = await readAll(); const source = data.sources.find(function (item) { return item.id === input.sourceId; }); if (!source) throw new Error("添付先の資料が見つかりません。"); const blob = input.blob; if (!(blob instanceof Blob)) throw new Error("添付ファイルを読み込めませんでした。"); const mime = clean(input.mimeType || blob.type, 100).toLowerCase(); if (!ATTACHMENT_TYPES.has(mime)) throw new Error("JPEG、PNG、WebP、PDFのみ添付できます。"); if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error("1ファイルの上限は20MBです。"); const db = await connect(); const tx = db.transaction([STORE.attachments, STORE.sources], "readwrite"); const done = transactionPromise(tx); const existing = await requestPromise(tx.objectStore(STORE.attachments).index("sourceId").getAll(IDBKeyRange.only(source.id))); const total = existing.reduce(function (sum, item) { return sum + Number(item.size || 0); }, 0) + blob.size; if (total > MAX_SOURCE_ATTACHMENT_BYTES) throw abortTransaction(tx, new Error("1資料あたりの添付合計は50MBまでです。")); const item = { id: makeId("attachment"), treeId: source.treeId, sourceId: source.id, fileName: clean(input.fileName, 240) || "添付ファイル", mimeType: mime, size: blob.size, blob: blob, thumbnail: typeof input.thumbnail === "string" ? input.thumbnail : "", createdAt: nowIso() }; tx.objectStore(STORE.attachments).put(item); source.attachmentIds = Array.from(new Set((source.attachmentIds || []).concat(item.id))); source.updatedAt = nowIso(); tx.objectStore(STORE.sources).put(source); await done; return cloneWithoutBlob(item); }
  async function listAttachments(sourceId) { await ensureReady(); const db = await connect(); const tx = db.transaction(STORE.attachments, "readonly"); return requestPromise(tx.objectStore(STORE.attachments).index("sourceId").getAll(IDBKeyRange.only(sourceId))); }
  async function getAttachment(id) { await ensureReady(); const db = await connect(); return requestPromise(db.transaction(STORE.attachments, "readonly").objectStore(STORE.attachments).get(id)); }
  async function deleteAttachment(id) { await ensureReady(); const db = await connect(); const tx = db.transaction([STORE.attachments, STORE.sources], "readwrite"); const done = transactionPromise(tx); const item = await requestPromise(tx.objectStore(STORE.attachments).get(id)); if (item) { tx.objectStore(STORE.attachments).delete(id); const source = await requestPromise(tx.objectStore(STORE.sources).get(item.sourceId)); if (source) { source.attachmentIds = (source.attachmentIds || []).filter(function (value) { return value !== id; }); source.updatedAt = nowIso(); tx.objectStore(STORE.sources).put(source); } } await done; }

  function normalizeEvent(input, existing, treeId) { const source = input || {}; const current = existing || {}; const stamp = nowIso(); const type = valueOr(source, "eventType", current.eventType); const date = normalizePartialDate(valueOr(source, "date", current.date || ""), valueOr(source, "datePrecision", current.datePrecision)); const ids = Array.from(new Set((Array.isArray(valueOr(source, "personIds", current.personIds)) ? valueOr(source, "personIds", current.personIds) : []).map(function (id) { return clean(id, 150); }).filter(Boolean))); if (!ids.length) throw new Error("出来事に関係する人物を選んでください。"); return { id: clean(source.id || current.id || makeId("event"), 150), treeId: treeId, personIds: ids, eventType: EVENT_TYPES.has(type) ? type : "custom", title: clean(valueOr(source, "title", current.title), 160) || "出来事", date: date.value, datePrecision: date.precision, dateApproximate: date.precision !== "unknown" && Boolean(valueOr(source, "dateApproximate", current.dateApproximate)), endDate: clean(valueOr(source, "endDate", current.endDate), 10), place: clean(valueOr(source, "place", current.place), 180), description: clean(valueOr(source, "description", current.description), 3000), sourceIds: Array.from(new Set((Array.isArray(valueOr(source, "sourceIds", current.sourceIds)) ? valueOr(source, "sourceIds", current.sourceIds) : []).map(function (id) { return clean(id, 150); }).filter(Boolean))), verificationStatus: verification(valueOr(source, "verificationStatus", current.verificationStatus)), isSensitive: Boolean(valueOr(source, "isSensitive", current.isSensitive)) || type === "illness", sortOrder: Number.isFinite(Number(valueOr(source, "sortOrder", current.sortOrder))) ? Math.round(Number(valueOr(source, "sortOrder", current.sortOrder))) : null, createdAt: current.createdAt || clean(source.createdAt, 40) || stamp, updatedAt: stamp }; }
  async function saveEvent(input) { await ensureReady(); const data = await readAll(); const treeId = data.currentTree.id; const db = await connect(); const tx = db.transaction([STORE.events, STORE.persons, STORE.sources], "readwrite"); const done = transactionPromise(tx); try { const store = tx.objectStore(STORE.events); const existing = input.id ? await requestPromise(store.get(input.id)) : null; if (existing && existing.treeId !== treeId) throw new Error("別の家系図の出来事は編集できません。"); const event = normalizeEvent(input, existing, treeId); const persons = await allForTree(tx.objectStore(STORE.persons), treeId); const personIds = new Set(persons.map(function (person) { return person.id; })); if (event.personIds.some(function (id) { return !personIds.has(id); })) throw new Error("存在しない人物を出来事へ登録できません。"); const sources = await allForTree(tx.objectStore(STORE.sources), treeId); const sourceIds = new Set(sources.map(function (source) { return source.id; })); if (event.sourceIds.some(function (id) { return !sourceIds.has(id); })) throw new Error("存在しない資料を出来事へ登録できません。"); store.put(event); await done; return event; } catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; } }
  async function deleteEvent(id) { const snapshot = await createSnapshot({ title: "出来事削除の前", reason: "出来事削除", manual: false }); const db = await connect(); const tx = db.transaction([STORE.events, STORE.citations], "readwrite"); const done = transactionPromise(tx); const event = await requestPromise(tx.objectStore(STORE.events).get(id)); if (!event || event.treeId !== snapshot.treeId) throw abortTransaction(tx, new Error("出来事が見つかりません。")); tx.objectStore(STORE.events).delete(id); const citations = await allForTree(tx.objectStore(STORE.citations), snapshot.treeId); citations.forEach(function (item) { if (item.targetType === "event" && item.targetId === id) tx.objectStore(STORE.citations).delete(item.id); }); await done; dispatchUndo(snapshot, "出来事削除"); return { snapshotId: snapshot.id }; }

  async function saveCitation(input) { await ensureReady(); const data = await readAll(); const treeId = data.currentTree.id; const source = data.sources.find(function (item) { return item.id === input.sourceId; }); if (!source) throw new Error("引用する資料が見つかりません。"); const targetType = clean(input.targetType, 30); if (!TARGET_TYPES.has(targetType)) throw new Error("引用先の種類が正しくありません。"); const targetId = clean(input.targetId, 150); const targetExists = targetType === "person" ? data.persons.some(function (item) { return item.id === targetId; }) : targetType === "relationship" ? data.relationships.some(function (item) { return item.id === targetId; }) : data.events.some(function (item) { return item.id === targetId; }); if (!targetExists) throw new Error("引用先の情報が見つかりません。"); const db = await connect(); const tx = db.transaction(STORE.citations, "readwrite"); const done = transactionPromise(tx); const store = tx.objectStore(STORE.citations); const existing = input.id ? await requestPromise(store.get(input.id)) : null; const stamp = nowIso(); const citation = { id: clean(input.id || existing && existing.id || makeId("citation"), 150), treeId: treeId, sourceId: source.id, targetType: targetType, targetId: targetId, targetKey: targetType + ":" + targetId, fieldName: clean(valueOr(input, "fieldName", existing && existing.fieldName), 60) || "other", quotedText: clean(valueOr(input, "quotedText", existing && existing.quotedText), 2000), page: clean(valueOr(input, "page", existing && existing.page), 100), note: clean(valueOr(input, "note", existing && existing.note), 1000), verificationStatus: verification(valueOr(input, "verificationStatus", existing && existing.verificationStatus)), createdAt: existing && existing.createdAt || stamp, updatedAt: stamp }; store.put(citation); await done; return citation; }
  async function deleteCitation(id) { await ensureReady(); const db = await connect(); const tx = db.transaction(STORE.citations, "readwrite"); const done = transactionPromise(tx); tx.objectStore(STORE.citations).delete(id); await done; }
  async function citationsFor(targetType, targetId) { const data = await readAll(); return data.citations.filter(function (item) { return item.targetType === targetType && item.targetId === targetId; }); }

  async function duplicateTree(treeId, name) { const data = await readTreeData(treeId, true); if (!data.tree) throw new Error("複製する家系図が見つかりません。"); const newTree = normalizeTree({ name: name || data.tree.name + "（複製）", description: data.tree.description, coverColor: data.tree.coverColor }, null); const personMap = new Map(); data.persons.forEach(function (person) { personMap.set(person.id, makeId("person")); }); const relationMap = new Map(); const sourceMap = new Map(); const eventMap = new Map(); data.sources.forEach(function (source) { sourceMap.set(source.id, makeId("source")); }); data.events.forEach(function (event) { eventMap.set(event.id, makeId("event")); }); const persons = data.persons.map(function (person) { return Object.assign({}, person, { id: personMap.get(person.id), treeId: newTree.id, createdAt: nowIso(), updatedAt: nowIso() }); }); const relationships = data.relationships.map(function (item) { const id = makeId("relation"); relationMap.set(item.id, id); return Object.assign({}, item, { id: id, treeId: newTree.id, fromPersonId: personMap.get(item.fromPersonId), toPersonId: personMap.get(item.toPersonId), createdAt: nowIso(), updatedAt: nowIso() }); }); const sources = data.sources.map(function (source) { return Object.assign({}, source, { id: sourceMap.get(source.id), treeId: newTree.id, attachmentIds: [], createdAt: nowIso(), updatedAt: nowIso() }); }); const events = data.events.map(function (event) { return Object.assign({}, event, { id: eventMap.get(event.id), treeId: newTree.id, personIds: event.personIds.map(function (id) { return personMap.get(id); }).filter(Boolean), sourceIds: (event.sourceIds || []).map(function (id) { return sourceMap.get(id); }).filter(Boolean), createdAt: nowIso(), updatedAt: nowIso() }); }); const citations = data.citations.map(function (citation) { const targetId = citation.targetType === "person" ? personMap.get(citation.targetId) : citation.targetType === "relationship" ? relationMap.get(citation.targetId) : eventMap.get(citation.targetId); return targetId && sourceMap.get(citation.sourceId) ? Object.assign({}, citation, { id: makeId("citation"), treeId: newTree.id, sourceId: sourceMap.get(citation.sourceId), targetId: targetId, targetKey: citation.targetType + ":" + targetId, createdAt: nowIso(), updatedAt: nowIso() }) : null; }).filter(Boolean); const attachments = data.attachments.map(function (item) { const id = makeId("attachment"); const sourceId = sourceMap.get(item.sourceId); const source = sources.find(function (value) { return value.id === sourceId; }); if (source) source.attachmentIds.push(id); return Object.assign({}, item, { id: id, treeId: newTree.id, sourceId: sourceId, createdAt: nowIso() }); }); const db = await connect(); const tx = db.transaction([STORE.trees, STORE.persons, STORE.relationships, STORE.settings, STORE.events, STORE.sources, STORE.citations, STORE.attachments], "readwrite"); const done = transactionPromise(tx); tx.objectStore(STORE.trees).put(newTree); persons.forEach(function (item) { tx.objectStore(STORE.persons).put(item); }); relationships.forEach(function (item) { tx.objectStore(STORE.relationships).put(item); }); events.forEach(function (item) { tx.objectStore(STORE.events).put(item); }); sources.forEach(function (item) { tx.objectStore(STORE.sources).put(item); }); citations.forEach(function (item) { tx.objectStore(STORE.citations).put(item); }); attachments.forEach(function (item) { tx.objectStore(STORE.attachments).put(item); }); const settings = normalizeTreeSettings(data.settings, newTree.id); settings.focusPersonId = personMap.get(data.settings.focusPersonId) || ""; tx.objectStore(STORE.settings).put(settings, treeSettingKey(newTree.id)); const globalSettings = await getGlobalSettings(tx); globalSettings.activeTreeId = newTree.id; tx.objectStore(STORE.settings).put(globalSettings, SETTINGS_KEY); await done; return newTree; }

  async function deleteTree(treeId) { const trees = await listTrees(true); if (trees.length <= 1) throw new Error("最後の1件の家系図は削除できません。先に別の家系図を作成してください。"); const snapshot = await createSnapshot({ treeId: treeId, title: "家系図削除の前", reason: "家系図削除", manual: true }); const db = await connect(); const tx = db.transaction(ALL_STORES, "readwrite"); const done = transactionPromise(tx); try { const tree = await requestPromise(tx.objectStore(STORE.trees).get(treeId)); if (!tree) throw new Error("家系図が見つかりません。"); await deleteRecordsForTree(tx, treeId, [STORE.persons, STORE.relationships, STORE.exclusions, STORE.events, STORE.sources, STORE.citations, STORE.attachments]); tx.objectStore(STORE.settings).delete(treeSettingKey(treeId)); tx.objectStore(STORE.trees).delete(treeId); const globalSettings = await getGlobalSettings(tx); const next = trees.find(function (item) { return item.id !== treeId && !item.isArchived; }) || trees.find(function (item) { return item.id !== treeId; }); globalSettings.activeTreeId = next.id; tx.objectStore(STORE.settings).put(globalSettings, SETTINGS_KEY); await done; return { snapshotId: snapshot.id, nextTreeId: next.id }; } catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; } }

  async function transferPerson(personId, targetTreeId, options) { const sourceData = await readAll(); const target = sourceData.trees.find(function (tree) { return tree.id === targetTreeId; }); if (!target || target.id === sourceData.currentTree.id) throw new Error("移動先・コピー先の家系図を選んでください。"); const mode = options && options.mode === "move" ? "move" : "copy"; const includeRelated = Boolean(options && options.includeRelated); const selected = new Set([personId]); if (includeRelated) { let changed = true; while (changed) { changed = false; sourceData.relationships.forEach(function (item) { if (selected.has(item.fromPersonId) || selected.has(item.toPersonId)) { if (!selected.has(item.fromPersonId)) { selected.add(item.fromPersonId); changed = true; } if (!selected.has(item.toPersonId)) { selected.add(item.toPersonId); changed = true; } } }); } } const persons = sourceData.persons.filter(function (person) { return selected.has(person.id); }); if (!persons.length) throw new Error("人物が見つかりません。"); const personMap = new Map(persons.map(function (person) { return [person.id, makeId("person")]; })); const relationships = sourceData.relationships.filter(function (item) { return selected.has(item.fromPersonId) && selected.has(item.toPersonId); }); const skippedRelationships = sourceData.relationships.filter(function (item) { return (selected.has(item.fromPersonId) || selected.has(item.toPersonId)) && !(selected.has(item.fromPersonId) && selected.has(item.toPersonId)); }).length; const events = sourceData.events.filter(function (event) { return (event.personIds || []).some(function (id) { return selected.has(id); }); }); const eventMap = new Map(events.map(function (event) { return [event.id, makeId("event")]; })); const relevantCitations = sourceData.citations.filter(function (citation) { return citation.targetType === "person" && selected.has(citation.targetId) || citation.targetType === "relationship" && relationships.some(function (item) { return item.id === citation.targetId; }) || citation.targetType === "event" && eventMap.has(citation.targetId); }); const sourceIds = new Set(relevantCitations.map(function (item) { return item.sourceId; })); events.forEach(function (event) { (event.sourceIds || []).forEach(function (id) { sourceIds.add(id); }); }); const sources = sourceData.sources.filter(function (source) { return sourceIds.has(source.id); }); const sourceMap = new Map(sources.map(function (source) { return [source.id, makeId("source")]; })); const relationMap = new Map(); const db = await connect(); const attachmentData = []; for (const source of sources) attachmentData.push.apply(attachmentData, await listAttachments(source.id)); const tx = db.transaction([STORE.persons, STORE.relationships, STORE.events, STORE.sources, STORE.citations, STORE.attachments, STORE.exclusions], "readwrite"); const done = transactionPromise(tx); persons.forEach(function (person) { tx.objectStore(STORE.persons).put(Object.assign({}, person, { id: personMap.get(person.id), treeId: targetTreeId, createdAt: nowIso(), updatedAt: nowIso() })); }); relationships.forEach(function (item) { const id = makeId("relation"); relationMap.set(item.id, id); tx.objectStore(STORE.relationships).put(Object.assign({}, item, { id: id, treeId: targetTreeId, fromPersonId: personMap.get(item.fromPersonId), toPersonId: personMap.get(item.toPersonId), createdAt: nowIso(), updatedAt: nowIso() })); }); events.forEach(function (event) { tx.objectStore(STORE.events).put(Object.assign({}, event, { id: eventMap.get(event.id), treeId: targetTreeId, personIds: event.personIds.map(function (id) { return personMap.get(id); }).filter(Boolean), sourceIds: (event.sourceIds || []).map(function (id) { return sourceMap.get(id); }).filter(Boolean), createdAt: nowIso(), updatedAt: nowIso() })); }); const sourceCopies = sources.map(function (source) { return Object.assign({}, source, { id: sourceMap.get(source.id), treeId: targetTreeId, attachmentIds: [], createdAt: nowIso(), updatedAt: nowIso() }); }); const attachmentMap = new Map(); attachmentData.forEach(function (item) { const id = makeId("attachment"); attachmentMap.set(item.id, id); const sourceId = sourceMap.get(item.sourceId); const source = sourceCopies.find(function (value) { return value.id === sourceId; }); if (source) source.attachmentIds.push(id); tx.objectStore(STORE.attachments).put(Object.assign({}, item, { id: id, treeId: targetTreeId, sourceId: sourceId, createdAt: nowIso() })); }); sourceCopies.forEach(function (item) { tx.objectStore(STORE.sources).put(item); }); relevantCitations.forEach(function (citation) { const targetId = citation.targetType === "person" ? personMap.get(citation.targetId) : citation.targetType === "relationship" ? relationMap.get(citation.targetId) : eventMap.get(citation.targetId); if (targetId && sourceMap.get(citation.sourceId)) tx.objectStore(STORE.citations).put(Object.assign({}, citation, { id: makeId("citation"), treeId: targetTreeId, sourceId: sourceMap.get(citation.sourceId), targetId: targetId, targetKey: citation.targetType + ":" + targetId, createdAt: nowIso(), updatedAt: nowIso() })); }); if (mode === "move") { persons.forEach(function (person) { tx.objectStore(STORE.persons).delete(person.id); }); sourceData.relationships.filter(function (item) { return selected.has(item.fromPersonId) || selected.has(item.toPersonId); }).forEach(function (item) { tx.objectStore(STORE.relationships).delete(item.id); }); events.forEach(function (event) { tx.objectStore(STORE.events).delete(event.id); }); relevantCitations.forEach(function (citation) { tx.objectStore(STORE.citations).delete(citation.id); }); } await done; return { copiedPersonIds: Array.from(personMap.values()), copiedCount: persons.length, skippedRelationships: skippedRelationships, mode: mode }; }

  async function getStatistics() { const data = await readAll(); const persons = data.persons; const birthYears = persons.map(function (person) { return person.birthDate && /^\d{4}/.test(person.birthDate) ? Number(person.birthDate.slice(0, 4)) : null; }).filter(Number.isFinite); const connected = new Set(); data.relationships.forEach(function (item) { connected.add(item.fromPersonId); connected.add(item.toPersonId); }); const cited = new Set(data.citations.filter(function (item) { return item.targetType === "person"; }).map(function (item) { return item.targetId; })); const duplicateCount = Legacy.detectDuplicateCandidates(persons, data.relationships, data.duplicateExclusions).length; const generations = new Map(); const roots = persons.filter(function (person) { return !data.relationships.some(function (item) { return item.type === "parent-child" && item.toPersonId === person.id; }); }); const queue = roots.map(function (person) { return [person.id, 0]; }); while (queue.length) { const entry = queue.shift(); if (generations.has(entry[0]) && generations.get(entry[0]) >= entry[1]) continue; generations.set(entry[0], entry[1]); data.relationships.filter(function (item) { return item.type === "parent-child" && item.fromPersonId === entry[0]; }).forEach(function (item) { queue.push([item.toPersonId, entry[1] + 1]); }); } return { persons: persons.length, living: persons.filter(function (p) { return !p.isDeceased; }).length, deceased: persons.filter(function (p) { return p.isDeceased; }).length, generations: generations.size ? Math.max.apply(null, Array.from(generations.values())) + 1 : 0, oldestBirthYear: birthYears.length ? Math.min.apply(null, birthYears) : null, newestBirthYear: birthYears.length ? Math.max.apply(null, birthYears) : null, relationships: data.relationships.length, citedPersons: cited.size, unconfirmed: persons.filter(function (p) { return p.verificationStatus !== "confirmed"; }).length + data.relationships.filter(function (r) { return r.verificationStatus !== "confirmed"; }).length + data.events.filter(function (e) { return e.verificationStatus !== "confirmed"; }).length, photoRate: persons.length ? Math.round(persons.filter(function (p) { return p.photo; }).length / persons.length * 100) : 0, birthRate: persons.length ? Math.round(persons.filter(function (p) { return p.birthDate; }).length / persons.length * 100) : 0, unconnected: persons.filter(function (p) { return !connected.has(p.id); }).length, duplicateCandidates: duplicateCount, sources: data.sources.length, events: data.events.length };
  }

  function blobToDataUrl(blob) { return new Promise(function (resolve, reject) { const reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = function () { reject(new Error("添付ファイルをバックアップへ変換できませんでした。")); }; reader.readAsDataURL(blob); }); }
  function dataUrlToBlob(dataUrl) { const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl || ""); if (!match) throw new Error("添付ファイルのバックアップ形式が正しくありません。"); const binary = atob(match[2]); const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index); return new Blob([bytes], { type: match[1] }); }

  async function createBackup(options) {
    await ensureReady();
    const scopeTreeId = options && options.treeId;
    const db = await connect();
    const tx = db.transaction(ALL_STORES, "readonly");
    // Queue every IndexedDB request before converting Blob values. FileReader is
    // asynchronous and would otherwise allow the readonly transaction to finish.
    const requests = {
      trees: requestPromise(tx.objectStore(STORE.trees).getAll()),
      persons: requestPromise(tx.objectStore(STORE.persons).getAll()),
      relationships: requestPromise(tx.objectStore(STORE.relationships).getAll()),
      events: requestPromise(tx.objectStore(STORE.events).getAll()),
      sources: requestPromise(tx.objectStore(STORE.sources).getAll()),
      citations: requestPromise(tx.objectStore(STORE.citations).getAll()),
      attachments: requestPromise(tx.objectStore(STORE.attachments).getAll()),
      exclusions: requestPromise(tx.objectStore(STORE.exclusions).getAll()),
      settings: requestPromise(tx.objectStore(STORE.settings).getAll()),
      settingKeys: requestPromise(tx.objectStore(STORE.settings).getAllKeys()),
      snapshots: options && options.includeSnapshots ? requestPromise(tx.objectStore(STORE.snapshots).getAll()) : Promise.resolve([])
    };
    const values = {};
    await Promise.all(Object.keys(requests).map(async function (key) { values[key] = await requests[key]; }));
    const trees = values.trees.filter(function (tree) { return !scopeTreeId || tree.id === scopeTreeId; });
    if (scopeTreeId && !trees.length) throw new Error("書き出す家系図が見つかりません。");
    const treeIds = new Set(trees.map(function (tree) { return tree.id; }));
    function filtered(items) { return items.filter(function (item) { return treeIds.has(item.treeId); }); }
    const settingMap = new Map(values.settingKeys.map(function (key, index) { return [key, values.settings[index]]; }));
    const settings = {};
    trees.forEach(function (tree) { settings[tree.id] = normalizeTreeSettings(settingMap.get(treeSettingKey(tree.id)), tree.id); });
    const serializedAttachments = [];
    for (const item of filtered(values.attachments)) {
      serializedAttachments.push(Object.assign({}, cloneWithoutBlob(item), { data: await blobToDataUrl(item.blob) }));
    }
    const backup = {
      format: "family-tree-note-backup", appName: "家系図ノート", appVersion: APP_VERSION,
      schemaVersion: 4, exportedAt: nowIso(), scope: scopeTreeId ? "tree" : "all",
      trees: trees, persons: filtered(values.persons), relationships: filtered(values.relationships),
      events: filtered(values.events), sources: filtered(values.sources), citations: filtered(values.citations),
      attachments: serializedAttachments, settings: settings, duplicateExclusions: filtered(values.exclusions)
    };
    if (options && options.includeSnapshots) backup.snapshots = filtered(values.snapshots);
    return backup;
  }

  function validateBackupShape(source) {
    if (!source || !Array.isArray(source.persons) || !Array.isArray(source.relationships)) throw new Error("人物・関係の配列がないため復元できません。");
    if (source.trees !== undefined && (!Array.isArray(source.trees) || !source.trees.length)) throw new Error("家系図の配列が正しくありません。");
    ["events", "sources", "citations", "attachments", "duplicateExclusions"].forEach(function (key) {
      if (source[key] !== undefined && !Array.isArray(source[key])) throw new Error(key + "は配列である必要があります。");
    });
    function uniqueIds(items, label) {
      const ids = new Set();
      (items || []).forEach(function (item) {
        if (!item || typeof item.id !== "string" || !item.id.trim()) throw new Error(label + "のIDがありません。");
        if (ids.has(item.id)) throw new Error(label + "IDが重複しています: " + item.id);
        ids.add(item.id);
      });
      return ids;
    }
    const personIds = uniqueIds(source.persons, "人物");
    const relationshipIds = uniqueIds(source.relationships, "関係");
    const sourceIds = uniqueIds(source.sources || [], "資料");
    const eventIds = uniqueIds(source.events || [], "出来事");
    uniqueIds(source.citations || [], "引用"); uniqueIds(source.attachments || [], "添付");
    const treeIds = Array.isArray(source.trees) ? uniqueIds(source.trees, "家系図") : null;
    if (treeIds) [source.persons, source.relationships, source.events || [], source.sources || [], source.citations || [], source.attachments || [], source.duplicateExclusions || []].forEach(function (items) { items.forEach(function (item) { if (!treeIds.has(item.treeId)) throw new Error("存在しない家系図を参照するデータがあります。"); }); });
    const personTree = new Map(source.persons.map(function (person) { return [person.id, person.treeId || "legacy"]; }));
    const relationshipTree = new Map(source.relationships.map(function (item) { return [item.id, item.treeId || "legacy"]; }));
    const eventTree = new Map((source.events || []).map(function (item) { return [item.id, item.treeId || "legacy"]; }));
    const sourceTree = new Map((source.sources || []).map(function (item) { return [item.id, item.treeId || "legacy"]; }));
    source.relationships.forEach(function (item) {
      if (!personIds.has(item.fromPersonId) || !personIds.has(item.toPersonId)) throw new Error("存在しない人物を参照する関係があります。");
      if (item.fromPersonId === item.toPersonId) throw new Error("自己関係が含まれています。");
      if (personTree.get(item.fromPersonId) !== personTree.get(item.toPersonId) || item.treeId && item.treeId !== personTree.get(item.fromPersonId)) throw new Error("異なる家系図の人物を結ぶ関係があります。");
    });
    (source.events || []).forEach(function (item) {
      if (!Array.isArray(item.personIds) || item.personIds.some(function (id) { return !personIds.has(id); })) throw new Error("出来事が存在しない人物を参照しています。");
      if (item.personIds.some(function (id) { return personTree.get(id) !== (item.treeId || "legacy"); })) throw new Error("異なる家系図の人物を同じ出来事へ登録できません。");
      if (item.sourceIds !== undefined && (!Array.isArray(item.sourceIds) || item.sourceIds.some(function (id) { return !sourceIds.has(id); }))) throw new Error("出来事が存在しない資料を参照しています。");
      if ((item.sourceIds || []).some(function (id) { return sourceTree.get(id) !== (item.treeId || "legacy"); })) throw new Error("出来事が別の家系図の資料を参照しています。");
    });
    (source.citations || []).forEach(function (item) {
      if (!sourceIds.has(item.sourceId)) throw new Error("引用が存在しない資料を参照しています。");
      const targets = item.targetType === "person" ? personIds : item.targetType === "event" ? eventIds : relationshipIds;
      if (!targets.has(item.targetId)) throw new Error("引用先の情報が見つかりません。");
      const targetTree = item.targetType === "person" ? personTree.get(item.targetId) : item.targetType === "event" ? eventTree.get(item.targetId) : relationshipTree.get(item.targetId);
      if (sourceTree.get(item.sourceId) !== targetTree || item.treeId && item.treeId !== targetTree) throw new Error("引用と資料の家系図が一致しません。");
    });
    (source.attachments || []).forEach(function (item) {
      if (!sourceIds.has(item.sourceId)) throw new Error("添付ファイルの資料が見つかりません。");
      if (item.treeId && item.treeId !== sourceTree.get(item.sourceId)) throw new Error("添付ファイルと資料の家系図が一致しません。");
      if (Number(item.size || 0) > MAX_ATTACHMENT_BYTES) throw new Error("20MBを超える添付ファイルは復元できません。");
    });
    return source;
  }

  function preservingIdBundle(source, treeName) {
    const legacy = !Array.isArray(source.trees);
    const oldTrees = legacy ? [{ id: "legacy", name: treeName || "追加した家系図", rootPersonId: source.settings && source.settings.focusPersonId || "" }] : source.trees;
    const treeMap = new Map(oldTrees.map(function (tree) { return [tree.id, makeId("tree")]; }));
    const sourceTreeId = function (item) { return treeMap.get(item.treeId || oldTrees[0].id) || treeMap.get(oldTrees[0].id); };
    const trees = oldTrees.map(function (tree) { return normalizeTree(Object.assign({}, tree, { id: treeMap.get(tree.id), name: oldTrees.length === 1 && treeName ? treeName : tree.name, isArchived: false }), null); });
    const persons = source.persons.map(function (person) { const treeId = sourceTreeId(person); return normalizePerson(Object.assign({}, person, { treeId: treeId }), null, treeId); });
    const relationships = source.relationships.map(function (item) { const treeId = sourceTreeId(item); const status = item.type === "partner" && !item.status ? "current" : item.status; return normalizeRelationship(Object.assign({}, item, { treeId: treeId, status: status }), null, treeId); });
    const sources = (source.sources || []).map(function (item) { const treeId = sourceTreeId(item); return normalizeSource(Object.assign({}, item, { treeId: treeId }), null, treeId); });
    const events = (source.events || []).map(function (item) { const treeId = sourceTreeId(item); return normalizeEvent(Object.assign({}, item, { treeId: treeId }), null, treeId); });
    const citations = (source.citations || []).map(function (item) { const treeId = sourceTreeId(item); return Object.assign({}, item, { treeId: treeId, targetKey: item.targetType + ":" + item.targetId, verificationStatus: verification(item.verificationStatus), updatedAt: nowIso() }); });
    const attachments = (source.attachments || []).map(function (item) { return Object.assign({}, item, { treeId: sourceTreeId(item), blob: dataUrlToBlob(item.data), thumbnail: clean(item.thumbnail, 1000000) }); });
    const settings = {};
    trees.forEach(function (tree, index) { const oldId = oldTrees[index].id; const oldSettings = legacy ? source.settings : source.settings && source.settings[oldId]; settings[tree.id] = normalizeTreeSettings(oldSettings, tree.id); });
    const exclusions = (source.duplicateExclusions || []).map(function (item) { const treeId = sourceTreeId(item); return Object.assign({}, item, { id: treeId + "|" + [item.personAId, item.personBId].sort().map(encodeURIComponent).join("|"), treeId: treeId }); });
    return { trees: trees, persons: persons, relationships: relationships, events: events, sources: sources, citations: citations, attachments: attachments, settings: settings, duplicateExclusions: exclusions };
  }

  function remapImportedBundle(source, treeName) { const legacy = !Array.isArray(source.trees); const oldTrees = legacy ? [{ id: "legacy", name: treeName || "復元した家系図", description: "", rootPersonId: source.settings && source.settings.focusPersonId || "", coverColor: "#557c64", isArchived: false }] : source.trees; const treeMap = new Map(oldTrees.map(function (tree) { return [tree.id, makeId("tree")]; })); const personMap = new Map((source.persons || []).map(function (person) { return [person.id, makeId("person")]; })); const relationMap = new Map(); const eventMap = new Map(); const sourceMap = new Map(); (source.events || []).forEach(function (event) { eventMap.set(event.id, makeId("event")); }); (source.sources || []).forEach(function (item) { sourceMap.set(item.id, makeId("source")); }); const trees = oldTrees.map(function (tree) { const id = treeMap.get(tree.id); return normalizeTree(Object.assign({}, tree, { id: id, name: oldTrees.length === 1 && treeName ? treeName : tree.name, rootPersonId: personMap.get(tree.rootPersonId) || "", isArchived: false }), null); }); const sourceTreeId = function (item) { return treeMap.get(item.treeId || oldTrees[0].id) || trees[0].id; }; const persons = (source.persons || []).map(function (person) { return normalizePerson(Object.assign({}, person, { id: personMap.get(person.id), treeId: sourceTreeId(person) }), null, sourceTreeId(person)); }); const relationships = (source.relationships || []).map(function (item) { const id = makeId("relation"); relationMap.set(item.id, id); return normalizeRelationship(Object.assign({}, item, { id: id, treeId: sourceTreeId(item), fromPersonId: personMap.get(item.fromPersonId), toPersonId: personMap.get(item.toPersonId) }), null, sourceTreeId(item)); }); const sources = (source.sources || []).map(function (item) { const treeId = sourceTreeId(item); return normalizeSource(Object.assign({}, item, { id: sourceMap.get(item.id), treeId: treeId, attachmentIds: [] }), null, treeId); }); const events = (source.events || []).map(function (event) { const treeId = sourceTreeId(event); return normalizeEvent(Object.assign({}, event, { id: eventMap.get(event.id), treeId: treeId, personIds: (event.personIds || []).map(function (id) { return personMap.get(id); }).filter(Boolean), sourceIds: (event.sourceIds || []).map(function (id) { return sourceMap.get(id); }).filter(Boolean) }), null, treeId); }); const citations = (source.citations || []).map(function (item) { const targetId = item.targetType === "person" ? personMap.get(item.targetId) : item.targetType === "relationship" ? relationMap.get(item.targetId) : eventMap.get(item.targetId); const treeId = sourceTreeId(item); return targetId && sourceMap.get(item.sourceId) ? Object.assign({}, item, { id: makeId("citation"), treeId: treeId, sourceId: sourceMap.get(item.sourceId), targetId: targetId, targetKey: item.targetType + ":" + targetId, verificationStatus: verification(item.verificationStatus), createdAt: clean(item.createdAt, 40) || nowIso(), updatedAt: nowIso() }) : null; }).filter(Boolean); const attachments = (source.attachments || []).map(function (item) { const treeId = sourceTreeId(item); const id = makeId("attachment"); const sourceId = sourceMap.get(item.sourceId); const sourceCopy = sources.find(function (value) { return value.id === sourceId; }); if (sourceCopy) sourceCopy.attachmentIds.push(id); return { id: id, treeId: treeId, sourceId: sourceId, fileName: clean(item.fileName, 240), mimeType: clean(item.mimeType, 100), size: Number(item.size) || 0, blob: dataUrlToBlob(item.data), thumbnail: clean(item.thumbnail, 1000000), createdAt: clean(item.createdAt, 40) || nowIso() }; }).filter(function (item) { return item.sourceId; }); const settings = {}; trees.forEach(function (tree, index) { const oldId = oldTrees[index].id; const oldSettings = legacy ? source.settings : source.settings && source.settings[oldId]; settings[tree.id] = normalizeTreeSettings(oldSettings, tree.id); settings[tree.id].focusPersonId = personMap.get(oldSettings && oldSettings.focusPersonId) || ""; }); const exclusions = (source.duplicateExclusions || []).map(function (item) { const a = personMap.get(item.personAId); const b = personMap.get(item.personBId); const treeId = sourceTreeId(item); return a && b ? { id: treeId + "|" + [a, b].sort().map(encodeURIComponent).join("|"), treeId: treeId, personAId: a, personBId: b, createdAt: clean(item.createdAt, 40) || nowIso() } : null; }).filter(Boolean); return { trees: trees, persons: persons, relationships: relationships, events: events, sources: sources, citations: citations, attachments: attachments, settings: settings, duplicateExclusions: exclusions };
  }

  async function restoreBackup(value, options) { if (!value || typeof value !== "object") throw new Error("バックアップの内容が正しくありません。"); const legacySource = value.data && Number(value.schemaVersion) === 1 ? value.data : value; if (value.format !== "family-tree-note-backup" || !Array.isArray(legacySource.persons) || !Array.isArray(legacySource.relationships)) throw new Error("家系図ノートのバックアップではありません。"); await ensureReady(); const current = await readAll(); const safety = await createSnapshot({ treeId: current.currentTree.id, title: "JSON復元の前", reason: "JSON復元", manual: false }); const bundle = remapImportedBundle(legacySource, options && options.treeName || (Number(value.schemaVersion) < 4 ? "復元した家系図" : "")); bundle.trees.forEach(function (tree) { validateTreeRelationships(bundle.persons.filter(function (person) { return person.treeId === tree.id; }), bundle.relationships.filter(function (item) { return item.treeId === tree.id; })); }); const db = await connect(); const tx = db.transaction([STORE.trees, STORE.persons, STORE.relationships, STORE.settings, STORE.exclusions, STORE.events, STORE.sources, STORE.citations, STORE.attachments], "readwrite"); const done = transactionPromise(tx); bundle.trees.forEach(function (tree) { tx.objectStore(STORE.trees).put(tree); tx.objectStore(STORE.settings).put(bundle.settings[tree.id], treeSettingKey(tree.id)); }); ["persons", "relationships", "events", "sources", "citations", "attachments"].forEach(function (key) { bundle[key].forEach(function (item) { tx.objectStore(STORE[key]).put(item); }); }); bundle.duplicateExclusions.forEach(function (item) { tx.objectStore(STORE.exclusions).put(item); }); const globalSettings = await getGlobalSettings(tx); globalSettings.activeTreeId = bundle.trees[0].id; tx.objectStore(STORE.settings).put(globalSettings, SETTINGS_KEY); await done; dispatchUndo(safety, "JSON復元"); return readAll(); }

  async function importGedcomData(parsed, treeName) { if (!parsed || !Array.isArray(parsed.persons) || !Array.isArray(parsed.relationships)) throw new Error("GEDCOMの解析結果が正しくありません。"); await ensureReady(); const current = await readAll(); await createSnapshot({ treeId: current.currentTree.id, title: "GEDCOM取込の前", reason: "GEDCOMインポート", manual: false }); const legacy = { persons: parsed.persons, relationships: parsed.relationships, events: parsed.events || [], sources: parsed.sources || [], citations: parsed.citations || [], duplicateExclusions: [], settings: { focusPersonId: parsed.persons[0] && parsed.persons[0].id || "" } }; const bundle = remapImportedBundle(legacy, treeName || parsed.treeName || "GEDCOM取込"); bundle.trees.forEach(function (tree) { validateTreeRelationships(bundle.persons.filter(function (person) { return person.treeId === tree.id; }), bundle.relationships.filter(function (item) { return item.treeId === tree.id; })); }); const db = await connect(); const tx = db.transaction([STORE.trees, STORE.persons, STORE.relationships, STORE.settings, STORE.events, STORE.sources, STORE.citations], "readwrite"); const done = transactionPromise(tx); try { const tree = bundle.trees[0]; tx.objectStore(STORE.trees).put(tree); tx.objectStore(STORE.settings).put(bundle.settings[tree.id], treeSettingKey(tree.id)); bundle.persons.forEach(function (item) { tx.objectStore(STORE.persons).put(item); }); bundle.relationships.forEach(function (item) { tx.objectStore(STORE.relationships).put(item); }); bundle.events.forEach(function (item) { tx.objectStore(STORE.events).put(item); }); bundle.sources.forEach(function (item) { tx.objectStore(STORE.sources).put(item); }); bundle.citations.forEach(function (item) { tx.objectStore(STORE.citations).put(item); }); const globalSettings = await getGlobalSettings(tx); globalSettings.activeTreeId = tree.id; tx.objectStore(STORE.settings).put(globalSettings, SETTINGS_KEY); await done; return readAll(); } catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; } }

  async function resetSampleData() { const current = await readAll(); const snapshot = await createSnapshot({ treeId: current.currentTree.id, title: "サンプル再登録の前", reason: "大量削除", manual: false }); const sample = Legacy.sampleDataset(); const treeId = current.currentTree.id; sample.persons = sample.persons.map(function (person) { return Object.assign({}, person, { treeId: treeId, verificationStatus: "confirmed" }); }); sample.relationships = sample.relationships.map(function (item) { return Object.assign({}, item, { treeId: treeId, verificationStatus: "confirmed" }); }); const db = await connect(); const tx = db.transaction([STORE.persons, STORE.relationships, STORE.settings, STORE.exclusions, STORE.events, STORE.sources, STORE.citations, STORE.attachments], "readwrite"); const done = transactionPromise(tx); await deleteRecordsForTree(tx, treeId, [STORE.persons, STORE.relationships, STORE.exclusions, STORE.events, STORE.sources, STORE.citations, STORE.attachments]); sample.persons.forEach(function (item) { tx.objectStore(STORE.persons).put(item); }); sample.relationships.forEach(function (item) { tx.objectStore(STORE.relationships).put(item); }); tx.objectStore(STORE.settings).put(normalizeTreeSettings(Object.assign({}, sample.settings, { focusPersonId: "sample-takashi" }), treeId), treeSettingKey(treeId)); await done; dispatchUndo(snapshot, "サンプル再登録"); return readAll(); }
  async function clearAll() { const current = await readAll(); await createSnapshot({ treeId: current.currentTree.id, title: "全データ削除の前", reason: "大量削除", manual: true }); const db = await connect(); const tx = db.transaction(ALL_STORES, "readwrite"); const done = transactionPromise(tx); ALL_STORES.filter(function (name) { return name !== STORE.snapshots; }).forEach(function (name) { tx.objectStore(name).clear(); }); const stamp = nowIso(); const tree = { id: DEFAULT_TREE_ID, name: "家族の家系図", description: "", rootPersonId: "", coverColor: "#557c64", createdAt: stamp, updatedAt: stamp, isArchived: false }; tx.objectStore(STORE.trees).put(tree); tx.objectStore(STORE.settings).put({ activeTreeId: tree.id, schemaVersion: 4, migrationV4Complete: true }, SETTINGS_KEY); tx.objectStore(STORE.settings).put(defaultTreeSettings(tree.id), treeSettingKey(tree.id)); await done; return readAll(); }
  async function initialize() { await ensureReady(); return readAll(); }

  async function restoreBackupV4(value, options) {
    if (!value || typeof value !== "object" || value.format !== "family-tree-note-backup") throw new Error("家系図ノートのバックアップではありません。");
    const source = validateBackupShape(value.data && Number(value.schemaVersion) === 1 ? value.data : value);
    const restoreOptions = options || {};
    const mode = new Set(["new", "append", "replace"]).has(restoreOptions.mode) ? restoreOptions.mode : "new";
    if (mode === "replace" && Array.isArray(source.trees) && source.trees.length !== 1) throw new Error("現在の家系図を置き換える場合は、家系図単体バックアップを選んでください。");
    await ensureReady();
    const current = await readAll();
    const safety = await createSnapshot({ treeId: current.currentTree.id, title: "JSON復元の前", reason: "JSON復元", manual: false });
    const suggestedName = restoreOptions.treeName || (Number(value.schemaVersion) < 4 ? "復元した家系図" : "");
    const bundle = mode === "append" ? preservingIdBundle(source, suggestedName) : remapImportedBundle(source, suggestedName);
    bundle.trees.forEach(function (tree) {
      validateTreeRelationships(bundle.persons.filter(function (person) { return person.treeId === tree.id; }), bundle.relationships.filter(function (item) { return item.treeId === tree.id; }));
    });
    const db = await connect();
    if (mode === "append") {
      const collisionStores = [STORE.persons, STORE.relationships, STORE.events, STORE.sources, STORE.citations, STORE.attachments];
      const checkTx = db.transaction(collisionStores, "readonly");
      const existingKeys = await Promise.all(collisionStores.map(function (storeName) { return requestPromise(checkTx.objectStore(storeName).getAllKeys()); }));
      const bundleKeys = ["persons", "relationships", "events", "sources", "citations", "attachments"];
      bundleKeys.forEach(function (key, index) {
        const existing = new Set(existingKeys[index]);
        const collision = bundle[key].find(function (item) { return existing.has(item.id); });
        if (collision) throw new Error("同じIDが既に存在するため追加できません: " + collision.id);
      });
    }
    const stores = [STORE.trees, STORE.persons, STORE.relationships, STORE.settings, STORE.exclusions, STORE.events, STORE.sources, STORE.citations, STORE.attachments];
    const tx = db.transaction(stores, "readwrite");
    const done = transactionPromise(tx);
    try {
      let activeId = bundle.trees[0].id;
      if (mode === "replace") {
        const importedId = bundle.trees[0].id;
        activeId = current.currentTree.id;
        await deleteRecordsForTree(tx, activeId, [STORE.persons, STORE.relationships, STORE.exclusions, STORE.events, STORE.sources, STORE.citations, STORE.attachments]);
        const importedTree = Object.assign({}, bundle.trees[0], { id: activeId, createdAt: current.currentTree.createdAt, updatedAt: nowIso(), isArchived: false });
        tx.objectStore(STORE.trees).put(importedTree);
        ["persons", "relationships", "events", "sources", "citations", "attachments"].forEach(function (key) {
          bundle[key].filter(function (item) { return item.treeId === importedId; }).forEach(function (item) { tx.objectStore(STORE[key]).put(Object.assign({}, item, { treeId: activeId })); });
        });
        bundle.duplicateExclusions.filter(function (item) { return item.treeId === importedId; }).forEach(function (item) { tx.objectStore(STORE.exclusions).put(Object.assign({}, item, { id: activeId + "|" + [item.personAId, item.personBId].sort().map(encodeURIComponent).join("|"), treeId: activeId })); });
        tx.objectStore(STORE.settings).put(normalizeTreeSettings(bundle.settings[importedId], activeId), treeSettingKey(activeId));
      } else {
        bundle.trees.forEach(function (tree) { tx.objectStore(STORE.trees).put(tree); tx.objectStore(STORE.settings).put(bundle.settings[tree.id], treeSettingKey(tree.id)); });
        ["persons", "relationships", "events", "sources", "citations", "attachments"].forEach(function (key) { bundle[key].forEach(function (item) { tx.objectStore(STORE[key]).put(item); }); });
        bundle.duplicateExclusions.forEach(function (item) { tx.objectStore(STORE.exclusions).put(item); });
      }
      const globalSettings = await getGlobalSettings(tx); globalSettings.activeTreeId = activeId; globalSettings.schemaVersion = 4; tx.objectStore(STORE.settings).put(globalSettings, SETTINGS_KEY);
      await done; dispatchUndo(safety, "JSON復元"); return readAll();
    } catch (error) { abortTransaction(tx, error); try { await done; } catch (ignored) {} throw error; }
  }

  function validateWholeDataset(persons, relationships, settings, exclusions) { const groups = new Map(); persons.forEach(function (person) { const id = person.treeId || "legacy"; if (!groups.has(id)) groups.set(id, { persons: [], relationships: [] }); groups.get(id).persons.push(person); }); relationships.forEach(function (item) { const id = item.treeId || "legacy"; if (!groups.has(id)) groups.set(id, { persons: [], relationships: [] }); groups.get(id).relationships.push(item); }); groups.forEach(function (group) { validateTreeRelationships(group.persons, group.relationships); }); return true; }

  globalThis.FamilyTreeDB = Object.freeze(Object.assign({}, Legacy, {
    APP_VERSION: APP_VERSION, SCHEMA_VERSION: SCHEMA_VERSION, DB_VERSION: DB_VERSION, DEFAULT_TREE_ID: DEFAULT_TREE_ID,
    MAX_ATTACHMENT_BYTES: MAX_ATTACHMENT_BYTES, MAX_SOURCE_ATTACHMENT_BYTES: MAX_SOURCE_ATTACHMENT_BYTES,
    initialize: initialize, readAll: readAll, readTreeData: readTreeData, savePerson: savePerson, saveRelativePerson: saveRelativePerson, deletePerson: deletePerson,
    saveRelationship: saveRelationship, deleteRelationship: deleteRelationship, saveRelationshipOrders: saveRelationshipOrders, saveSettings: saveSettings,
    saveDuplicateExclusion: saveDuplicateExclusion, mergePersons: mergePersons, resetSampleData: resetSampleData, clearAll: clearAll, validateWholeDataset: validateWholeDataset,
    listTrees: listTrees, createTree: createTree, updateTree: updateTree, switchTree: switchTree, setTreeArchived: setTreeArchived, duplicateTree: duplicateTree, deleteTree: deleteTree, transferPerson: transferPerson,
    listSources: listSources, saveSource: saveSource, deleteSource: deleteSource, saveAttachment: saveAttachment, listAttachments: listAttachments, getAttachment: getAttachment, deleteAttachment: deleteAttachment,
    saveEvent: saveEvent, deleteEvent: deleteEvent, saveCitation: saveCitation, deleteCitation: deleteCitation, citationsFor: citationsFor,
    createSnapshot: createSnapshot, listSnapshots: listSnapshots, deleteSnapshot: deleteSnapshot, restoreSnapshot: restoreSnapshot, undoLast: undoLast,
    getStatistics: getStatistics, createBackup: createBackup, restoreBackup: restoreBackupV4, importGedcomData: importGedcomData
  }));
}());
