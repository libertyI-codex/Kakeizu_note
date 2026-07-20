(function () {
  "use strict";

  function stable(value) { return String(value === undefined || value === null ? "" : value); }
  function pairKey(first, second) { return [first, second].sort().join("--"); }
  function relationshipType(value) { return value === "adoptive" || value === "step" ? value : "biological"; }
  function typeRank(value) { return { biological: 0, adoptive: 1, step: 2 }[value] === undefined ? 3 : { biological: 0, adoptive: 1, step: 2 }[value]; }
  function relationshipOrder(value) { return Number.isFinite(Number(value && value.sortOrder)) ? Number(value.sortOrder) : Number.MAX_SAFE_INTEGER; }
  function verificationRank(value) { return { confirmed: 0, probable: 1, unconfirmed: 2, disputed: 3 }[value] === undefined ? 2 : { confirmed: 0, probable: 1, unconfirmed: 2, disputed: 3 }[value]; }

  function comparePeople(first, second) {
    const firstBirth = first.birthDate || "";
    const secondBirth = second.birthDate || "";
    if (firstBirth && secondBirth && firstBirth !== secondBirth) return firstBirth.localeCompare(secondBirth);
    if (firstBirth && !secondBirth) return -1;
    if (!firstBirth && secondBirth) return 1;
    const created = stable(first.createdAt).localeCompare(stable(second.createdAt));
    const firstName = ((first.familyName || "") + " " + (first.givenName || "")).trim();
    const secondName = ((second.familyName || "") + " " + (second.givenName || "")).trim();
    return created || firstName.localeCompare(secondName, "ja") || stable(first.id).localeCompare(stable(second.id));
  }

  function primaryPriority(type, parentCount) {
    if (type === "biological") return parentCount >= 2 ? 0 : 1;
    if (type === "adoptive") return parentCount >= 2 ? 2 : 3;
    if (type === "step") return parentCount >= 2 ? 4 : 5;
    return 6;
  }

  function build(persons, relationships, generationState) {
    const startedAt = performance.now();
    const personIds = new Set(persons.map(function (person) { return person.id; }));
    const personById = new Map(persons.map(function (person) { return [person.id, person]; }));
    const diagnostics = [];
    const partnerRelationships = relationships.filter(function (item) {
      return item.type === "partner" && personIds.has(item.fromPersonId) && personIds.has(item.toPersonId) && item.fromPersonId !== item.toPersonId;
    }).slice().sort(function (first, second) { return stable(first.id).localeCompare(stable(second.id)); });
    const partnerByPair = new Map();
    partnerRelationships.forEach(function (item) { const key = pairKey(item.fromPersonId, item.toPersonId); if (!partnerByPair.has(key)) partnerByPair.set(key, item); });
    const unionMap = new Map();

    function unionIdentity(parentIds, partnerRelationship) {
      const sortedParents = parentIds.slice().sort();
      if (partnerRelationship) return { id: "union:" + stable(partnerRelationship.id), familyKey: "partner:" + stable(partnerRelationship.id) };
      if (sortedParents.length === 2) return { id: "union:parents:" + sortedParents.join("--"), familyKey: "parents:" + sortedParents.join("--") };
      return { id: "union:single:" + sortedParents[0], familyKey: "single:" + sortedParents[0] };
    }

    function ensureUnion(parentIds, partnerRelationship) {
      const sortedParents = parentIds.slice().sort();
      const identity = unionIdentity(sortedParents, partnerRelationship);
      if (!unionMap.has(identity.id)) {
        const generations = sortedParents.map(function (id) {
          const value = generationState.personGenerations[id];
          return Number.isFinite(value) ? value : generationState.localGenerations[id];
        }).filter(Number.isFinite);
        unionMap.set(identity.id, {
          id: identity.id, familyKey: identity.familyKey, parentIds: sortedParents,
          partnerRelationId: partnerRelationship && partnerRelationship.id || "", partnerRelationship: partnerRelationship || null,
          generation: generations.length ? generations[0] : null, childIds: [], relationshipTypes: [], childLinks: [],
          centerX: 0, anchorY: 0, leftParentId: sortedParents[0] || "", rightParentId: sortedParents[1] || "",
          bounds: null, subtreeId: "subtree:" + identity.id, verificationStatus: "confirmed"
        });
      }
      return unionMap.get(identity.id);
    }

    const byChild = new Map();
    relationships.filter(function (item) {
      return item.type === "parent-child" && personIds.has(item.fromPersonId) && personIds.has(item.toPersonId) && item.fromPersonId !== item.toPersonId;
    }).slice().sort(function (first, second) {
      return typeRank(relationshipType(first.relationshipType)) - typeRank(relationshipType(second.relationshipType)) || relationshipOrder(first) - relationshipOrder(second) || stable(first.id).localeCompare(stable(second.id));
    }).forEach(function (item) {
      const type = relationshipType(item.relationshipType);
      const key = item.toPersonId + "|" + type;
      if (!byChild.has(key)) byChild.set(key, { childId: item.toPersonId, type: type, relationships: [] });
      byChild.get(key).relationships.push(item);
    });

    byChild.forEach(function (entry) {
      const relationshipsByParent = new Map();
      entry.relationships.forEach(function (item) {
        if (!relationshipsByParent.has(item.fromPersonId)) relationshipsByParent.set(item.fromPersonId, []);
        relationshipsByParent.get(item.fromPersonId).push(item);
      });
      const parentIds = Array.from(relationshipsByParent.keys()).sort();
      const groups = [];
      const used = new Set();
      const partnerPairs = [];
      for (let first = 0; first < parentIds.length; first += 1) for (let second = first + 1; second < parentIds.length; second += 1) {
        const partnerRelationship = partnerByPair.get(pairKey(parentIds[first], parentIds[second]));
        if (partnerRelationship) partnerPairs.push({ parentIds: [parentIds[first], parentIds[second]], partnerRelationship: partnerRelationship });
      }
      partnerPairs.sort(function (first, second) { return stable(first.partnerRelationship.id).localeCompare(stable(second.partnerRelationship.id)); }).forEach(function (pair) {
        if (used.has(pair.parentIds[0]) || used.has(pair.parentIds[1])) return;
        groups.push(pair); used.add(pair.parentIds[0]); used.add(pair.parentIds[1]);
      });
      const remaining = parentIds.filter(function (id) { return !used.has(id); });
      if (remaining.length === 2) groups.push({ parentIds: remaining.slice(), partnerRelationship: null });
      else if (remaining.length > 2) {
        groups.push({ parentIds: remaining.slice(0, 2), partnerRelationship: null });
        remaining.slice(2).forEach(function (id) { groups.push({ parentIds: [id], partnerRelationship: null }); });
      } else remaining.forEach(function (id) { groups.push({ parentIds: [id], partnerRelationship: null }); });
      groups.forEach(function (group) {
        const union = ensureUnion(group.parentIds, group.partnerRelationship);
        const linkRelationships = group.parentIds.reduce(function (all, parentId) { return all.concat(relationshipsByParent.get(parentId) || []); }, []).slice().sort(function (first, second) { return stable(first.id).localeCompare(stable(second.id)); });
        const existing = union.childLinks.find(function (link) { return link.childId === entry.childId && link.relationshipType === entry.type; });
        if (existing) existing.relationships = existing.relationships.concat(linkRelationships);
        else union.childLinks.push({ childId: entry.childId, relationshipType: entry.type, relationships: linkRelationships, isPrimary: false, routeId: "route:" + union.id + ":" + entry.type });
      });
    });

    partnerRelationships.forEach(function (item) { ensureUnion([item.fromPersonId, item.toPersonId], item); });
    const unionNodes = Array.from(unionMap.values()).sort(function (first, second) { return first.id.localeCompare(second.id); });
    const candidatesByChild = new Map();
    unionNodes.forEach(function (union) {
      union.childLinks.sort(function (first, second) { return typeRank(first.relationshipType) - typeRank(second.relationshipType) || stable(first.childId).localeCompare(stable(second.childId)); });
      union.childLinks.forEach(function (link) {
        if (!candidatesByChild.has(link.childId)) candidatesByChild.set(link.childId, []);
        candidatesByChild.get(link.childId).push({ union: union, link: link, priority: primaryPriority(link.relationshipType, union.parentIds.length) });
      });
    });
    const primaryUnionByChild = {};
    const primaryRelationshipTypeByChild = {};
    candidatesByChild.forEach(function (candidates, childId) {
      candidates.sort(function (first, second) { return first.priority - second.priority || first.union.id.localeCompare(second.union.id) || first.link.routeId.localeCompare(second.link.routeId); });
      const selected = candidates[0];
      selected.link.isPrimary = true;
      primaryUnionByChild[childId] = selected.union.id;
      primaryRelationshipTypeByChild[childId] = selected.link.relationshipType;
    });
    unionNodes.forEach(function (union) {
      union.childIds = Array.from(new Set(union.childLinks.map(function (link) { return link.childId; }))).sort();
      union.relationshipTypes = Array.from(new Set(union.childLinks.map(function (link) { return link.relationshipType; }))).sort(function (first, second) { return typeRank(first) - typeRank(second); });
      const statuses = union.childLinks.reduce(function (all, link) { return all.concat(link.relationships.map(function (item) { return item.verificationStatus || "unconfirmed"; })); }, []);
      if (union.partnerRelationship) statuses.push(union.partnerRelationship.verificationStatus || "unconfirmed");
      union.verificationStatus = statuses.sort(function (first, second) { return verificationRank(second) - verificationRank(first); })[0] || "confirmed";
      if (new Set(union.parentIds).size !== union.parentIds.length) diagnostics.push({ type: "union-node-parent-mismatch", severity: "error", unionNodeId: union.id, message: "UnionNodeの親IDが重複しています。" });
    });

    const siblingGroups = unionNodes.map(function (union) {
      const childIds = union.childLinks.filter(function (link) { return link.isPrimary; }).map(function (link) { return link.childId; });
      if (!childIds.length) return null;
      childIds.sort(function (firstId, secondId) {
        const firstLink = union.childLinks.find(function (link) { return link.childId === firstId && link.isPrimary; });
        const secondLink = union.childLinks.find(function (link) { return link.childId === secondId && link.isPrimary; });
        const firstOrder = Math.min.apply(null, firstLink.relationships.map(relationshipOrder));
        const secondOrder = Math.min.apply(null, secondLink.relationships.map(relationshipOrder));
        return firstOrder - secondOrder || comparePeople(personById.get(firstId), personById.get(secondId));
      });
      const firstGeneration = childIds.length ? (Number.isFinite(generationState.personGenerations[childIds[0]]) ? generationState.personGenerations[childIds[0]] : generationState.localGenerations[childIds[0]]) : null;
      return { id: "siblings:" + union.id, unionNodeId: union.id, childIds: childIds.slice(), generation: firstGeneration, orderedChildIds: childIds.slice(), subtreeIds: [], minX: 0, maxX: 0, centerX: 0, splitCount: 0 };
    }).filter(Boolean).sort(function (first, second) { return first.id.localeCompare(second.id); });

    const relationshipOwnerById = {};
    unionNodes.forEach(function (union) { union.childLinks.forEach(function (link) { link.relationships.forEach(function (item) { relationshipOwnerById[item.id] = { unionNodeId: union.id, routeId: link.routeId, childId: link.childId, relationshipType: link.relationshipType }; }); }); });
    return {
      unionNodes: unionNodes, unionById: new Map(unionNodes.map(function (union) { return [union.id, union]; })), siblingGroups: siblingGroups,
      primaryUnionByChild: primaryUnionByChild, primaryRelationshipTypeByChild: primaryRelationshipTypeByChild,
      relationshipOwnerById: relationshipOwnerById, diagnostics: diagnostics,
      timings: { unionNodeGenerationMs: performance.now() - startedAt }
    };
  }

  globalThis.UnionNodeBuilder = Object.freeze({ build: build, comparePeople: comparePeople, relationshipOrder: relationshipOrder, relationshipType: relationshipType, typeRank: typeRank });
}());
