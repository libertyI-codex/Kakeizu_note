(function () {
  "use strict";

  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const MONTH_INDEX = Object.freeze(MONTHS.reduce(function (result, month, index) { result[month] = index + 1; return result; }, {}));
  const STANDARD_EVENT_TAGS = Object.freeze({ birth: "BIRT", death: "DEAT", marriage: "MARR", divorce: "DIV", adoption: "ADOP", residence: "RESI", education: "EDUC", occupation: "OCCU", military: "_MILI", immigration: "IMMI", illness: "_ILLN", award: "_AWARD", burial: "BURI", custom: "EVEN" });
  const TAG_TO_EVENT = Object.freeze(Object.keys(STANDARD_EVENT_TAGS).reduce(function (result, key) { result[STANDARD_EVENT_TAGS[key]] = key; return result; }, {}));
  const SUPPORTED = new Set(["HEAD", "SOUR", "GEDC", "VERS", "FORM", "CHAR", "LANG", "FILE", "DATE", "TIME", "SUBM", "INDI", "FAM", "NAME", "GIVN", "SURN", "SEX", "BIRT", "DEAT", "PLAC", "FAMS", "FAMC", "HUSB", "WIFE", "CHIL", "MARR", "DIV", "NOTE", "TITL", "AUTH", "PUBL", "PAGE", "QUAY", "DATA", "TEXT", "CONC", "CONT", "TRLR", "ADOP", "RESI", "EDUC", "OCCU", "IMMI", "BURI", "EVEN", "TYPE", "_MILI", "_ILLN", "_AWARD", "_NICK", "_OTHER_NAMES", "_VERIFY", "_PRECISION", "_APPROX", "_SENSITIVE"]);

  function cleanLine(value) { return String(value === null || value === undefined ? "" : value).replace(/[\r\n]+/g, " ").trim(); }
  function slug(value) { return cleanLine(value).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "家系図"; }
  function gedDate(value, precision, approximate) {
    if (!value) return "";
    const parts = value.split("-").map(Number); let text = "";
    if (precision === "day") text = parts[2] + " " + MONTHS[parts[1] - 1] + " " + parts[0];
    else if (precision === "month") text = MONTHS[parts[1] - 1] + " " + parts[0];
    else text = String(parts[0]);
    return approximate ? "ABT " + text : text;
  }
  function parseGedDate(value) {
    let text = cleanLine(value).toUpperCase(); let approximate = false;
    if (/^(ABT|EST|CAL)\s+/.test(text)) { approximate = true; text = text.replace(/^(ABT|EST|CAL)\s+/, ""); }
    let match = /^(\d{1,2})\s+([A-Z]{3})\s+(\d{4})$/.exec(text);
    if (match && MONTH_INDEX[match[2]]) return { value: match[3] + "-" + String(MONTH_INDEX[match[2]]).padStart(2, "0") + "-" + String(Number(match[1])).padStart(2, "0"), precision: "day", approximate: approximate };
    match = /^([A-Z]{3})\s+(\d{4})$/.exec(text);
    if (match && MONTH_INDEX[match[1]]) return { value: match[2] + "-" + String(MONTH_INDEX[match[1]]).padStart(2, "0"), precision: "month", approximate: approximate };
    match = /^(\d{4})$/.exec(text);
    if (match) return { value: match[1], precision: "year", approximate: approximate };
    return { value: "", precision: "unknown", approximate: approximate, warning: value ? "解釈できない日付: " + value : "" };
  }
  function verificationQuay(value) { return { confirmed: "3", probable: "2", unconfirmed: "1", disputed: "0" }[value] || "1"; }
  function quayVerification(value) { return { "3": "confirmed", "2": "probable", "1": "unconfirmed", "0": "disputed" }[String(value)] || "unconfirmed"; }
  function addNote(lines, level, value) {
    const text = String(value || "").replace(/\r/g, ""); if (!text) return;
    text.split("\n").forEach(function (part, index) { lines.push(level + " " + (index ? "CONT" : "NOTE") + (part ? " " + cleanLine(part) : "")); });
  }
  function citeLines(lines, level, citations, sourceRefs) {
    (citations || []).forEach(function (citation) {
      const ref = sourceRefs.get(citation.sourceId); if (!ref) return;
      lines.push(level + " SOUR " + ref);
      if (citation.page) lines.push((level + 1) + " PAGE " + cleanLine(citation.page));
      lines.push((level + 1) + " QUAY " + verificationQuay(citation.verificationStatus));
      if (citation.quotedText) { lines.push((level + 1) + " DATA"); lines.push((level + 2) + " TEXT " + cleanLine(citation.quotedText)); }
      if (citation.note) addNote(lines, level + 1, citation.note);
    });
  }

  function buildFamilies(data, personRefs) {
    const partnerByPair = new Map();
    data.relationships.filter(function (item) { return item.type === "partner"; }).forEach(function (item) { partnerByPair.set([item.fromPersonId, item.toPersonId].sort().join("|"), item); });
    const parentsByChild = new Map();
    data.relationships.filter(function (item) { return item.type === "parent-child"; }).forEach(function (item) { if (!parentsByChild.has(item.toPersonId)) parentsByChild.set(item.toPersonId, []); parentsByChild.get(item.toPersonId).push(item.fromPersonId); });
    const groups = new Map();
    parentsByChild.forEach(function (parents, childId) { const ids = Array.from(new Set(parents)).sort(); const key = ids.join("|") || "single:" + childId; if (!groups.has(key)) groups.set(key, { parents: ids, children: [] }); groups.get(key).children.push(childId); });
    partnerByPair.forEach(function (relationship, pair) { if (!groups.has(pair)) groups.set(pair, { parents: pair.split("|"), children: [] }); groups.get(pair).partner = relationship; });
    return Array.from(groups.values()).map(function (family, index) { family.ref = "@F" + (index + 1) + "@"; family.parents = family.parents.filter(function (id) { return personRefs.has(id); }); family.children = family.children.filter(function (id) { return personRefs.has(id); }); return family; });
  }

  function exportGedcom(data) {
    if (!data || !data.tree || !Array.isArray(data.persons)) throw new Error("書き出す家系図が見つかりません。");
    const lines = ["0 HEAD", "1 SOUR FAMILY_TREE_NOTE", "2 NAME 家系図ノート", "2 VERS 1.0.0-prototype.4-fix.4", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8", "1 LANG Japanese"];
    const personRefs = new Map(data.persons.map(function (person, index) { return [person.id, "@I" + (index + 1) + "@"]; }));
    const sourceRefs = new Map(data.sources.map(function (source, index) { return [source.id, "@S" + (index + 1) + "@"]; }));
    const citationsByTarget = new Map();
    data.citations.forEach(function (citation) { const key = citation.targetType + ":" + citation.targetId; if (!citationsByTarget.has(key)) citationsByTarget.set(key, []); citationsByTarget.get(key).push(citation); });
    const families = buildFamilies(data, personRefs);
    data.persons.forEach(function (person) {
      lines.push("0 " + personRefs.get(person.id) + " INDI");
      lines.push("1 NAME " + cleanLine(person.givenName) + " /" + cleanLine(person.familyName) + "/");
      if (person.givenName) lines.push("2 GIVN " + cleanLine(person.givenName));
      if (person.familyName) lines.push("2 SURN " + cleanLine(person.familyName));
      if (person.nickname) lines.push("1 _NICK " + cleanLine(person.nickname));
      if (person.otherNames || person.formerFamilyName) lines.push("1 _OTHER_NAMES " + cleanLine([person.formerFamilyName ? "旧姓 " + person.formerFamilyName : "", person.otherNames].filter(Boolean).join(" / ")));
      const sex = { male: "M", female: "F" }[person.gender]; if (sex) lines.push("1 SEX " + sex);
      if (person.birthDate || person.birthplace) { lines.push("1 BIRT"); if (person.birthDate) lines.push("2 DATE " + gedDate(person.birthDate, person.birthDatePrecision, person.birthDateApproximate)); if (person.birthplace) lines.push("2 PLAC " + cleanLine(person.birthplace)); citeLines(lines, 2, (citationsByTarget.get("person:" + person.id) || []).filter(function (item) { return item.fieldName === "birthDate" || item.fieldName === "birthplace"; }), sourceRefs); }
      if (person.isDeceased || person.deathDate) { lines.push("1 DEAT" + (person.isDeceased && !person.deathDate ? " Y" : "")); if (person.deathDate) lines.push("2 DATE " + gedDate(person.deathDate, person.deathDatePrecision, person.deathDateApproximate)); citeLines(lines, 2, (citationsByTarget.get("person:" + person.id) || []).filter(function (item) { return item.fieldName === "deathDate"; }), sourceRefs); }
      data.events.filter(function (event) { return (event.personIds || []).includes(person.id) && !["birth", "death", "marriage", "divorce"].includes(event.eventType); }).forEach(function (event) {
        const tag = STANDARD_EVENT_TAGS[event.eventType] || "EVEN"; lines.push("1 " + tag);
        if (tag === "EVEN" || event.title) lines.push("2 TYPE " + cleanLine(event.title || event.eventType));
        if (event.date) lines.push("2 DATE " + gedDate(event.date, event.datePrecision, event.dateApproximate));
        if (event.place) lines.push("2 PLAC " + cleanLine(event.place));
        if (event.isSensitive) lines.push("2 _SENSITIVE Y");
        lines.push("2 _VERIFY " + event.verificationStatus);
        addNote(lines, 2, event.description);
        citeLines(lines, 2, citationsByTarget.get("event:" + event.id), sourceRefs);
      });
      lines.push("1 _VERIFY " + person.verificationStatus);
      families.forEach(function (family) { if (family.parents.includes(person.id)) lines.push("1 FAMS " + family.ref); if (family.children.includes(person.id)) lines.push("1 FAMC " + family.ref); });
      addNote(lines, 1, [person.nameMemo, person.memo].filter(Boolean).join("\n"));
      citeLines(lines, 1, (citationsByTarget.get("person:" + person.id) || []).filter(function (item) { return !["birthDate", "birthplace", "deathDate"].includes(item.fieldName); }), sourceRefs);
    });
    families.forEach(function (family) {
      lines.push("0 " + family.ref + " FAM");
      const people = family.parents.map(function (id) { return data.persons.find(function (person) { return person.id === id; }); }).filter(Boolean);
      const husband = people.find(function (person) { return person.gender === "male"; }) || people[0]; const wife = people.find(function (person) { return person.gender === "female" && (!husband || person.id !== husband.id); }) || people.find(function (person) { return !husband || person.id !== husband.id; });
      if (husband) lines.push("1 HUSB " + personRefs.get(husband.id)); if (wife) lines.push("1 WIFE " + personRefs.get(wife.id)); family.children.forEach(function (id) { lines.push("1 CHIL " + personRefs.get(id)); });
      if (family.partner) { const rel = family.partner; if (rel.relationshipType === "marriage" || rel.startDate) { lines.push("1 MARR"); if (rel.startDate) lines.push("2 DATE " + gedDate(rel.startDate, LegacyPrecision(rel.startDate), false)); citeLines(lines, 2, citationsByTarget.get("relationship:" + rel.id), sourceRefs); } if (["divorced", "ended"].includes(rel.status) || rel.endDate) { lines.push("1 DIV"); if (rel.endDate) lines.push("2 DATE " + gedDate(rel.endDate, LegacyPrecision(rel.endDate), false)); } lines.push("1 _VERIFY " + rel.verificationStatus); addNote(lines, 1, rel.memo); }
    });
    data.sources.forEach(function (source) { lines.push("0 " + sourceRefs.get(source.id) + " SOUR"); lines.push("1 TITL " + cleanLine(source.title)); if (source.author) lines.push("1 AUTH " + cleanLine(source.author)); if (source.publisher) lines.push("1 PUBL " + cleanLine(source.publisher)); if (source.referenceNumber) lines.push("1 NOTE 整理番号: " + cleanLine(source.referenceNumber)); addNote(lines, 1, source.note); });
    lines.push("0 TRLR");
    return { text: lines.join("\r\n") + "\r\n", fileName: "家系図ノート_" + slug(data.tree.name) + "_" + new Date().toISOString().slice(0, 10) + ".ged", personCount: data.persons.length, relationshipCount: data.relationships.length };
  }
  function LegacyPrecision(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? "day" : /^\d{4}-\d{2}$/.test(value || "") ? "month" : "year"; }

  function parseLine(line, index) {
    const match = /^(\d+)\s+(?:(@[^@]+@)\s+)?([A-Za-z0-9_]+)(?:\s+(.*))?$/.exec(line.trim());
    if (!match) throw new Error((index + 1) + "行目を解析できません。");
    return { level: Number(match[1]), xref: match[2] || "", tag: match[3].toUpperCase(), value: match[4] || "", line: index + 1 };
  }

  function parseGedcom(text, fileName) {
    const raw = String(text || "").replace(/^\uFEFF/, ""); if (!raw.trim()) throw new Error("GEDCOMファイルが空です。");
    const rows = raw.split(/\r?\n/).filter(function (line) { return line.trim(); }); if (!rows.length || !/^0\s+HEAD\b/i.test(rows[0])) throw new Error("GEDCOMのHEADレコードが見つかりません。");
    const records = []; const warnings = []; let unsupported = 0; let charset = "不明"; let current = null; let context = [];
    rows.forEach(function (rawLine, index) {
      let line; try { line = parseLine(rawLine, index); } catch (error) { warnings.push(error.message); return; }
      if (!SUPPORTED.has(line.tag)) unsupported += 1;
      context = context.slice(0, line.level); context[line.level] = line;
      if (line.level === 0) { current = { xref: line.xref, type: line.tag, lines: [] }; records.push(current); }
      else if (current) current.lines.push(Object.assign({}, line, { parentTag: context[line.level - 1] && context[line.level - 1].tag || "" }));
      if (line.tag === "CHAR") charset = cleanLine(line.value).toUpperCase();
    });
    const indiRecords = records.filter(function (record) { return record.type === "INDI"; }); if (!indiRecords.length) throw new Error("人物（INDI）レコードが見つかりません。");
    const sourceRecords = records.filter(function (record) { return record.type === "SOUR"; }); const sourceMap = new Map();
    const sources = sourceRecords.map(function (record, index) { const id = "ged-source-" + (index + 1); sourceMap.set(record.xref, id); function first(tag) { const line = record.lines.find(function (item) { return item.tag === tag; }); return line ? line.value : ""; } return { id: id, title: first("TITL") || "名称未登録の資料", sourceType: "other", author: first("AUTH"), publisher: first("PUBL"), issuedDate: "", obtainedDate: "", repository: "", referenceNumber: "", url: "", note: record.lines.filter(function (item) { return item.tag === "NOTE"; }).map(function (item) { return item.value; }).join("\n"), reliability: "unknown", attachmentIds: [] }; });
    const personMap = new Map(); const personCitations = []; const events = [];
    const persons = indiRecords.map(function (record, index) {
      const id = "ged-person-" + (index + 1); personMap.set(record.xref, id); const nameLine = record.lines.find(function (line) { return line.tag === "NAME"; }); const name = nameLine ? nameLine.value : ""; const nameMatch = /^(.*?)\s*\/([^/]*)\//.exec(name); const givn = record.lines.find(function (line) { return line.tag === "GIVN"; }); const surn = record.lines.find(function (line) { return line.tag === "SURN"; }); const givenName = cleanLine(givn && givn.value || nameMatch && nameMatch[1] || "名前未登録"); const familyName = cleanLine(surn && surn.value || nameMatch && nameMatch[2] || "");
      function eventData(tag) { const anchor = record.lines.findIndex(function (line) { return line.tag === tag && line.level === 1; }); if (anchor < 0) return { date: { value: "", precision: "unknown", approximate: false }, place: "" }; let dateLine = null; let placeLine = null; for (let i = anchor + 1; i < record.lines.length && record.lines[i].level > 1; i += 1) { if (record.lines[i].tag === "DATE") dateLine = record.lines[i]; if (record.lines[i].tag === "PLAC") placeLine = record.lines[i]; } const parsed = parseGedDate(dateLine && dateLine.value || ""); if (parsed.warning) warnings.push(parsed.warning + "（" + record.xref + "）"); return { date: parsed, place: placeLine && placeLine.value || "" }; }
      const birth = eventData("BIRT"); const death = eventData("DEAT"); const sexLine = record.lines.find(function (line) { return line.tag === "SEX"; }); const note = record.lines.filter(function (line) { return line.tag === "NOTE"; }).map(function (line) { return line.value; }).join("\n"); const verifyLine = record.lines.find(function (line) { return line.tag === "_VERIFY"; }); const nick = record.lines.find(function (line) { return line.tag === "_NICK"; }); const other = record.lines.find(function (line) { return line.tag === "_OTHER_NAMES"; });
      record.lines.filter(function (line) { return line.tag === "SOUR"; }).forEach(function (line) { if (sourceMap.has(line.value)) personCitations.push({ sourceId: sourceMap.get(line.value), targetType: "person", targetId: id, fieldName: "other", quotedText: "", page: "", note: "", verificationStatus: "unconfirmed" }); });
      record.lines.filter(function (line) { return line.level === 1 && TAG_TO_EVENT[line.tag] && !["BIRT", "DEAT", "MARR", "DIV"].includes(line.tag); }).forEach(function (anchor) {
        const parsedEvent = eventData(anchor.tag); let titleLine = null; let noteLine = null; let sensitive = false; let verify = "unconfirmed"; const anchorIndex = record.lines.indexOf(anchor);
        for (let i = anchorIndex + 1; i < record.lines.length && record.lines[i].level > anchor.level; i += 1) { if (record.lines[i].tag === "TYPE") titleLine = record.lines[i]; if (record.lines[i].tag === "NOTE") noteLine = record.lines[i]; if (record.lines[i].tag === "_SENSITIVE") sensitive = record.lines[i].value === "Y"; if (record.lines[i].tag === "_VERIFY") verify = ["confirmed", "probable", "unconfirmed", "disputed"].includes(record.lines[i].value) ? record.lines[i].value : "unconfirmed"; }
        events.push({ id: "ged-event-" + (events.length + 1), personIds: [id], eventType: TAG_TO_EVENT[anchor.tag], title: titleLine && titleLine.value || TAG_TO_EVENT[anchor.tag], date: parsedEvent.date.value, datePrecision: parsedEvent.date.precision, dateApproximate: parsedEvent.date.approximate, endDate: "", place: parsedEvent.place, description: noteLine && noteLine.value || "", sourceIds: [], verificationStatus: verify, isSensitive: sensitive, sortOrder: null });
      });
      return { id: id, familyName: familyName, givenName: givenName, formerFamilyName: "", familyNameKana: "", givenNameKana: "", nickname: nick && nick.value || "", otherNames: other && other.value || "", honorific: "", nameMemo: "", gender: sexLine && sexLine.value === "M" ? "male" : sexLine && sexLine.value === "F" ? "female" : "", birthDate: birth.date.value, birthDatePrecision: birth.date.precision, birthDateApproximate: birth.date.approximate, deathDate: death.date.value, deathDatePrecision: death.date.precision, deathDateApproximate: death.date.approximate, isDeceased: Boolean(record.lines.find(function (line) { return line.tag === "DEAT"; })), birthplace: birth.place, photo: "", memo: note, verificationStatus: verifyLine && ["confirmed", "probable", "unconfirmed", "disputed"].includes(verifyLine.value) ? verifyLine.value : "unconfirmed" };
    });
    const relationships = []; const familyRecords = records.filter(function (record) { return record.type === "FAM"; });
    familyRecords.forEach(function (record, familyIndex) {
      const husband = record.lines.find(function (line) { return line.tag === "HUSB"; }); const wife = record.lines.find(function (line) { return line.tag === "WIFE"; }); const parents = [husband && personMap.get(husband.value), wife && personMap.get(wife.value)].filter(Boolean); const children = record.lines.filter(function (line) { return line.tag === "CHIL"; }).map(function (line) { return personMap.get(line.value); }).filter(Boolean); const missingRefs = record.lines.filter(function (line) { return ["HUSB", "WIFE", "CHIL"].includes(line.tag) && !personMap.has(line.value); }); missingRefs.forEach(function (line) { warnings.push("存在しない人物参照 " + line.value + "（" + record.xref + "）"); }); const marr = record.lines.find(function (line) { return line.tag === "MARR"; }); const div = record.lines.find(function (line) { return line.tag === "DIV"; }); function nestedDate(anchor) { if (!anchor) return ""; const index = record.lines.indexOf(anchor); for (let i = index + 1; i < record.lines.length && record.lines[i].level > anchor.level; i += 1) if (record.lines[i].tag === "DATE") return parseGedDate(record.lines[i].value).value; return ""; }
      if (parents.length === 2) relationships.push({ id: "ged-rel-partner-" + familyIndex, type: "partner", fromPersonId: parents[0], toPersonId: parents[1], relationshipType: marr ? "marriage" : "partnership", startDate: nestedDate(marr), endDate: nestedDate(div), status: div ? "divorced" : "current", sortOrder: null, memo: "", verificationStatus: "unconfirmed" });
      parents.forEach(function (parentId) { children.forEach(function (childId) { relationships.push({ id: "ged-rel-parent-" + relationships.length, type: "parent-child", fromPersonId: parentId, toPersonId: childId, relationshipType: "biological", startDate: "", endDate: "", status: "", sortOrder: null, memo: "", verificationStatus: "unconfirmed" }); }); });
      if (marr && parents.length) events.push({ id: "ged-event-marriage-" + familyIndex, personIds: parents, eventType: "marriage", title: "結婚", date: nestedDate(marr), datePrecision: nestedDate(marr) ? (/^\d{4}-\d{2}-\d{2}$/.test(nestedDate(marr)) ? "day" : /^\d{4}-\d{2}$/.test(nestedDate(marr)) ? "month" : "year") : "unknown", dateApproximate: false, endDate: "", place: "", description: "", sourceIds: [], verificationStatus: "unconfirmed", isSensitive: false, sortOrder: null });
    });
    const citations = personCitations; const warningCount = warnings.length;
    return { treeName: cleanLine(fileName || "GEDCOM取込").replace(/\.ged$/i, "") || "GEDCOM取込", persons: persons, relationships: relationships, events: events, sources: sources, citations: citations, warnings: warnings, warningCount: warningCount, unsupportedTagCount: unsupported, charset: charset, familyCount: familyRecords.length, eventCount: events.length };
  }

  globalThis.FamilyTreeGedcom = Object.freeze({ exportGedcom: exportGedcom, parseGedcom: parseGedcom, parseDate: parseGedDate, formatDate: gedDate });
}());
