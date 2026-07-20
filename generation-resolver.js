(function () {
  "use strict";

  function stableId(value) {
    return String(value === undefined || value === null ? "" : value);
  }

  function chooseFocus(persons, relationships, preferredFocusId, rootPersonId) {
    const ids = new Set(persons.map(function (person) { return person.id; }));
    if (preferredFocusId && ids.has(preferredFocusId)) return preferredFocusId;
    if (rootPersonId && ids.has(rootPersonId)) return rootPersonId;
    const degree = new Map(persons.map(function (person) { return [person.id, 0]; }));
    relationships.forEach(function (relationship) {
      if (!ids.has(relationship.fromPersonId) || !ids.has(relationship.toPersonId)) return;
      degree.set(relationship.fromPersonId, degree.get(relationship.fromPersonId) + 1);
      degree.set(relationship.toPersonId, degree.get(relationship.toPersonId) + 1);
    });
    return persons.slice().sort(function (first, second) {
      const degreeDifference = degree.get(second.id) - degree.get(first.id);
      if (degreeDifference) return degreeDifference;
      const createdDifference = stableId(first.createdAt).localeCompare(stableId(second.createdAt));
      return createdDifference || stableId(first.id).localeCompare(stableId(second.id));
    })[0].id;
  }

  function buildGraph(persons, relationships) {
    const ids = new Set(persons.map(function (person) { return person.id; }));
    const adjacency = new Map(persons.map(function (person) { return [person.id, []]; }));
    relationships.slice().sort(function (first, second) {
      const typeDifference = (first.type === "parent-child" ? 0 : 1) - (second.type === "parent-child" ? 0 : 1);
      return typeDifference || stableId(first.id).localeCompare(stableId(second.id));
    }).forEach(function (relationship) {
      const from = relationship.fromPersonId;
      const to = relationship.toPersonId;
      if (!ids.has(from) || !ids.has(to) || from === to) return;
      if (relationship.type === "parent-child") {
        adjacency.get(from).push({ to: to, delta: -1, partnerCost: 0, relationshipId: relationship.id, type: relationship.type });
        adjacency.get(to).push({ to: from, delta: 1, partnerCost: 0, relationshipId: relationship.id, type: relationship.type });
      } else if (relationship.type === "partner") {
        adjacency.get(from).push({ to: to, delta: 0, partnerCost: 1, relationshipId: relationship.id, type: relationship.type });
        adjacency.get(to).push({ to: from, delta: 0, partnerCost: 1, relationshipId: relationship.id, type: relationship.type });
      }
    });
    adjacency.forEach(function (edges) {
      edges.sort(function (first, second) {
        return first.partnerCost - second.partnerCost || stableId(first.relationshipId).localeCompare(stableId(second.relationshipId)) || stableId(first.to).localeCompare(stableId(second.to));
      });
    });
    return adjacency;
  }

  function buildComponents(persons, adjacency, focusPersonId) {
    const visited = new Set();
    const components = [];
    persons.map(function (person) { return person.id; }).sort().forEach(function (startId) {
      if (visited.has(startId)) return;
      const ids = [];
      const queue = [startId];
      visited.add(startId);
      while (queue.length) {
        const id = queue.shift();
        ids.push(id);
        (adjacency.get(id) || []).forEach(function (edge) {
          if (visited.has(edge.to)) return;
          visited.add(edge.to);
          queue.push(edge.to);
        });
      }
      ids.sort();
      components.push(ids);
    });
    components.sort(function (first, second) {
      if (first.includes(focusPersonId)) return -1;
      if (second.includes(focusPersonId)) return 1;
      return second.length - first.length || first[0].localeCompare(second[0]);
    });
    return components;
  }

  function heapPush(heap, item) {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareQueueItems(heap[parent], item) <= 0) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = item;
  }

  function heapPop(heap) {
    const first = heap[0];
    const tail = heap.pop();
    if (heap.length && tail) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= heap.length) break;
        let child = left;
        if (right < heap.length && compareQueueItems(heap[right], heap[left]) < 0) child = right;
        if (compareQueueItems(heap[child], tail) >= 0) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = tail;
    }
    return first;
  }

  function compareQueueItems(first, second) {
    return first.partnerCost - second.partnerCost || first.hops - second.hops || first.pathKey.localeCompare(second.pathKey) || first.id.localeCompare(second.id);
  }

  function diagnosticCollector() {
    const diagnostics = [];
    const seen = new Set();
    return {
      add: function (item) {
        const key = [item.type, item.personId || "", item.relationshipId || "", (item.relationshipIds || []).slice().sort().join(","), (item.expectedGenerations || []).slice().sort(function (a, b) { return a - b; }).join(",")].join("|");
        if (seen.has(key)) return;
        seen.add(key);
        diagnostics.push(Object.assign({ severity: "error", code: item.type }, item));
      },
      values: diagnostics
    };
  }

  function solveComponent(componentIds, anchorId, adjacency, collector) {
    const allowed = new Set(componentIds);
    const generation = new Map();
    const partnerCost = new Map();
    const hops = new Map();
    const pathKey = new Map();
    const sourceRelationshipIds = new Map();
    const expectedByPerson = new Map();
    const heap = [];
    generation.set(anchorId, 0);
    partnerCost.set(anchorId, 0);
    hops.set(anchorId, 0);
    pathKey.set(anchorId, anchorId);
    sourceRelationshipIds.set(anchorId, []);
    heapPush(heap, { id: anchorId, generation: 0, partnerCost: 0, hops: 0, pathKey: anchorId, relationshipIds: [] });

    while (heap.length) {
      const current = heapPop(heap);
      if (current.partnerCost !== partnerCost.get(current.id) || current.hops !== hops.get(current.id) || current.pathKey !== pathKey.get(current.id)) continue;
      (adjacency.get(current.id) || []).forEach(function (edge) {
        if (!allowed.has(edge.to)) return;
        const candidateGeneration = current.generation + edge.delta;
        const candidateCost = current.partnerCost + edge.partnerCost;
        const candidateHops = current.hops + 1;
        const candidatePath = current.pathKey + ">" + stableId(edge.relationshipId) + ">" + edge.to;
        const candidateRelationships = current.relationshipIds.concat(edge.relationshipId).filter(Boolean);
        if (!expectedByPerson.has(edge.to)) expectedByPerson.set(edge.to, new Set());
        expectedByPerson.get(edge.to).add(candidateGeneration);
        const knownCost = partnerCost.has(edge.to) ? partnerCost.get(edge.to) : Number.POSITIVE_INFINITY;
        const knownHops = hops.has(edge.to) ? hops.get(edge.to) : Number.POSITIVE_INFINITY;
        const knownPath = pathKey.get(edge.to) || "\uffff";
        const better = candidateCost < knownCost || candidateCost === knownCost && (candidateHops < knownHops || candidateHops === knownHops && candidatePath < knownPath);
        if (better) {
          generation.set(edge.to, candidateGeneration);
          partnerCost.set(edge.to, candidateCost);
          hops.set(edge.to, candidateHops);
          pathKey.set(edge.to, candidatePath);
          sourceRelationshipIds.set(edge.to, candidateRelationships);
          heapPush(heap, { id: edge.to, generation: candidateGeneration, partnerCost: candidateCost, hops: candidateHops, pathKey: candidatePath, relationshipIds: candidateRelationships });
        } else if (candidateCost === knownCost && generation.get(edge.to) !== candidateGeneration) {
          const expected = Array.from(new Set([generation.get(edge.to), candidateGeneration])).sort(function (a, b) { return a - b; });
          collector.add({
            type: "generation-conflict", personId: edge.to, expectedGenerations: expected,
            relationshipIds: Array.from(new Set((sourceRelationshipIds.get(edge.to) || []).concat(candidateRelationships))).sort(),
            message: "同じ人物へ異なる世代値の経路が到達しています。"
          });
        }
      });
    }
    return { generation: generation, expectedByPerson: expectedByPerson };
  }

  function detectParentCycles(persons, relationships, collector) {
    const ids = new Set(persons.map(function (person) { return person.id; }));
    const children = new Map(persons.map(function (person) { return [person.id, []]; }));
    relationships.filter(function (relationship) { return relationship.type === "parent-child"; }).sort(function (first, second) {
      return stableId(first.id).localeCompare(stableId(second.id));
    }).forEach(function (relationship) {
      if (ids.has(relationship.fromPersonId) && ids.has(relationship.toPersonId)) children.get(relationship.fromPersonId).push(relationship);
    });
    const visiting = new Set();
    const visited = new Set();
    function visit(id, path) {
      if (visiting.has(id)) {
        collector.add({ type: "parent-cycle", personId: id, relationshipIds: path.slice(), message: "親子関係が循環しています。" });
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      (children.get(id) || []).forEach(function (relationship) { visit(relationship.toPersonId, path.concat(relationship.id).filter(Boolean)); });
      visiting.delete(id);
      visited.add(id);
    }
    Array.from(ids).sort().forEach(function (id) { visit(id, []); });
  }

  function resolve(persons, relationships, preferredFocusId, options) {
    if (!persons.length) return { focusPersonId: "", personGenerations: {}, localGenerations: {}, components: [], disconnectedComponents: [], diagnostics: [] };
    const rootPersonId = options && options.rootPersonId || "";
    const focusPersonId = chooseFocus(persons, relationships, preferredFocusId, rootPersonId);
    const adjacency = buildGraph(persons, relationships);
    const components = buildComponents(persons, adjacency, focusPersonId);
    const collector = diagnosticCollector();
    detectParentCycles(persons, relationships, collector);
    const personGenerations = {};
    const localGenerations = {};
    const componentByPerson = {};

    components.forEach(function (componentIds, index) {
      const anchorId = index === 0 ? focusPersonId : componentIds.slice().sort(function (firstId, secondId) {
        const firstDegree = (adjacency.get(firstId) || []).length;
        const secondDegree = (adjacency.get(secondId) || []).length;
        return secondDegree - firstDegree || firstId.localeCompare(secondId);
      })[0];
      const solved = solveComponent(componentIds, anchorId, adjacency, collector);
      componentIds.forEach(function (id) {
        componentByPerson[id] = index;
        localGenerations[id] = solved.generation.has(id) ? solved.generation.get(id) : 0;
        personGenerations[id] = index === 0 ? localGenerations[id] : null;
      });
      if (index > 0) collector.add({ type: "disconnected-generation", severity: "warning", personId: anchorId, relationshipIds: [], message: "基準人物との相対世代を確定できないグループです。" });
    });

    relationships.slice().sort(function (first, second) { return stableId(first.id).localeCompare(stableId(second.id)); }).forEach(function (relationship) {
      const fromGeneration = localGenerations[relationship.fromPersonId];
      const toGeneration = localGenerations[relationship.toPersonId];
      if (!Number.isFinite(fromGeneration) || !Number.isFinite(toGeneration)) return;
      if (relationship.type === "parent-child" && fromGeneration - toGeneration !== 1) {
        collector.add({
          type: "parent-child-generation-gap", relationshipId: relationship.id,
          personId: relationship.toPersonId, expectedGenerations: [fromGeneration - 1, toGeneration],
          message: "親子関係の世代差が1ではありません。"
        });
      }
      if (relationship.type === "partner" && fromGeneration !== toGeneration) {
        collector.add({
          type: "partner-generation-mismatch", relationshipId: relationship.id,
          personId: relationship.toPersonId, expectedGenerations: [fromGeneration, toGeneration],
          message: "パートナー同士の世代が一致しません。"
        });
      }
    });

    return {
      focusPersonId: focusPersonId,
      personGenerations: personGenerations,
      localGenerations: localGenerations,
      componentByPerson: componentByPerson,
      components: components.map(function (ids, index) { return { id: "component:" + index, personIds: ids.slice(), connectedToFocus: index === 0 }; }),
      disconnectedComponents: components.slice(1).map(function (ids, index) { return { id: "disconnected:" + (index + 1), personIds: ids.slice() }; }),
      diagnostics: collector.values
    };
  }

  globalThis.GenerationResolver = Object.freeze({ resolve: resolve, chooseFocus: chooseFocus });
}());
