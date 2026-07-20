(function () {
  "use strict";

  const japaneseCollator = new Intl.Collator("ja-JP", {
    usage: "sort",
    sensitivity: "base",
    numeric: true,
    ignorePunctuation: true
  });

  function safeText(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function normalizeSearchText(value) {
    let text = value === null || value === undefined ? "" : String(value);
    if (typeof text.normalize === "function") text = text.normalize("NFKC");
    return text.toLocaleLowerCase("ja-JP")
      .replace(/[\s\u3000・･.,，．\-ー_]/g, "")
      .replace(/[ァ-ヶ]/g, function (character) {
        return String.fromCharCode(character.charCodeAt(0) - 0x60);
      });
  }

  function compareTextEmptyLast(first, second) {
    const a = safeText(first);
    const b = safeText(second);
    if (!a && b) return 1;
    if (a && !b) return -1;
    if (!a && !b) return 0;
    return japaneseCollator.compare(a, b);
  }

  function comparePersonsByKanjiName(personA, personB) {
    const a = personA || {};
    const b = personB || {};
    const aHasFullName = Boolean(safeText(a.familyName) && safeText(a.givenName));
    const bHasFullName = Boolean(safeText(b.familyName) && safeText(b.givenName));
    if (aHasFullName !== bHasFullName) return aHasFullName ? -1 : 1;

    const fields = ["familyName", "givenName", "formerFamilyName", "familyNameKana", "givenNameKana", "birthDate"];
    for (let index = 0; index < fields.length; index += 1) {
      const comparison = compareTextEmptyLast(a[fields[index]], b[fields[index]]);
      if (comparison) return comparison;
    }

    const idA = safeText(a.id);
    const idB = safeText(b.id);
    const collatedId = japaneseCollator.compare(idA, idB);
    if (collatedId) return collatedId;
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  }

  function sortPersonsByKanjiName(persons) {
    return Array.isArray(persons) ? persons.slice().sort(comparePersonsByKanjiName) : [];
  }

  function searchRank(person, normalizedQuery) {
    if (!normalizedQuery) return 0;
    const familyName = normalizeSearchText(person && person.familyName);
    const givenName = normalizeSearchText(person && person.givenName);
    const fullName = familyName + givenName;
    if (fullName && fullName === normalizedQuery) return 0;
    if ((familyName && familyName.startsWith(normalizedQuery)) ||
        (givenName && givenName.startsWith(normalizedQuery)) ||
        (fullName && fullName.startsWith(normalizedQuery))) return 1;
    if ((familyName && familyName.includes(normalizedQuery)) ||
        (givenName && givenName.includes(normalizedQuery)) ||
        (fullName && fullName.includes(normalizedQuery))) return 2;

    const supplementalFields = [
      person && person.formerFamilyName,
      person && person.familyNameKana,
      person && person.givenNameKana,
      person && person.nickname,
      person && person.otherNames
    ];
    return supplementalFields.some(function (value) {
      return normalizeSearchText(value).includes(normalizedQuery);
    }) ? 3 : -1;
  }

  function rankAndSortPersonCandidates(persons, searchQuery) {
    const normalizedQuery = normalizeSearchText(searchQuery);
    const ranked = (Array.isArray(persons) ? persons : []).map(function (person) {
      return { person: person, rank: searchRank(person, normalizedQuery) };
    }).filter(function (entry) {
      return !normalizedQuery || entry.rank >= 0;
    });
    ranked.sort(function (first, second) {
      return first.rank - second.rank || comparePersonsByKanjiName(first.person, second.person);
    });
    return ranked.map(function (entry) { return entry.person; });
  }

  globalThis.PersonCandidateUtils = Object.freeze({
    japaneseCollator: japaneseCollator,
    normalizeSearchText: normalizeSearchText,
    comparePersonsByKanjiName: comparePersonsByKanjiName,
    sortPersonsByKanjiName: sortPersonsByKanjiName,
    rankAndSortPersonCandidates: rankAndSortPersonCandidates
  });
}());
