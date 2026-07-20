(function () {
  "use strict";

  const MAX_BLOOD_DEPTH = 7;
  const MAX_AFFINITY_DEGREE = 3;
  const MAX_REFERENCE_DEPTH = 7;
  let cachedSignature = "";
  let cachedResult = null;

  function text(value) { return String(value === null || value === undefined ? "" : value); }
  function compareText(a, b) { const first = text(a); const second = text(b); return first < second ? -1 : first > second ? 1 : 0; }
  function sorted(values, compare) { return values.slice().sort(compare || compareText); }
  function personName(person) { return person ? ((person.familyName || "") + " " + (person.givenName || "")).trim() || "氏名未登録" : "不明な人物"; }
  function genderWord(person, male, female, neutral) { return person && person.gender === "male" ? male : person && person.gender === "female" ? female : neutral; }
  function birthKey(person) { return person && /^\d{4}/.test(person.birthDate || "") ? person.birthDate : ""; }
  function currentPartner(relationship) { return relationship && relationship.type === "partner" && relationship.status !== "divorced" && relationship.status !== "ended"; }
  function formerPartner(relationship) { return relationship && relationship.type === "partner" && (relationship.status === "divorced" || relationship.status === "ended"); }
  function parentKind(relationship) {
    const value = relationship && relationship.relationshipType;
    if (value === "adoptive" || value === "step") return value;
    return "biological";
  }

  function signatureOf(focusPersonId, persons, relationships) {
    const personPart = sorted(persons || [], function (a, b) { return compareText(a.id, b.id); }).map(function (person) {
      return [person.id, person.gender, person.birthDate, person.isDeceased ? 1 : 0, person.updatedAt].map(text).join("~");
    }).join("|");
    const relationPart = sorted(relationships || [], function (a, b) { return compareText(a.id, b.id); }).map(function (relationship) {
      return [relationship.id, relationship.type, relationship.fromPersonId, relationship.toPersonId, relationship.relationshipType, relationship.status, relationship.updatedAt].map(text).join("~");
    }).join("|");
    return text(focusPersonId) + "#" + personPart + "#" + relationPart;
  }

  function lineageClass(kinds) {
    const unique = new Set(kinds);
    if (unique.size === 1 && unique.has("biological")) return "biological";
    if (unique.size === 1 && unique.has("adoptive")) return "adoptive";
    return "mixed";
  }

  function directionPattern(directions) {
    if (!directions.length) return "self";
    const changes = directions.reduce(function (count, value, index) { return count + (index && directions[index - 1] !== value ? 1 : 0); }, 0);
    if (!changes) return directions[0];
    if (changes === 1) return directions[0] + "-" + directions[directions.length - 1];
    return "mixed";
  }

  function candidateRank(candidate) {
    const rank = { biological: 0, adoptive: 1, mixed: 2, affinity: 3, step: 4, other: 5 }[candidate.lineageType] ?? 6;
    return [rank, candidate.degree === null ? 99 : candidate.degree, candidate.spouseEdges || 0, candidate.unknownEdges || 0,
      candidate.pathRelationshipIds.join("\u0001"), candidate.pathPersonIds.join("\u0001")];
  }

  function compareCandidates(a, b) {
    const first = candidateRank(a); const second = candidateRank(b);
    for (let index = 0; index < first.length; index += 1) {
      if (typeof first[index] === "number" && first[index] !== second[index]) return first[index] - second[index];
      const compared = compareText(first[index], second[index]); if (compared) return compared;
    }
    return 0;
  }

  function buildIndexes(persons, relationships) {
    const personMap = new Map((persons || []).map(function (person) { return [person.id, person]; }));
    const relationshipMap = new Map();
    const bloodEdges = new Map();
    const stepEdges = new Map();
    const partnerEdges = new Map();
    const warnings = [];
    function add(map, id, edge) { if (!map.has(id)) map.set(id, []); map.get(id).push(edge); }
    (relationships || []).forEach(function (relationship) {
      relationshipMap.set(relationship.id, relationship);
      if (!personMap.has(relationship.fromPersonId) || !personMap.has(relationship.toPersonId)) {
        warnings.push({ type: "missing-person-reference", relationshipId: relationship.id, message: "存在しない人物を参照する関係は親等計算から除外しました。" });
        return;
      }
      if (relationship.fromPersonId === relationship.toPersonId) {
        warnings.push({ type: "self-relationship", relationshipId: relationship.id, message: "自己関係は親等計算から除外しました。" });
        return;
      }
      if (relationship.type === "parent-child") {
        const kind = parentKind(relationship);
        const edgeFrom = { relationship: relationship, personId: relationship.toPersonId, direction: "down", kind: kind };
        const edgeTo = { relationship: relationship, personId: relationship.fromPersonId, direction: "up", kind: kind };
        add(kind === "step" ? stepEdges : bloodEdges, relationship.fromPersonId, edgeFrom);
        add(kind === "step" ? stepEdges : bloodEdges, relationship.toPersonId, edgeTo);
      } else if (relationship.type === "partner") {
        add(partnerEdges, relationship.fromPersonId, { relationship: relationship, personId: relationship.toPersonId });
        add(partnerEdges, relationship.toPersonId, { relationship: relationship, personId: relationship.fromPersonId });
      }
    });
    [bloodEdges, stepEdges, partnerEdges].forEach(function (map) {
      map.forEach(function (edges) { edges.sort(function (a, b) { return compareText(a.relationship.id, b.relationship.id) || compareText(a.personId, b.personId); }); });
    });
    return { personMap: personMap, relationshipMap: relationshipMap, bloodEdges: bloodEdges, stepEdges: stepEdges, partnerEdges: partnerEdges, warnings: warnings };
  }

  function calculateBloodCandidates(startPersonId, indexes, maxDepth) {
    const candidates = new Map();
    const queue = [{ personId: startPersonId, pathPersonIds: [startPersonId], pathRelationshipIds: [], directions: [], kinds: [], unknownEdges: 0 }];
    const bestState = new Map();
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const state = queue[cursor];
      if (state.pathRelationshipIds.length >= maxDepth) continue;
      const edges = indexes.bloodEdges.get(state.personId) || [];
      edges.forEach(function (edge) {
        if (state.pathPersonIds.includes(edge.personId) || state.pathRelationshipIds.includes(edge.relationship.id)) return;
        // A legal blood-kinship path may go up to a common ancestor and then down,
        // but must not go down to a common descendant and back up (co-parents are not blood relatives).
        if (edge.direction === "up" && state.directions.includes("down")) return;
        const next = {
          personId: edge.personId,
          pathPersonIds: state.pathPersonIds.concat(edge.personId),
          pathRelationshipIds: state.pathRelationshipIds.concat(edge.relationship.id),
          directions: state.directions.concat(edge.direction),
          kinds: state.kinds.concat(edge.kind),
          unknownEdges: state.unknownEdges
        };
        const firstHop = next.pathPersonIds[1] || "";
        const key = next.personId + "|" + lineageClass(next.kinds) + "|" + directionPattern(next.directions) + "|" + firstHop;
        const stateScore = next.pathRelationshipIds.length + "|" + next.pathRelationshipIds.join("\u0001") + "|" + next.pathPersonIds.join("\u0001");
        if (bestState.has(key) && compareText(bestState.get(key), stateScore) <= 0) return;
        bestState.set(key, stateScore);
        const candidate = {
          personId: next.personId,
          degree: next.pathRelationshipIds.length,
          lineageType: lineageClass(next.kinds),
          pathPersonIds: next.pathPersonIds,
          pathRelationshipIds: next.pathRelationshipIds,
          directions: next.directions,
          kinds: next.kinds,
          spouseEdges: 0,
          unknownEdges: next.unknownEdges
        };
        if (!candidates.has(next.personId)) candidates.set(next.personId, []);
        candidates.get(next.personId).push(candidate);
        queue.push(next);
      });
    }
    const selected = new Map();
    candidates.forEach(function (values, personId) { selected.set(personId, values.slice().sort(compareCandidates)[0]); });
    return { selected: selected, candidates: candidates };
  }

  function branchFor(candidate, indexes) {
    if (!candidate.directions.length) return "unknown";
    if (candidate.directions[0] === "down") return "descendant";
    if (candidate.directions.length === 2 && candidate.directions[0] === "up" && candidate.directions[1] === "down") return "sibling";
    const firstPerson = indexes.personMap.get(candidate.pathPersonIds[1]);
    if (firstPerson && firstPerson.gender === "male") return "paternal";
    if (firstPerson && firstPerson.gender === "female") return "maternal";
    return "unknown";
  }

  function ancestorLabel(person, depth, adoptive) {
    if (depth === 1) return adoptive ? genderWord(person, "養父", "養母", "養親") : genderWord(person, "父", "母", "親");
    if (depth === 2) return adoptive ? genderWord(person, "養祖父", "養祖母", "養祖父母") : genderWord(person, "祖父", "祖母", "祖父母");
    if (depth === 3) return genderWord(person, adoptive ? "養曾祖父" : "曾祖父", adoptive ? "養曾祖母" : "曾祖母", adoptive ? "養曾祖父母" : "曾祖父母");
    if (depth === 4) return genderWord(person, "高祖父", "高祖母", "高祖父母");
    if (depth === 5) return "5世代上の祖先";
    if (depth === 6) return "6世代上の祖先";
    return depth + "世代上の祖先";
  }

  function descendantLabel(person, depth, adoptive) {
    if (depth === 1) return adoptive ? "養子" : genderWord(person, "息子", "娘", "子");
    if (depth === 2) return genderWord(person, "孫息子", "孫娘", "孫");
    if (depth === 3) return "曾孫";
    if (depth === 4) return "玄孫";
    if (depth === 5) return "5世代下の子孫";
    if (depth === 6) return "6世代下の子孫";
    return depth + "世代下の子孫";
  }

  function siblingLabel(person, focus) {
    const targetBirth = birthKey(person); const focusBirth = birthKey(focus);
    if (!targetBirth || !focusBirth || targetBirth === focusBirth) return "兄弟姉妹";
    return targetBirth < focusBirth ? genderWord(person, "兄", "姉", "年上の兄弟姉妹") : genderWord(person, "弟", "妹", "年下の兄弟姉妹");
  }

  function uncleLabel(person, parent) {
    const targetBirth = birthKey(person); const parentBirth = birthKey(parent);
    if (!targetBirth || !parentBirth || targetBirth === parentBirth) return genderWord(person, "おじ", "おば", "親の兄弟姉妹");
    return targetBirth < parentBirth ? genderWord(person, "伯父", "伯母", "親の年上の兄弟姉妹") : genderWord(person, "叔父", "叔母", "親の年下の兄弟姉妹");
  }

  function prefixBranch(label, branch, directDepth) {
    if (directDepth === 1) return label;
    if (branch === "paternal") return "父方の" + label;
    if (branch === "maternal") return "母方の" + label;
    return label;
  }

  function resolveBloodLabel(candidate, indexes, focusPersonId) {
    const person = indexes.personMap.get(candidate.personId);
    const focus = indexes.personMap.get(focusPersonId);
    const up = candidate.directions.filter(function (value) { return value === "up"; }).length;
    const down = candidate.directions.filter(function (value) { return value === "down"; }).length;
    const allUp = up === candidate.directions.length;
    const allDown = down === candidate.directions.length;
    const adoptive = candidate.lineageType === "adoptive";
    const branch = branchFor(candidate, indexes);
    let label;
    if (allUp) label = prefixBranch(ancestorLabel(person, up, adoptive), branch, up);
    else if (allDown) label = descendantLabel(person, down, adoptive);
    else if (up === 1 && down === 1) label = siblingLabel(person, focus);
    else if (up === 2 && down === 1) label = prefixBranch(uncleLabel(person, indexes.personMap.get(candidate.pathPersonIds[1])), branch, 2);
    else if (up === 1 && down === 2) label = genderWord(person, "甥", "姪", "おい・めい");
    else if (up === 2 && down === 2) label = prefixBranch("いとこ", branch, 2);
    else if (up === 3 && down === 1) label = prefixBranch(genderWord(person, "大叔父", "大叔母", "祖父母の兄弟姉妹"), branch, 3);
    else if (up === 1 && down === 3) label = "兄弟姉妹の孫";
    else if (up === 3 && down === 3) label = prefixBranch("はとこ", branch, 3);
    else label = candidate.degree + "親等の血族";
    if (candidate.lineageType === "mixed") label += "（実親・養親族の経路）";
    return { label: label, branch: branch };
  }

  function partnerLabel(person, relationship, former) {
    if (former) return "元配偶者";
    if (person && person.isDeceased) return "死別した配偶者";
    if (relationship && relationship.relationshipType === "partnership") return "パートナー";
    return genderWord(person, "夫", "妻", "配偶者");
  }

  function pathStepLabel(currentId, nextId, relationship, indexes) {
    const nextPerson = indexes.personMap.get(nextId);
    if (!relationship) return "関係不明";
    if (relationship.type === "partner") return formerPartner(relationship) ? "元配偶者" : (relationship.relationshipType === "partnership" ? "パートナー" : "配偶者");
    const kind = parentKind(relationship);
    if (relationship.toPersonId === currentId && relationship.fromPersonId === nextId) {
      if (kind === "step") return genderWord(nextPerson, "継父", "継母", "継親");
      if (kind === "adoptive") return genderWord(nextPerson, "養父", "養母", "養親");
      return genderWord(nextPerson, "父", "母", "親");
    }
    if (kind === "step") return "継子";
    if (kind === "adoptive") return "養子";
    return genderWord(nextPerson, "息子", "娘", "子");
  }

  function buildKinshipPath(candidate, indexes) {
    const labels = [];
    for (let index = 0; index < candidate.pathRelationshipIds.length; index += 1) {
      labels.push(pathStepLabel(candidate.pathPersonIds[index], candidate.pathPersonIds[index + 1], indexes.relationshipMap.get(candidate.pathRelationshipIds[index]), indexes));
    }
    return labels;
  }

  function resultFromBlood(candidate, indexes, focusPersonId) {
    const resolved = resolveBloodLabel(candidate, indexes, focusPersonId);
    const within = candidate.degree <= 6;
    return {
      personId: candidate.personId, focusPersonId: focusPersonId,
      category: candidate.lineageType === "biological" ? "blood" : "adoptive",
      degree: candidate.degree, displayDegree: within ? candidate.degree + "親等" : "親等外",
      relationshipLabel: resolved.label, branch: resolved.branch, lineageType: candidate.lineageType,
      pathPersonIds: candidate.pathPersonIds.slice(), pathRelationshipIds: candidate.pathRelationshipIds.slice(),
      pathLabels: buildKinshipPath(candidate, indexes), isWithinLegalRange: within,
      confidence: candidate.lineageType === "mixed" ? "medium" : "high", warnings: []
    };
  }

  function affinityLabel(side, bloodResult, targetPerson) {
    const label = bloodResult.relationshipLabel.replace(/^父方の|^母方の/, "");
    if (side === "spouse-blood") {
      if (bloodResult.degree === 1 && /父|母|親/.test(label)) return genderWord(targetPerson, "義父", "義母", "配偶者の親");
      if (bloodResult.degree === 1 && /子|息子|娘/.test(label)) return "配偶者の子";
      if (bloodResult.degree === 2 && /兄|姉|弟|妹|兄弟姉妹/.test(label)) return "配偶者の兄弟姉妹";
      return "配偶者の" + label;
    }
    if (bloodResult.degree === 1 && /子|息子|娘/.test(label)) return "子の配偶者";
    if (bloodResult.degree === 2 && /兄|姉|弟|妹|兄弟姉妹/.test(label)) return "兄弟姉妹の配偶者";
    return label + "の配偶者";
  }

  function chooseResult(map, result) {
    const current = map.get(result.personId);
    if (!current) { map.set(result.personId, result); return; }
    const categoryRank = { self: 0, blood: 1, adoptive: 2, spouse: 3, affinity: 4, step: 5, formerSpouse: 6, unrelated: 7, unknown: 8 };
    const a = [categoryRank[result.category] ?? 9, result.degree === null ? 99 : result.degree, result.pathRelationshipIds.join("\u0001")];
    const b = [categoryRank[current.category] ?? 9, current.degree === null ? 99 : current.degree, current.pathRelationshipIds.join("\u0001")];
    if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && compareText(a[2], b[2]) < 0)))) map.set(result.personId, result);
  }

  function calculateAffinityKinship(focusPersonId, indexes, bloodResults, resultMap) {
    const directPartners = (indexes.partnerEdges.get(focusPersonId) || []).filter(function (edge) { return currentPartner(edge.relationship); });
    directPartners.forEach(function (edge) {
      const person = indexes.personMap.get(edge.personId);
      const warnings = [];
      if (person && person.isDeceased) warnings.push("姻族関係は要確認");
      if (edge.relationship.status === "separated") warnings.push("別居中の関係です");
      chooseResult(resultMap, {
        personId: edge.personId, focusPersonId: focusPersonId, category: "spouse", degree: null, displayDegree: "配偶者",
        relationshipLabel: partnerLabel(person, edge.relationship, false), branch: "spouseSide", lineageType: "affinity",
        pathPersonIds: [focusPersonId, edge.personId], pathRelationshipIds: [edge.relationship.id],
        pathLabels: [pathStepLabel(focusPersonId, edge.personId, edge.relationship, indexes)], isWithinLegalRange: true,
        confidence: edge.relationship.status === "unknown" ? "medium" : "high", warnings: warnings
      });
      const spouseBlood = calculateBloodCandidates(edge.personId, indexes, MAX_AFFINITY_DEGREE).selected;
      spouseBlood.forEach(function (candidate, personId) {
        if (personId === focusPersonId || candidate.degree > MAX_AFFINITY_DEGREE) return;
        const bloodResult = resultFromBlood(candidate, indexes, edge.personId);
        chooseResult(resultMap, {
          personId: personId, focusPersonId: focusPersonId, category: "affinity", degree: candidate.degree,
          displayDegree: "姻族" + candidate.degree + "親等", relationshipLabel: affinityLabel("spouse-blood", bloodResult, indexes.personMap.get(personId)),
          branch: "spouseSide", lineageType: "affinity",
          pathPersonIds: [focusPersonId].concat(candidate.pathPersonIds), pathRelationshipIds: [edge.relationship.id].concat(candidate.pathRelationshipIds),
          pathLabels: [pathStepLabel(focusPersonId, edge.personId, edge.relationship, indexes)].concat(buildKinshipPath(candidate, indexes)),
          isWithinLegalRange: true, confidence: candidate.lineageType === "mixed" ? "medium" : "high", warnings: []
        });
      });
    });
    bloodResults.forEach(function (bloodResult, relativeId) {
      if (!bloodResult.degree || bloodResult.degree > MAX_AFFINITY_DEGREE) return;
      (indexes.partnerEdges.get(relativeId) || []).filter(function (edge) { return currentPartner(edge.relationship); }).forEach(function (edge) {
        if (edge.personId === focusPersonId) return;
        chooseResult(resultMap, {
          personId: edge.personId, focusPersonId: focusPersonId, category: "affinity", degree: bloodResult.degree,
          displayDegree: "姻族" + bloodResult.degree + "親等", relationshipLabel: affinityLabel("blood-spouse", bloodResult, indexes.personMap.get(edge.personId)),
          branch: bloodResult.branch === "paternal" || bloodResult.branch === "maternal" ? bloodResult.branch : "mixed", lineageType: "affinity",
          pathPersonIds: bloodResult.pathPersonIds.concat(edge.personId), pathRelationshipIds: bloodResult.pathRelationshipIds.concat(edge.relationship.id),
          pathLabels: bloodResult.pathLabels.concat(pathStepLabel(relativeId, edge.personId, edge.relationship, indexes)),
          isWithinLegalRange: true, confidence: bloodResult.confidence, warnings: []
        });
      });
    });
  }

  function calculateReferencePaths(focusPersonId, indexes) {
    const found = new Map();
    const queue = [{ personId: focusPersonId, persons: [focusPersonId], relationships: [], spouseCount: 0, stepCount: 0 }];
    const visited = new Set([focusPersonId + "|0|0|0"]);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const state = queue[cursor];
      if (state.relationships.length >= MAX_REFERENCE_DEPTH) continue;
      const edges = [];
      (indexes.bloodEdges.get(state.personId) || []).forEach(function (edge) { edges.push({ personId: edge.personId, relationship: edge.relationship, spouse: 0, step: 0 }); });
      (indexes.stepEdges.get(state.personId) || []).forEach(function (edge) { edges.push({ personId: edge.personId, relationship: edge.relationship, spouse: 0, step: 1 }); });
      (indexes.partnerEdges.get(state.personId) || []).filter(function (edge) { return currentPartner(edge.relationship); }).forEach(function (edge) { edges.push({ personId: edge.personId, relationship: edge.relationship, spouse: 1, step: 0 }); });
      edges.sort(function (a, b) { return compareText(a.relationship.id, b.relationship.id) || compareText(a.personId, b.personId); });
      edges.forEach(function (edge) {
        if (state.persons.includes(edge.personId) || state.relationships.includes(edge.relationship.id)) return;
        const next = { personId: edge.personId, persons: state.persons.concat(edge.personId), relationships: state.relationships.concat(edge.relationship.id), spouseCount: state.spouseCount + edge.spouse, stepCount: state.stepCount + edge.step };
        const key = next.personId + "|" + Math.min(next.spouseCount, 2) + "|" + Math.min(next.stepCount, 1);
        if (visited.has(key)) return;
        visited.add(key); queue.push(next);
        if (!found.has(next.personId)) found.set(next.personId, next);
      });
    }
    return found;
  }

  function stepResult(focusPersonId, edge, indexes) {
    const person = indexes.personMap.get(edge.personId);
    const isParent = edge.relationship.toPersonId === focusPersonId;
    return {
      personId: edge.personId, focusPersonId: focusPersonId, category: "step", degree: null,
      displayDegree: "継親", relationshipLabel: isParent ? genderWord(person, "継父", "継母", "継親") : "継子",
      branch: isParent ? "unknown" : "descendant", lineageType: "step",
      pathPersonIds: [focusPersonId, edge.personId], pathRelationshipIds: [edge.relationship.id],
      pathLabels: [pathStepLabel(focusPersonId, edge.personId, edge.relationship, indexes)], isWithinLegalRange: false,
      confidence: "high", warnings: ["親等なし", "法的養親子関係未登録"]
    };
  }

  function buildSummary(results) {
    const summary = { total: results.length, withinSix: 0, spouse: 0, affinity: 0, outsideOrUnknown: 0, degrees: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 } };
    results.forEach(function (result) {
      if ((result.category === "blood" || result.category === "adoptive") && result.degree >= 1 && result.degree <= 6) { summary.withinSix += 1; summary.degrees[result.degree] += 1; }
      else if (result.category === "spouse") summary.spouse += 1;
      else if (result.category === "affinity") summary.affinity += 1;
      else if (result.category !== "self") summary.outsideOrUnknown += 1;
    });
    return summary;
  }

  function calculateKinshipMap(options) {
    const started = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    const persons = Array.isArray(options && options.persons) ? options.persons : [];
    const relationships = Array.isArray(options && options.relationships) ? options.relationships : [];
    const focusPersonId = text(options && options.focusPersonId);
    const signature = signatureOf(focusPersonId, persons, relationships);
    if (cachedResult && signature === cachedSignature) return cachedResult;
    const indexes = buildIndexes(persons, relationships);
    const resultMap = new Map();
    const ambiguousPaths = [];
    if (indexes.personMap.has(focusPersonId)) {
      resultMap.set(focusPersonId, {
        personId: focusPersonId, focusPersonId: focusPersonId, category: "self", degree: 0, displayDegree: "基準人物", relationshipLabel: "基準人物",
        branch: "unknown", lineageType: "biological", pathPersonIds: [focusPersonId], pathRelationshipIds: [], pathLabels: [],
        isWithinLegalRange: true, confidence: "high", warnings: []
      });
      const bloodCandidates = calculateBloodCandidates(focusPersonId, indexes, MAX_BLOOD_DEPTH);
      const bloodResults = new Map();
      bloodCandidates.selected.forEach(function (candidate, personId) {
        const result = resultFromBlood(candidate, indexes, focusPersonId); bloodResults.set(personId, result); chooseResult(resultMap, result);
        const alternatives = bloodCandidates.candidates.get(personId) || [];
        if (alternatives.length > 1) ambiguousPaths.push({ personId: personId, selectedRelationshipIds: result.pathRelationshipIds.slice(), alternativeCount: alternatives.length - 1 });
      });
      calculateAffinityKinship(focusPersonId, indexes, bloodResults, resultMap);
      (indexes.partnerEdges.get(focusPersonId) || []).filter(function (edge) { return formerPartner(edge.relationship); }).forEach(function (edge) {
        chooseResult(resultMap, {
          personId: edge.personId, focusPersonId: focusPersonId, category: "formerSpouse", degree: null, displayDegree: "元配偶者", relationshipLabel: "元配偶者",
          branch: "spouseSide", lineageType: "affinity", pathPersonIds: [focusPersonId, edge.personId], pathRelationshipIds: [edge.relationship.id],
          pathLabels: ["元配偶者"], isWithinLegalRange: false, confidence: "high", warnings: ["現在の姻族計算には使用していません"]
        });
      });
      (indexes.stepEdges.get(focusPersonId) || []).forEach(function (edge) { chooseResult(resultMap, stepResult(focusPersonId, edge, indexes)); });
      const referencePaths = calculateReferencePaths(focusPersonId, indexes);
      persons.forEach(function (person) {
        if (resultMap.has(person.id)) return;
        const reference = referencePaths.get(person.id);
        if (reference) {
          const candidate = { pathPersonIds: reference.persons, pathRelationshipIds: reference.relationships };
          const hasMultipleSpouses = reference.spouseCount >= 2;
          resultMap.set(person.id, {
            personId: person.id, focusPersonId: focusPersonId, category: reference.stepCount ? "step" : "unrelated", degree: null,
            displayDegree: reference.stepCount ? "継親等" : "親等外", relationshipLabel: hasMultipleSpouses ? "姻族として未判定" : (reference.stepCount ? "継親等の参考経路" : "関係経路あり"),
            branch: "mixed", lineageType: reference.stepCount ? "step" : "unknown",
            pathPersonIds: reference.persons.slice(), pathRelationshipIds: reference.relationships.slice(), pathLabels: buildKinshipPath(candidate, indexes),
            isWithinLegalRange: false, confidence: "low", warnings: [hasMultipleSpouses ? "配偶者関係を2回以上経由するため姻族として自動判定していません" : "親等として確定できない経路です"]
          });
        } else {
          resultMap.set(person.id, {
            personId: person.id, focusPersonId: focusPersonId, category: "unrelated", degree: null, displayDegree: "親等外", relationshipLabel: "関係未判定",
            branch: "unknown", lineageType: "unknown", pathPersonIds: [focusPersonId, person.id].filter(Boolean), pathRelationshipIds: [], pathLabels: [],
            isWithinLegalRange: false, confidence: "low", warnings: ["基準人物からの関係経路を確認できません"]
          });
        }
      });
    } else {
      indexes.warnings.push({ type: "focus-person-missing", personId: focusPersonId, message: "基準人物が見つからないため親等を計算できませんでした。" });
    }
    const personResults = sorted(Array.from(resultMap.values()), function (a, b) { return compareText(a.personId, b.personId); });
    const byPersonId = {};
    personResults.forEach(function (result) { byPersonId[result.personId] = result; });
    const ended = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    const output = {
      focusPersonId: focusPersonId, calculatedAt: new Date().toISOString(), persons: personResults, byPersonId: byPersonId,
      summary: buildSummary(personResults), warnings: indexes.warnings, ambiguousPaths: ambiguousPaths,
      performanceMs: Math.max(0, ended - started), signature: signature
    };
    cachedSignature = signature; cachedResult = output;
    return output;
  }

  function calculateBloodKinship(options) {
    const persons = Array.isArray(options && options.persons) ? options.persons : [];
    const relationships = Array.isArray(options && options.relationships) ? options.relationships : [];
    const indexes = buildIndexes(persons, relationships);
    const candidates = calculateBloodCandidates(text(options && options.focusPersonId), indexes, Number(options && options.maxDepth) || MAX_BLOOD_DEPTH).selected;
    return Array.from(candidates.values()).map(function (candidate) { return resultFromBlood(candidate, indexes, text(options && options.focusPersonId)); });
  }

  function resolveKinshipLabel(result) { return result && result.relationshipLabel || "関係未判定"; }
  function clearCache() { cachedSignature = ""; cachedResult = null; }

  globalThis.KinshipCalculator = Object.freeze({
    calculateKinshipMap: calculateKinshipMap,
    calculateBloodKinship: calculateBloodKinship,
    calculateAffinityKinship: calculateAffinityKinship,
    resolveKinshipLabel: resolveKinshipLabel,
    buildKinshipPath: buildKinshipPath,
    clearCache: clearCache,
    MAX_BLOOD_DEPTH: MAX_BLOOD_DEPTH,
    MAX_AFFINITY_DEGREE: MAX_AFFINITY_DEGREE
  });
})();
