(function () {
  "use strict";

  const CARD_WIDTH = 184;
  const COUPLE_GAP = 30;
  const SIBLING_ATOM_GAP = 28;
  const FAMILY_ATOM_GAP = 64;
  const SUBTREE_PADDING = 36;

  function stable(value) { return String(value === undefined || value === null ? "" : value); }
  function statusOf(relationship) {
    const value = relationship && relationship.status;
    return ["current", "divorced", "separated", "ended", "unknown"].includes(value) ? value : "current";
  }
  function statusRank(relationship) {
    return { current: 0, unknown: 1, separated: 2, divorced: 3, ended: 4 }[statusOf(relationship)];
  }
  function generationOf(id, state) {
    const relative = state.personGenerations[id];
    return Number.isFinite(relative) ? relative : (Number.isFinite(state.localGenerations[id]) ? state.localGenerations[id] : 0);
  }
  function componentOf(id, state) { return Number.isFinite(state.componentByPerson[id]) ? state.componentByPerson[id] : 0; }

  function apply(persons, relationships, generationState, unionModel, subtreeState, options) {
    const startedAt = performance.now();
    const cardWidth = Number(options && options.cardWidth) || CARD_WIDTH;
    const nodeById = subtreeState.nodeById;
    const diagnostics = [];
    const siblingMembership = new Map();
    unionModel.siblingGroups.forEach(function (group) {
      group.orderedChildIds.forEach(function (id, index) {
        if (!siblingMembership.has(id)) siblingMembership.set(id, []);
        siblingMembership.get(id).push({ groupId: group.id, index: index, count: group.orderedChildIds.length });
      });
    });

    const coupleBlocks = unionModel.unionNodes.filter(function (union) {
      return union.partnerRelationship && union.parentIds.length === 2 && union.parentIds.every(function (id) { return nodeById.has(id); });
    }).map(function (union) {
      const relationship = union.partnerRelationship;
      const firstId = relationship.fromPersonId;
      const secondId = relationship.toPersonId;
      const firstNode = nodeById.get(firstId);
      const secondNode = nodeById.get(secondId);
      const sameGeneration = firstNode.generation === secondNode.generation && firstNode.component === secondNode.component;
      return {
        id: "couple:" + stable(relationship.id),
        unionNodeId: union.id,
        familyKey: union.familyKey,
        leftPersonId: firstNode.x <= secondNode.x ? firstId : secondId,
        rightPersonId: firstNode.x <= secondNode.x ? secondId : firstId,
        relationshipId: relationship.id,
        relationshipType: relationship.relationshipType === "marriage" ? "marriage" : "partnership",
        status: statusOf(relationship),
        generation: sameGeneration ? firstNode.generation : null,
        component: sameGeneration ? firstNode.component : null,
        centerX: (firstNode.x + secondNode.x + cardWidth) / 2,
        minX: Math.min(firstNode.x, secondNode.x),
        maxX: Math.max(firstNode.x, secondNode.x) + cardWidth,
        childIds: union.childIds.slice(),
        relationship: relationship,
        unionNode: union,
        adjacent: false,
        portAssignments: {}
      };
    }).sort(function (first, second) {
      return statusRank(first.relationship) - statusRank(second.relationship) || stable(first.relationshipId).localeCompare(stable(second.relationshipId));
    });

    const validBlocks = coupleBlocks.filter(function (block) { return Number.isFinite(block.generation) && Number.isFinite(block.component); });
    const parent = new Map();
    validBlocks.forEach(function (block) {
      [block.relationship.fromPersonId, block.relationship.toPersonId].forEach(function (id) { if (!parent.has(id)) parent.set(id, id); });
    });
    function find(id) {
      let value = id;
      while (parent.get(value) !== value) value = parent.get(value);
      let cursor = id;
      while (parent.get(cursor) !== cursor) { const next = parent.get(cursor); parent.set(cursor, value); cursor = next; }
      return value;
    }
    function join(first, second) {
      const a = find(first); const b = find(second);
      if (a !== b) parent.set(b, a < b ? a : b);
    }
    validBlocks.forEach(function (block) { join(block.relationship.fromPersonId, block.relationship.toPersonId); });

    function orientPair(firstId, secondId) {
      const firstMembership = siblingMembership.get(firstId) || [];
      const secondMembership = siblingMembership.get(secondId) || [];
      if (firstMembership.length && !secondMembership.length) {
        const membership = firstMembership[0];
        return membership.index < (membership.count - 1) / 2 ? [secondId, firstId] : [firstId, secondId];
      }
      if (secondMembership.length && !firstMembership.length) {
        const membership = secondMembership[0];
        return membership.index < (membership.count - 1) / 2 ? [firstId, secondId] : [secondId, firstId];
      }
      const firstNode = nodeById.get(firstId); const secondNode = nodeById.get(secondId);
      if (firstNode && secondNode && Math.abs(firstNode.x - secondNode.x) > 0.1) return firstNode.x < secondNode.x ? [firstId, secondId] : [secondId, firstId];
      return stable(firstId).localeCompare(stable(secondId)) <= 0 ? [firstId, secondId] : [secondId, firstId];
    }

    const blocksByRoot = new Map();
    validBlocks.forEach(function (block) {
      const root = find(block.relationship.fromPersonId);
      if (!blocksByRoot.has(root)) blocksByRoot.set(root, []);
      blocksByRoot.get(root).push(block);
    });
    const orderedComponents = [];
    blocksByRoot.forEach(function (blocks, root) {
      blocks.sort(function (first, second) {
        return statusRank(first.relationship) - statusRank(second.relationship) || (second.childIds.length - first.childIds.length) || stable(first.relationshipId).localeCompare(stable(second.relationshipId));
      });
      const seed = blocks[0];
      const order = orientPair(seed.relationship.fromPersonId, seed.relationship.toPersonId);
      const pending = blocks.slice(1);
      let guard = pending.length + 2;
      while (pending.length && guard > 0) {
        guard -= 1;
        let changed = false;
        for (let index = 0; index < pending.length; index += 1) {
          const block = pending[index];
          const firstId = block.relationship.fromPersonId; const secondId = block.relationship.toPersonId;
          const firstIndex = order.indexOf(firstId); const secondIndex = order.indexOf(secondId);
          if (firstIndex >= 0 && secondIndex >= 0) { pending.splice(index, 1); index -= 1; changed = true; continue; }
          if (firstIndex < 0 && secondIndex < 0) continue;
          const knownId = firstIndex >= 0 ? firstId : secondId;
          const unknownId = firstIndex >= 0 ? secondId : firstId;
          const knownIndex = order.indexOf(knownId);
          if (knownIndex === 0) order.unshift(unknownId);
          else if (knownIndex === order.length - 1) order.push(unknownId);
          else {
            const unknownNode = nodeById.get(unknownId);
            const leftNode = nodeById.get(order[0]); const rightNode = nodeById.get(order[order.length - 1]);
            if (unknownNode && leftNode && rightNode && Math.abs(unknownNode.x - leftNode.x) <= Math.abs(unknownNode.x - rightNode.x)) order.unshift(unknownId);
            else order.push(unknownId);
          }
          pending.splice(index, 1); index -= 1; changed = true;
        }
        if (!changed && pending.length) {
          const block = pending.shift();
          orientPair(block.relationship.fromPersonId, block.relationship.toPersonId).forEach(function (id) { if (!order.includes(id)) order.push(id); });
        }
      }
      orderedComponents.push({ id: "couple-component:" + root, personIds: order, blocks: blocks, component: seed.component, generation: seed.generation });
    });

    const componentByPerson = new Map();
    orderedComponents.forEach(function (component) { component.personIds.forEach(function (id) { componentByPerson.set(id, component); }); });
    const atomsByLayer = new Map();
    function addAtom(component, generation, atom) {
      const key = component + ":" + generation;
      if (!atomsByLayer.has(key)) atomsByLayer.set(key, []);
      atomsByLayer.get(key).push(atom);
    }
    orderedComponents.forEach(function (component) {
      const currentCenters = component.personIds.map(function (id) { const node = nodeById.get(id); return node.x + cardWidth / 2; });
      const childCenters = component.blocks.reduce(function (all, block) {
        return all.concat(block.childIds.map(function (id) { const node = nodeById.get(id); return node ? node.x + cardWidth / 2 : null; }).filter(Number.isFinite));
      }, []);
      const centers = currentCenters.concat(childCenters);
      addAtom(component.component, component.generation, {
        id: component.id,
        personIds: component.personIds.slice(),
        width: component.personIds.length * cardWidth + Math.max(0, component.personIds.length - 1) * COUPLE_GAP,
        desiredCenter: centers.reduce(function (sum, value) { return sum + value; }, 0) / Math.max(1, centers.length),
        siblingGroupIds: new Set(component.personIds.reduce(function (all, id) { return all.concat((siblingMembership.get(id) || []).map(function (item) { return item.groupId; })); }, []))
      });
    });
    subtreeState.nodes.forEach(function (node) {
      if (componentByPerson.has(node.id)) return;
      addAtom(node.component, node.generation, {
        id: "single-atom:" + node.id, personIds: [node.id], width: cardWidth,
        desiredCenter: node.x + cardWidth / 2,
        siblingGroupIds: new Set((siblingMembership.get(node.id) || []).map(function (item) { return item.groupId; }))
      });
    });

    function atomGap(first, second) {
      const sharedSibling = Array.from(first.siblingGroupIds).some(function (id) { return second.siblingGroupIds.has(id); });
      return sharedSibling ? SIBLING_ATOM_GAP : FAMILY_ATOM_GAP;
    }
    atomsByLayer.forEach(function (atoms) {
      atoms.sort(function (first, second) { return first.desiredCenter - second.desiredCenter || first.id.localeCompare(second.id); });
      let totalWidth = atoms.reduce(function (sum, atom) { return sum + atom.width; }, 0);
      for (let index = 1; index < atoms.length; index += 1) totalWidth += atomGap(atoms[index - 1], atoms[index]);
      const desiredAverage = atoms.reduce(function (sum, atom) { return sum + atom.desiredCenter; }, 0) / Math.max(1, atoms.length);
      let cursor = desiredAverage - totalWidth / 2;
      atoms.forEach(function (atom, atomIndex) {
        if (atomIndex) cursor += atomGap(atoms[atomIndex - 1], atom);
        atom.x = cursor;
        atom.personIds.forEach(function (id, personIndex) {
          const node = nodeById.get(id);
          if (node) node.x = cursor + personIndex * (cardWidth + COUPLE_GAP);
        });
        cursor += atom.width;
      });
    });

    coupleBlocks.forEach(function (block) {
      const firstNode = nodeById.get(block.relationship.fromPersonId); const secondNode = nodeById.get(block.relationship.toPersonId);
      const ordered = [firstNode, secondNode].sort(function (first, second) { return first.x - second.x || stable(first.id).localeCompare(stable(second.id)); });
      block.leftPersonId = ordered[0].id; block.rightPersonId = ordered[1].id;
      block.minX = ordered[0].x; block.maxX = ordered[1].x + cardWidth; block.centerX = (ordered[0].x + cardWidth + ordered[1].x) / 2;
      block.adjacent = Math.abs(ordered[1].x - (ordered[0].x + cardWidth) - COUPLE_GAP) < 1;
      if (block.status === "current" && Number.isFinite(block.generation) && !block.adjacent) diagnostics.push({ type: "couple-block-not-adjacent", severity: "warning", coupleBlockId: block.id, relationshipId: block.relationshipId, message: "複数パートナー等の制約により、現在のパートナーを完全には隣接配置できませんでした。" });
    });

    const refreshedSiblingGroups = unionModel.siblingGroups.map(function (source) {
      const positions = source.orderedChildIds.map(function (id) { return nodeById.get(id); }).filter(Boolean);
      const result = Object.assign({}, source);
      result.subtreeIds = positions.map(function (node) { const unionId = unionModel.primaryUnionByChild[node.id]; return unionId && unionModel.unionById.get(unionId) ? unionModel.unionById.get(unionId).subtreeId : ""; });
      result.minX = positions.length ? Math.min.apply(null, positions.map(function (node) { return node.x; })) : 0;
      result.maxX = positions.length ? Math.max.apply(null, positions.map(function (node) { return node.x + cardWidth; })) : 0;
      result.centerX = (result.minX + result.maxX) / 2;
      const orderedX = positions.slice().sort(function (a, b) { return a.x - b.x; }).map(function (node) { return node.id; });
      result.splitCount = orderedX.join("|") === source.orderedChildIds.filter(function (id) { return nodeById.has(id); }).join("|") ? 0 : 1;
      return result;
    });
    subtreeState.siblingGroups = refreshedSiblingGroups;

    const coupleByUnionId = new Map(coupleBlocks.map(function (block) { return [block.unionNodeId, block]; }));
    unionModel.unionNodes.forEach(function (union) {
      const primaryChildren = union.childLinks.filter(function (link) { return link.isPrimary; }).map(function (link) { return nodeById.get(link.childId); }).filter(Boolean);
      const parents = union.parentIds.map(function (id) { return nodeById.get(id); }).filter(Boolean);
      const childCenter = primaryChildren.length ? primaryChildren.reduce(function (sum, node) { return sum + node.x + cardWidth / 2; }, 0) / primaryChildren.length : NaN;
      const parentCenter = parents.length ? parents.reduce(function (sum, node) { return sum + node.x + cardWidth / 2; }, 0) / parents.length : 0;
      const couple = coupleByUnionId.get(union.id);
      union.centerX = couple ? couple.centerX : (Number.isFinite(childCenter) ? childCenter : parentCenter);
      const orderedParents = parents.slice().sort(function (a, b) { return a.x - b.x || stable(a.id).localeCompare(stable(b.id)); });
      union.leftParentId = orderedParents.length ? orderedParents[0].id : (union.parentIds[0] || "");
      union.rightParentId = orderedParents.length ? orderedParents[orderedParents.length - 1].id : (union.parentIds[union.parentIds.length - 1] || "");
      const subtree = subtreeState.subtreeById.get(union.subtreeId);
      if (!subtree) return;
      const relevant = parents.concat(union.childIds.map(function (id) { return nodeById.get(id); }).filter(Boolean));
      const contentMin = relevant.length ? Math.min.apply(null, relevant.map(function (node) { return node.x; })) - SUBTREE_PADDING : union.centerX - subtree.computedWidth / 2;
      const contentMax = relevant.length ? Math.max.apply(null, relevant.map(function (node) { return node.x + cardWidth; })) + SUBTREE_PADDING : union.centerX + subtree.computedWidth / 2;
      subtree.centerX = union.centerX;
      subtree.minX = Math.min(contentMin, union.centerX - subtree.computedWidth / 2);
      subtree.maxX = Math.max(contentMax, union.centerX + subtree.computedWidth / 2);
      subtree.bounds = { x: subtree.minX, y: 0, width: subtree.maxX - subtree.minX, height: 0 };
      union.bounds = Object.assign({}, subtree.bounds);
    });

    return {
      coupleBlocks: coupleBlocks,
      coupleByUnionId: coupleByUnionId,
      diagnostics: diagnostics,
      timings: { coupleBlockGenerationMs: performance.now() - startedAt }
    };
  }

  globalThis.CoupleBlockLayout = Object.freeze({
    apply: apply,
    constants: Object.freeze({ COUPLE_GAP: COUPLE_GAP, SIBLING_ATOM_GAP: SIBLING_ATOM_GAP, FAMILY_ATOM_GAP: FAMILY_ATOM_GAP })
  });
}());
