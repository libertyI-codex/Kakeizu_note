(function () {
  "use strict";

  const CARD_WIDTH = 184;
  const CARD_HEIGHT = 128;
  const PERSON_GAP = 28;
  const SIBLING_GAP = 28;
  const SUBTREE_GAP = 64;
  const ROOT_GAP = 88;
  const SUBTREE_PADDING = 36;

  function stable(value) { return String(value === undefined || value === null ? "" : value); }
  function generationOf(id, state) {
    const relative = state.personGenerations[id];
    return Number.isFinite(relative) ? relative : (Number.isFinite(state.localGenerations[id]) ? state.localGenerations[id] : 0);
  }
  function componentOf(id, state) { return Number.isFinite(state.componentByPerson[id]) ? state.componentByPerson[id] : 0; }
  function unique(values) { return Array.from(new Set(values)); }

  function build(persons, relationships, generationState, unionModel, options) {
    const startedAt = performance.now();
    const cardWidth = Number(options && options.cardWidth) || CARD_WIDTH;
    const cardHeight = Number(options && options.cardHeight) || CARD_HEIGHT;
    const personById = new Map(persons.map(function (person) { return [person.id, person]; }));
    const unionById = unionModel.unionById;
    const diagnostics = [];
    const parentUnionsByPerson = new Map();
    unionModel.unionNodes.forEach(function (union) {
      union.parentIds.forEach(function (personId) {
        if (!parentUnionsByPerson.has(personId)) parentUnionsByPerson.set(personId, []);
        parentUnionsByPerson.get(personId).push(union.id);
      });
    });
    parentUnionsByPerson.forEach(function (ids) { ids.sort(); });

    /* A downstream union may join two ancestral branches. Exactly one incoming
       primary subtree owns its placement; every other incoming branch remains
       a side branch and references the same person card. */
    const ownerUnionByUnion = {};
    const ownedUnionsByUnion = new Map(unionModel.unionNodes.map(function (union) { return [union.id, []]; }));
    const sideParentsByUnion = new Map(unionModel.unionNodes.map(function (union) { return [union.id, []]; }));
    unionModel.unionNodes.forEach(function (union) {
      const candidates = unique(union.parentIds.map(function (personId) {
        return unionModel.primaryUnionByChild[personId] || "";
      }).filter(function (id) { return id && id !== union.id && unionById.has(id); })).sort();
      if (!candidates.length) return;
      const owner = candidates[0];
      ownerUnionByUnion[union.id] = owner;
      ownedUnionsByUnion.get(owner).push(union.id);
      candidates.slice(1).forEach(function (candidate) { sideParentsByUnion.get(union.id).push(candidate); });
    });
    ownedUnionsByUnion.forEach(function (ids) { ids.sort(); });

    const subtreeById = new Map();
    unionModel.unionNodes.forEach(function (union) {
      const primaryChildren = union.childLinks.filter(function (link) { return link.isPrimary; }).map(function (link) { return link.childId; });
      subtreeById.set(union.subtreeId, {
        id: union.subtreeId,
        unionNodeId: union.id,
        familyKey: union.familyKey,
        generation: union.generation,
        parentIds: union.parentIds.slice(),
        childIds: primaryChildren.slice(),
        childSubtreeIds: [],
        directPersonIds: unique(union.parentIds.concat(primaryChildren)),
        memberPersonIds: [],
        minWidth: 0,
        computedWidth: 0,
        centerX: 0,
        minX: 0,
        maxX: 0,
        bounds: null,
        parentSideBranches: (sideParentsByUnion.get(union.id) || []).map(function (id) { return "subtree:" + id; }),
        spouseSideBranches: [],
        layoutPriority: Number.MAX_SAFE_INTEGER,
        cycleDetected: false
      });
    });
    unionModel.unionNodes.forEach(function (union) {
      const subtree = subtreeById.get(union.subtreeId);
      subtree.childSubtreeIds = (ownedUnionsByUnion.get(union.id) || []).map(function (id) { return unionById.get(id).subtreeId; });
    });

    const widthStartedAt = performance.now();
    const widthMemo = new Map();
    const memberMemo = new Map();
    const active = new Set();
    function measure(subtreeId) {
      if (widthMemo.has(subtreeId)) return widthMemo.get(subtreeId);
      const subtree = subtreeById.get(subtreeId);
      if (!subtree) return cardWidth + SUBTREE_PADDING * 2;
      if (active.has(subtreeId)) {
        subtree.cycleDetected = true;
        diagnostics.push({ type: "family-subtree-cycle", severity: "warning", familySubtreeId: subtreeId, message: "FamilySubtreeの循環参照を検出したため、再帰を安全に打ち切りました。" });
        return cardWidth + SUBTREE_PADDING * 2;
      }
      active.add(subtreeId);
      const parentSpan = subtree.parentIds.length ? subtree.parentIds.length * cardWidth + Math.max(0, subtree.parentIds.length - 1) * PERSON_GAP : cardWidth;
      const children = subtree.childIds.slice();
      const branchWidths = children.map(function (childId) {
        const owned = (parentUnionsByPerson.get(childId) || []).filter(function (unionId) { return ownerUnionByUnion[unionId] === subtree.unionNodeId; });
        if (!owned.length) return cardWidth;
        const widths = owned.map(function (unionId) { return measure(unionById.get(unionId).subtreeId); });
        return Math.max(cardWidth, widths.reduce(function (sum, value) { return sum + value; }, 0) + Math.max(0, widths.length - 1) * SUBTREE_GAP);
      });
      const childSpan = branchWidths.length ? branchWidths.reduce(function (sum, value) { return sum + value; }, 0) + Math.max(0, branchWidths.length - 1) * SIBLING_GAP : 0;
      const width = Math.max(parentSpan, childSpan, cardWidth * 1.5) + SUBTREE_PADDING * 2;
      const members = new Set(subtree.directPersonIds);
      subtree.childSubtreeIds.forEach(function (childSubtreeId) {
        measure(childSubtreeId);
        (memberMemo.get(childSubtreeId) || []).forEach(function (id) { members.add(id); });
      });
      active.delete(subtreeId);
      subtree.minWidth = Math.max(parentSpan, cardWidth) + SUBTREE_PADDING * 2;
      subtree.computedWidth = width;
      subtree.memberPersonIds = Array.from(members).sort();
      widthMemo.set(subtreeId, width);
      memberMemo.set(subtreeId, subtree.memberPersonIds);
      return width;
    }
    subtreeById.forEach(function (_, id) { measure(id); });
    const widthCalculationMs = performance.now() - widthStartedAt;

    const roots = unionModel.unionNodes.filter(function (union) { return !ownerUnionByUnion[union.id]; }).slice().sort(function (first, second) {
      return componentOf(first.parentIds[0] || first.childIds[0], generationState) - componentOf(second.parentIds[0] || second.childIds[0], generationState) ||
        (Number(second.generation) || 0) - (Number(first.generation) || 0) || first.id.localeCompare(second.id);
    });
    let priority = 0;
    const priorityVisited = new Set();
    function assignPriority(unionId) {
      if (priorityVisited.has(unionId)) return;
      priorityVisited.add(unionId);
      const subtree = subtreeById.get(unionById.get(unionId).subtreeId);
      subtree.layoutPriority = priority;
      priority += 1;
      (ownedUnionsByUnion.get(unionId) || []).forEach(assignPriority);
    }
    roots.forEach(function (union) { assignPriority(union.id); });
    unionModel.unionNodes.forEach(function (union) { assignPriority(union.id); });

    const positionStartedAt = performance.now();
    const personGroup = new Map();
    const groups = unionModel.siblingGroups.map(function (source) {
      const ordered = source.orderedChildIds.filter(function (id) { return personById.has(id); });
      const subtree = subtreeById.get(unionById.get(source.unionNodeId).subtreeId);
      const group = {
        id: source.id,
        unionNodeId: source.unionNodeId,
        personIds: ordered,
        generation: source.generation,
        component: ordered.length ? componentOf(ordered[0], generationState) : 0,
        reserveWidth: Math.max(ordered.length * cardWidth + Math.max(0, ordered.length - 1) * PERSON_GAP, Math.min(subtree.computedWidth, Math.max(cardWidth * 2, ordered.length * (cardWidth + PERSON_GAP) * 2))),
        priority: subtree.layoutPriority
      };
      ordered.forEach(function (id) { if (!personGroup.has(id)) personGroup.set(id, group.id); });
      return group;
    }).filter(function (group) { return group.personIds.length; });
    persons.slice().sort(unionModel.comparePeople || function (first, second) { return stable(first.id).localeCompare(stable(second.id)); }).forEach(function (person) {
      if (personGroup.has(person.id)) return;
      const parentUnionIds = parentUnionsByPerson.get(person.id) || [];
      const associated = parentUnionIds.map(function (id) { return subtreeById.get(unionById.get(id).subtreeId); }).sort(function (first, second) { return first.layoutPriority - second.layoutPriority || first.id.localeCompare(second.id); });
      const group = {
        id: "person-group:" + person.id,
        unionNodeId: associated[0] && associated[0].unionNodeId || "",
        personIds: [person.id], generation: generationOf(person.id, generationState), component: componentOf(person.id, generationState),
        reserveWidth: associated[0] ? Math.max(cardWidth, Math.min(associated[0].computedWidth, cardWidth * 3)) : cardWidth,
        priority: associated[0] ? associated[0].layoutPriority : Number.MAX_SAFE_INTEGER
      };
      groups.push(group); personGroup.set(person.id, group.id);
    });
    const groupById = new Map(groups.map(function (group) { return [group.id, group]; }));

    /* Partners connect atomic sibling groups into a placement block. The groups
       remain indivisible, so an unrelated person can never enter a sibling run. */
    const groupParent = new Map(groups.map(function (group) { return [group.id, group.id]; }));
    function find(id) { let value = id; while (groupParent.get(value) !== value) value = groupParent.get(value); let cursor = id; while (groupParent.get(cursor) !== cursor) { const next = groupParent.get(cursor); groupParent.set(cursor, value); cursor = next; } return value; }
    function join(first, second) { const a = find(first); const b = find(second); if (a !== b) groupParent.set(b, a < b ? a : b); }
    relationships.filter(function (item) { return item.type === "partner"; }).slice().sort(function (a, b) { return stable(a.id).localeCompare(stable(b.id)); }).forEach(function (item) {
      const first = personGroup.get(item.fromPersonId); const second = personGroup.get(item.toPersonId);
      if (!first || !second || first === second) return;
      const firstGroup = groupById.get(first); const secondGroup = groupById.get(second);
      if (firstGroup.component === secondGroup.component && firstGroup.generation === secondGroup.generation) join(first, second);
    });
    const placementBlocks = new Map();
    groups.forEach(function (group) {
      const key = find(group.id);
      if (!placementBlocks.has(key)) placementBlocks.set(key, { id: "placement:" + key, groups: [], component: group.component, generation: group.generation, priority: group.priority, width: 0 });
      const block = placementBlocks.get(key); block.groups.push(group); block.priority = Math.min(block.priority, group.priority);
    });
    placementBlocks.forEach(function (block) {
      block.groups.sort(function (first, second) { return first.priority - second.priority || first.id.localeCompare(second.id); });
      block.width = block.groups.reduce(function (sum, group) { return sum + group.reserveWidth; }, 0) + Math.max(0, block.groups.length - 1) * SUBTREE_GAP;
    });

    const blocksByLayer = new Map();
    placementBlocks.forEach(function (block) {
      const key = block.component + ":" + block.generation;
      if (!blocksByLayer.has(key)) blocksByLayer.set(key, []);
      blocksByLayer.get(key).push(block);
    });
    blocksByLayer.forEach(function (blocks) { blocks.sort(function (first, second) { return first.priority - second.priority || first.id.localeCompare(second.id); }); });
    const componentWidths = new Map();
    blocksByLayer.forEach(function (blocks) {
      const component = blocks[0].component;
      const width = blocks.reduce(function (sum, block) { return sum + block.width; }, 0) + Math.max(0, blocks.length - 1) * ROOT_GAP;
      componentWidths.set(component, Math.max(componentWidths.get(component) || 0, width));
    });

    const nodes = [];
    const nodeById = new Map();
    Array.from(blocksByLayer.keys()).sort(function (first, second) {
      const a = first.split(":").map(Number); const b = second.split(":").map(Number);
      return a[0] - b[0] || b[1] - a[1];
    }).forEach(function (key) {
      const blocks = blocksByLayer.get(key);
      const component = blocks[0].component;
      const total = blocks.reduce(function (sum, block) { return sum + block.width; }, 0) + Math.max(0, blocks.length - 1) * ROOT_GAP;
      let cursor = ((componentWidths.get(component) || total) - total) / 2;
      blocks.forEach(function (block) {
        block.x = cursor;
        let groupCursor = cursor;
        block.groups.forEach(function (group) {
          const cardSpan = group.personIds.length * cardWidth + Math.max(0, group.personIds.length - 1) * PERSON_GAP;
          let cardCursor = groupCursor + (group.reserveWidth - cardSpan) / 2;
          group.personIds.forEach(function (personId, index) {
            const node = { id: personId, x: cardCursor, y: 0, generation: generationOf(personId, generationState), relativeGeneration: Number.isFinite(generationState.personGenerations[personId]) ? generationState.personGenerations[personId] : null, component: componentOf(personId, generationState), disconnected: !Number.isFinite(generationState.personGenerations[personId]), siblingGroupId: group.id.indexOf("siblings:") === 0 ? group.id : "", placementGroupId: group.id, placementBlockId: block.id, isFocus: personId === generationState.focusPersonId, hasGenerationConflict: false };
            nodes.push(node); nodeById.set(personId, node); cardCursor += cardWidth + PERSON_GAP;
            if (index && node.x < nodeById.get(group.personIds[index - 1]).x + cardWidth + PERSON_GAP - 0.1) diagnostics.push({ type: "generation-layer-overlap", severity: "error", personId: personId, message: "同一世代の人物カードが重なりました。" });
          });
          groupCursor += group.reserveWidth + SUBTREE_GAP;
        });
        cursor += block.width + ROOT_GAP;
      });
    });

    /* Two directional barycenter sweeps move complete placement blocks, never
       individual sibling cards. This aligns parents and descendants without
       allowing another family to enter an atomic sibling run. */
    function blockNodes(block) {
      return block.groups.reduce(function (all, group) { return all.concat(group.personIds.map(function (id) { return nodeById.get(id); }).filter(Boolean)); }, []);
    }
    function shiftBlock(block, nextX) {
      const delta = nextX - block.x;
      if (Math.abs(delta) < 0.01) return;
      blockNodes(block).forEach(function (node) { node.x += delta; });
      block.x = nextX;
    }
    function pack(blocks, desiredByBlock) {
      blocks.sort(function (first, second) {
        const firstDesired = desiredByBlock.has(first.id) ? desiredByBlock.get(first.id) : first.x + first.width / 2;
        const secondDesired = desiredByBlock.has(second.id) ? desiredByBlock.get(second.id) : second.x + second.width / 2;
        return firstDesired - secondDesired || first.priority - second.priority || first.id.localeCompare(second.id);
      });
      let cursor = Number.NEGATIVE_INFINITY;
      blocks.forEach(function (block) {
        const desiredCenter = desiredByBlock.has(block.id) ? desiredByBlock.get(block.id) : block.x + block.width / 2;
        const nextX = Math.max(Number.isFinite(cursor) ? cursor : desiredCenter - block.width / 2, desiredCenter - block.width / 2);
        shiftBlock(block, nextX);
        cursor = nextX + block.width + ROOT_GAP;
      });
      const centers = blocks.filter(function (block) { return desiredByBlock.has(block.id); });
      if (centers.length) {
        const desiredAverage = centers.reduce(function (sum, block) { return sum + desiredByBlock.get(block.id); }, 0) / centers.length;
        const actualAverage = centers.reduce(function (sum, block) { return sum + block.x + block.width / 2; }, 0) / centers.length;
        blocks.forEach(function (block) { shiftBlock(block, block.x + desiredAverage - actualAverage); });
      }
    }
    const componentIds = Array.from(new Set(nodes.map(function (node) { return node.component; }))).sort(function (a, b) { return a - b; });
    for (let sweep = 0; sweep < 2; sweep += 1) {
      componentIds.forEach(function (component) {
        const generations = Array.from(new Set(nodes.filter(function (node) { return node.component === component; }).map(function (node) { return node.generation; }))).sort(function (a, b) { return b - a; });
        generations.slice(1).forEach(function (generation) {
          const blocks = blocksByLayer.get(component + ":" + generation) || [];
          const desired = new Map();
          blocks.forEach(function (block) {
            const values = [];
            blockNodes(block).forEach(function (node) {
              const unionId = unionModel.primaryUnionByChild[node.id]; const union = unionId && unionById.get(unionId);
              if (!union) return;
              const parents = union.parentIds.map(function (id) { return nodeById.get(id); }).filter(Boolean);
              if (parents.length) values.push(parents.reduce(function (sum, parent) { return sum + parent.x + cardWidth / 2; }, 0) / parents.length);
            });
            if (values.length) desired.set(block.id, values.reduce(function (sum, value) { return sum + value; }, 0) / values.length);
          });
          pack(blocks, desired);
        });
        generations.slice(0, -1).reverse().forEach(function (generation) {
          const blocks = blocksByLayer.get(component + ":" + generation) || [];
          const desired = new Map();
          blocks.forEach(function (block) {
            const values = [];
            blockNodes(block).forEach(function (node) {
              (parentUnionsByPerson.get(node.id) || []).forEach(function (unionId) {
                const union = unionById.get(unionId);
                const children = union.childLinks.filter(function (link) { return link.isPrimary; }).map(function (link) { return nodeById.get(link.childId); }).filter(Boolean);
                if (children.length) values.push(children.reduce(function (sum, child) { return sum + child.x + cardWidth / 2; }, 0) / children.length);
              });
            });
            if (values.length) desired.set(block.id, values.reduce(function (sum, value) { return sum + value; }, 0) / values.length);
          });
          pack(blocks, desired);
        });
      });
    }

    const conflictIds = new Set(generationState.diagnostics.filter(function (item) { return item.severity === "error" && item.personId; }).map(function (item) { return item.personId; }));
    nodes.forEach(function (node) { node.hasGenerationConflict = conflictIds.has(node.id); });
    const siblingGroups = unionModel.siblingGroups.map(function (source) {
      const positions = source.orderedChildIds.map(function (id) { return nodeById.get(id); }).filter(Boolean);
      const result = Object.assign({}, source);
      result.subtreeIds = positions.map(function (node) { return unionModel.primaryUnionByChild[node.id] ? unionById.get(unionModel.primaryUnionByChild[node.id]).subtreeId : ""; });
      result.minX = positions.length ? Math.min.apply(null, positions.map(function (node) { return node.x; })) : 0;
      result.maxX = positions.length ? Math.max.apply(null, positions.map(function (node) { return node.x + cardWidth; })) : 0;
      result.centerX = (result.minX + result.maxX) / 2;
      const orderedX = positions.slice().sort(function (a, b) { return a.x - b.x; }).map(function (node) { return node.id; });
      result.splitCount = orderedX.join("|") === source.orderedChildIds.filter(function (id) { return nodeById.has(id); }).join("|") ? 0 : 1;
      if (result.splitCount) diagnostics.push({ type: "sibling-group-split", severity: "warning", siblingGroupId: result.id, message: "人物カードを複製しない制約により兄弟グループの順序を完全には維持できませんでした。" });
      return result;
    });

    unionModel.unionNodes.forEach(function (union) {
      const primaryChildren = union.childLinks.filter(function (link) { return link.isPrimary; }).map(function (link) { return nodeById.get(link.childId); }).filter(Boolean);
      const parents = union.parentIds.map(function (id) { return nodeById.get(id); }).filter(Boolean);
      const childCenter = primaryChildren.length ? primaryChildren.reduce(function (sum, node) { return sum + node.x + cardWidth / 2; }, 0) / primaryChildren.length : NaN;
      const parentCenter = parents.length ? parents.reduce(function (sum, node) { return sum + node.x + cardWidth / 2; }, 0) / parents.length : 0;
      union.centerX = Number.isFinite(childCenter) ? childCenter : parentCenter;
      union.leftParentId = parents.slice().sort(function (a, b) { return a.x - b.x || a.id.localeCompare(b.id); })[0] && parents.slice().sort(function (a, b) { return a.x - b.x || a.id.localeCompare(b.id); })[0].id || union.parentIds[0] || "";
      union.rightParentId = parents.slice().sort(function (a, b) { return a.x - b.x || a.id.localeCompare(b.id); }).slice(-1)[0] && parents.slice().sort(function (a, b) { return a.x - b.x || a.id.localeCompare(b.id); }).slice(-1)[0].id || union.parentIds.slice(-1)[0] || "";
      const subtree = subtreeById.get(union.subtreeId);
      const relevant = parents.concat(union.childIds.map(function (id) { return nodeById.get(id); }).filter(Boolean));
      const contentMin = relevant.length ? Math.min.apply(null, relevant.map(function (node) { return node.x; })) - SUBTREE_PADDING : union.centerX - subtree.computedWidth / 2;
      const contentMax = relevant.length ? Math.max.apply(null, relevant.map(function (node) { return node.x + cardWidth; })) + SUBTREE_PADDING : union.centerX + subtree.computedWidth / 2;
      subtree.centerX = union.centerX;
      subtree.minX = Math.min(contentMin, union.centerX - subtree.computedWidth / 2);
      subtree.maxX = Math.max(contentMax, union.centerX + subtree.computedWidth / 2);
      subtree.bounds = { x: subtree.minX, y: 0, width: subtree.maxX - subtree.minX, height: 0 };
      union.bounds = { x: subtree.minX, y: 0, width: subtree.maxX - subtree.minX, height: 0 };
    });
    const coordinatePlacementMs = performance.now() - positionStartedAt;

    const familySubtrees = Array.from(subtreeById.values()).sort(function (first, second) { return first.layoutPriority - second.layoutPriority || first.id.localeCompare(second.id); });
    return {
      nodes: nodes, nodeById: nodeById, familySubtrees: familySubtrees, subtreeById: subtreeById,
      siblingGroups: siblingGroups, placementBlocks: Array.from(placementBlocks.values()), ownerUnionByUnion: ownerUnionByUnion,
      ownedUnionsByUnion: ownedUnionsByUnion, diagnostics: diagnostics,
      timings: { familySubtreeGenerationMs: widthStartedAt - startedAt, widthCalculationMs: widthCalculationMs, coordinatePlacementMs: coordinatePlacementMs, familySubtreeTotalMs: performance.now() - startedAt }
    };
  }

  globalThis.FamilySubtreeLayout = Object.freeze({
    build: build,
    constants: Object.freeze({ CARD_WIDTH: CARD_WIDTH, CARD_HEIGHT: CARD_HEIGHT, PERSON_GAP: PERSON_GAP, SIBLING_GAP: SIBLING_GAP, SUBTREE_GAP: SUBTREE_GAP, ROOT_GAP: ROOT_GAP, SUBTREE_PADDING: SUBTREE_PADDING })
  });
}());
