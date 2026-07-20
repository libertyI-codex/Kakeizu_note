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
    const cardHeight = Number(options && options.cardHeight) || 128;
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
      atom.component = component;
      atom.generation = generation;
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

    /* Direct-lineage rails -----------------------------------------------
       Fixed generation layers stay intact. Complete placement atoms are
       translated, never individual cards, so CoupleBlocks remain adjacent.
       Direct ancestor rails are locked first; collateral atoms are then
       moved outward. No data is inferred, persisted, or rewritten here. */
    const focusNode = nodeById.get(generationState.focusPersonId);
    const spineX = focusNode ? focusNode.x + cardWidth / 2 : 0;
    const focusGeneration = focusNode ? focusNode.generation : 0;
    const parentsByChild = new Map();
    const childrenByParent = new Map();
    relationships.filter(function (item) { return item.type === "parent-child" && nodeById.has(item.fromPersonId) && nodeById.has(item.toPersonId); }).forEach(function (item) {
      if (!parentsByChild.has(item.toPersonId)) parentsByChild.set(item.toPersonId, []);
      if (!childrenByParent.has(item.fromPersonId)) childrenByParent.set(item.fromPersonId, []);
      parentsByChild.get(item.toPersonId).push(item.fromPersonId);
      childrenByParent.get(item.fromPersonId).push(item.toPersonId);
    });
    parentsByChild.forEach(function (ids) { ids.sort(); });
    childrenByParent.forEach(function (ids) { ids.sort(); });
    function traverse(startId, adjacency) {
      const visited = new Set(); const queue = [startId];
      while (queue.length) {
        const current = queue.shift();
        (adjacency.get(current) || []).forEach(function (next) {
          if (next === startId || visited.has(next)) return;
          visited.add(next); queue.push(next);
        });
      }
      return visited;
    }
    const directAncestorIds = focusNode ? traverse(focusNode.id, parentsByChild) : new Set();
    const directDescendantIds = focusNode ? traverse(focusNode.id, childrenByParent) : new Set();
    const directPersonIds = new Set([focusNode && focusNode.id].filter(Boolean));
    directAncestorIds.forEach(function (id) { directPersonIds.add(id); });
    directDescendantIds.forEach(function (id) { directPersonIds.add(id); });
    const atomByPerson = new Map();
    atomsByLayer.forEach(function (atoms) { atoms.forEach(function (atom) { atom.personIds.forEach(function (id) { atomByPerson.set(id, atom); }); }); });
    const directUnionNodeIds = new Set();
    directPersonIds.forEach(function (personId) {
      const parentUnionId = unionModel.primaryUnionByChild[personId];
      if (parentUnionId) directUnionNodeIds.add(parentUnionId);
    });
    unionModel.unionNodes.forEach(function (union) {
      if (union.parentIds.some(function (id) { return directPersonIds.has(id); }) && union.childLinks.some(function (link) { return directPersonIds.has(link.childId); })) directUnionNodeIds.add(union.id);
    });

    const compactionMoves = [];
    const lockedPersonIds = new Set(directPersonIds);
    const lockedUnionNodeIds = new Set(directUnionNodeIds);
    const lockedAtomIds = new Set();
    directPersonIds.forEach(function (personId) {
      const atom = atomByPerson.get(personId);
      if (atom) lockedAtomIds.add(atom.id);
    });
    directUnionNodeIds.forEach(function (unionId) {
      const union = unionModel.unionById.get(unionId);
      if (!union) return;
      union.parentIds.forEach(function (personId) {
        lockedPersonIds.add(personId);
        const atom = atomByPerson.get(personId);
        if (atom) lockedAtomIds.add(atom.id);
      });
    });

    function shiftAtom(atom, nextX, reason, allowLocked) {
      if (!atom || !Number.isFinite(nextX)) return false;
      if (lockedAtomIds.has(atom.id) && !allowLocked) {
        compactionMoves.push({ targetType: "placement-atom", targetId: atom.id, fromX: atom.x, toX: atom.x, reason: reason || "compaction", blockedByDirectRail: true });
        return false;
      }
      const delta = nextX - atom.x;
      if (Math.abs(delta) < 0.01) return true;
      const fromX = atom.x;
      atom.personIds.forEach(function (id) { const node = nodeById.get(id); if (node) node.x += delta; });
      atom.x = nextX;
      compactionMoves.push({ targetType: "placement-atom", targetId: atom.id, fromX: fromX, toX: nextX, reason: reason || "layout", blockedByDirectRail: false });
      return true;
    }
    function atomCenter(atom) { return atom.x + atom.width / 2; }
    function currentUnionCenter(union) {
      const parents = union.parentIds.map(function (id) { return nodeById.get(id); }).filter(Boolean);
      return parents.length ? parents.reduce(function (sum, node) { return sum + node.x + cardWidth / 2; }, 0) / parents.length : spineX;
    }
    function layerAtoms(component, generation) { return atomsByLayer.get(component + ":" + generation) || []; }
    const LOCKED_ATOM_GAP = 24;
    const COLLATERAL_GAP = 80;
    const RAIL_HALF_WIDTH = cardWidth * 0.6 + 24;
    const unionsByParent = new Map();
    unionModel.unionNodes.forEach(function (union) {
      union.parentIds.forEach(function (personId) {
        if (!unionsByParent.has(personId)) unionsByParent.set(personId, []);
        unionsByParent.get(personId).push(union);
      });
    });
    unionsByParent.forEach(function (unions) { unions.sort(function (first, second) { return first.id.localeCompare(second.id); }); });

    function resolveLockedTargets(atoms, desiredByAtom, reason) {
      const entries = atoms.filter(function (atom) { return desiredByAtom.has(atom.id); }).map(function (atom) {
        const values = desiredByAtom.get(atom.id);
        return { atom: atom, desiredX: values.reduce(function (sum, value) { return sum + value; }, 0) / values.length, x: 0 };
      }).sort(function (first, second) { return first.desiredX - second.desiredX || first.atom.id.localeCompare(second.atom.id); });
      if (!entries.length) return;
      entries.forEach(function (entry, index) {
        entry.x = index ? Math.max(entry.desiredX, entries[index - 1].x + entries[index - 1].atom.width + LOCKED_ATOM_GAP) : entry.desiredX;
      });
      const meanError = entries.reduce(function (sum, entry) { return sum + entry.x - entry.desiredX; }, 0) / entries.length;
      entries.forEach(function (entry) { entry.x -= meanError; shiftAtom(entry.atom, entry.x, reason, true); });
    }

    function moveCollateralOutside(atoms, generation) {
      const locked = atoms.filter(function (atom) { return lockedAtomIds.has(atom.id); }).sort(function (first, second) { return first.x - second.x || first.id.localeCompare(second.id); });
      if (!locked.length) return;
      locked.forEach(function (atom) {
        compactionMoves.push({ targetType: "placement-atom", targetId: atom.id, fromX: atom.x, toX: atom.x, reason: "direct-lineage-rail-lock", blockedByDirectRail: true });
      });
      const protectedMin = Math.min.apply(null, locked.map(function (atom) { return atom.x; })) - RAIL_HALF_WIDTH;
      const protectedMax = Math.max.apply(null, locked.map(function (atom) { return atom.x + atom.width; })) + RAIL_HALF_WIDTH;
      const protectedCenter = (protectedMin + protectedMax) / 2;
      const collateral = atoms.filter(function (atom) { return !lockedAtomIds.has(atom.id); }).sort(function (first, second) { return first.x - second.x || first.id.localeCompare(second.id); });
      const left = []; const right = [];
      collateral.forEach(function (atom) {
        const side = atomCenter(atom) < protectedCenter ? -1 : (atomCenter(atom) > protectedCenter ? 1 : (atom.id.localeCompare("rail:" + generation) < 0 ? -1 : 1));
        (side < 0 ? left : right).push(atom);
      });
      let leftCursor = protectedMin - COLLATERAL_GAP;
      for (let index = left.length - 1; index >= 0; index -= 1) {
        const atom = left[index];
        const nextX = Math.min(atom.x, leftCursor - atom.width);
        shiftAtom(atom, nextX, "collateral-outside-direct-rails", false);
        leftCursor = atom.x - FAMILY_ATOM_GAP;
      }
      let rightCursor = protectedMax + COLLATERAL_GAP;
      right.forEach(function (atom) {
        const nextX = Math.max(atom.x, rightCursor);
        shiftAtom(atom, nextX, "collateral-outside-direct-rails", false);
        rightCursor = atom.x + atom.width + FAMILY_ATOM_GAP;
      });
    }

    if (focusNode) {
      const focusLayer = layerAtoms(focusNode.component, focusGeneration);
      moveCollateralOutside(focusLayer, focusGeneration);

      const componentGenerations = Array.from(new Set(subtreeState.nodes.filter(function (node) { return node.component === focusNode.component; }).map(function (node) { return node.generation; })));
      const upperGenerations = componentGenerations.filter(function (value) { return value > focusGeneration; }).sort(function (a, b) { return a - b; });
      upperGenerations.forEach(function (generation) {
        const atoms = layerAtoms(focusNode.component, generation); const desiredByAtom = new Map();
        Array.from(directPersonIds).sort().forEach(function (childId) {
          const child = nodeById.get(childId); const unionId = unionModel.primaryUnionByChild[childId]; const union = unionId && unionModel.unionById.get(unionId);
          if (!child || !union || union.generation !== generation || child.generation !== generation - 1) return;
          const delta = child.x + cardWidth / 2 - currentUnionCenter(union);
          Array.from(new Set(union.parentIds.map(function (id) { return atomByPerson.get(id); }).filter(Boolean))).forEach(function (atom) {
            if (!desiredByAtom.has(atom.id)) desiredByAtom.set(atom.id, []);
            desiredByAtom.get(atom.id).push(atom.x + delta);
          });
        });
        resolveLockedTargets(atoms, desiredByAtom, "locked-ancestor-rail");
        moveCollateralOutside(atoms, generation);
      });

      const lowerGenerations = componentGenerations.filter(function (value) { return value < focusGeneration; }).sort(function (a, b) { return b - a; });
      lowerGenerations.forEach(function (generation) {
        const atoms = layerAtoms(focusNode.component, generation); const desiredByAtom = new Map();
        unionModel.unionNodes.forEach(function (union) {
          if (!directUnionNodeIds.has(union.id)) return;
          const directChildren = union.childLinks.filter(function (link) { return link.isPrimary && directPersonIds.has(link.childId); }).map(function (link) { return nodeById.get(link.childId); }).filter(function (node) { return node && node.generation === generation; });
          if (!directChildren.length || !union.parentIds.some(function (id) { return directPersonIds.has(id); })) return;
          const childMin = Math.min.apply(null, directChildren.map(function (node) { return node.x; }));
          const childMax = Math.max.apply(null, directChildren.map(function (node) { return node.x + cardWidth; }));
          const delta = currentUnionCenter(union) - (childMin + childMax) / 2;
          Array.from(new Set(directChildren.map(function (node) { return atomByPerson.get(node.id); }).filter(Boolean))).forEach(function (atom) {
            if (!desiredByAtom.has(atom.id)) desiredByAtom.set(atom.id, []);
            desiredByAtom.get(atom.id).push(atom.x + delta);
          });
        });
        resolveLockedTargets(atoms, desiredByAtom, "locked-descendant-family");
        moveCollateralOutside(atoms, generation);
      });
    }

    /* Keep collateral family branches under their own UnionNode. Direct
       rail alignment can move a CoupleBlock after FamilySubtreeLayout has
       placed its children. Re-apply that translation to the complete primary
       descendant branch instead of lengthening the children-bus. */
    const familyBranchAlignments = [];
    function primaryChildNodes(union) {
      return union.childLinks.filter(function (link) { return link.isPrimary; }).map(function (link) { return nodeById.get(link.childId); }).filter(Boolean);
    }
    function collectPrimaryDescendantAtoms(startAtoms) {
      const collected = new Map();
      let blockedByDirectRail = false;
      const queue = startAtoms.slice().sort(function (first, second) { return first.id.localeCompare(second.id); });
      while (queue.length) {
        const atom = queue.shift();
        if (!atom || collected.has(atom.id)) continue;
        if (lockedAtomIds.has(atom.id)) { blockedByDirectRail = true; continue; }
        collected.set(atom.id, atom);
        atom.personIds.slice().sort().forEach(function (personId) {
          (unionsByParent.get(personId) || []).forEach(function (union) {
            primaryChildNodes(union).forEach(function (child) {
              if (unionModel.primaryUnionByChild[child.id] !== union.id) return;
              const childAtom = atomByPerson.get(child.id);
              if (childAtom && !collected.has(childAtom.id) && !lockedAtomIds.has(childAtom.id)) queue.push(childAtom);
            });
          });
        });
      }
      return { atoms: Array.from(collected.values()), blockedByDirectRail: blockedByDirectRail };
    }
    function moveFamilyBranchOutsideCollisions(familyAtoms, parentCenter, unionId) {
      const familyIds = new Set(familyAtoms.map(function (atom) { return atom.id; }));
      const collides = familyAtoms.some(function (atom) {
        return layerAtoms(atom.component, atom.generation).some(function (other) {
          return !familyIds.has(other.id) && Math.min(atom.x + atom.width, other.x + other.width) - Math.max(atom.x, other.x) > 0.5;
        });
      });
      if (!collides) return 0;
      const side = parentCenter < spineX ? -1 : 1;
      let outwardDelta = 0;
      const layers = new Map();
      familyAtoms.forEach(function (atom) {
        const key = atom.component + ":" + atom.generation;
        if (!layers.has(key)) layers.set(key, []);
        layers.get(key).push(atom);
      });
      layers.forEach(function (branchLayer, key) {
        const parts = key.split(":");
        const others = layerAtoms(Number(parts[0]), Number(parts[1])).filter(function (atom) { return !familyIds.has(atom.id); });
        if (!others.length) return;
        const branchMin = Math.min.apply(null, branchLayer.map(function (atom) { return atom.x; }));
        const branchMax = Math.max.apply(null, branchLayer.map(function (atom) { return atom.x + atom.width; }));
        if (side < 0) {
          const otherMin = Math.min.apply(null, others.map(function (atom) { return atom.x; }));
          outwardDelta = Math.min(outwardDelta, otherMin - FAMILY_ATOM_GAP - branchMax);
        } else {
          const otherMax = Math.max.apply(null, others.map(function (atom) { return atom.x + atom.width; }));
          outwardDelta = Math.max(outwardDelta, otherMax + FAMILY_ATOM_GAP - branchMin);
        }
      });
      if (Math.abs(outwardDelta) < 0.5) return 0;
      familyAtoms.forEach(function (atom) { shiftAtom(atom, atom.x + outwardDelta, "family-branch-collision-outward:" + unionId, false); });
      return outwardDelta;
    }

    unionModel.unionNodes.slice().sort(function (first, second) {
      return second.generation - first.generation || first.id.localeCompare(second.id);
    }).forEach(function (union) {
      const children = primaryChildNodes(union);
      const parents = union.parentIds.map(function (id) { return nodeById.get(id); }).filter(Boolean);
      if (!children.length || !parents.length || directUnionNodeIds.has(union.id)) return;
      const childAtoms = Array.from(new Set(children.map(function (child) { return atomByPerson.get(child.id); }).filter(Boolean)));
      const parentAtoms = Array.from(new Set(parents.map(function (parent) { return atomByPerson.get(parent.id); }).filter(Boolean)));
      const parentCenter = currentUnionCenter(union);
      const childMin = Math.min.apply(null, children.map(function (child) { return child.x; }));
      const childMax = Math.max.apply(null, children.map(function (child) { return child.x + cardWidth; }));
      const childCenter = (childMin + childMax) / 2;
      const delta = parentCenter - childCenter;
      const alignment = {
        unionNodeId: union.id,
        familyKey: union.familyKey,
        parentIds: union.parentIds.slice(),
        childIds: children.map(function (child) { return child.id; }).sort(),
        parentCenterX: parentCenter,
        previousChildrenCenterX: childCenter,
        appliedDelta: 0,
        outwardDelta: 0,
        childrenCenterX: childCenter,
        horizontalDrift: Math.abs(delta),
        status: "already-aligned"
      };
      if (Math.abs(delta) < 0.5) { familyBranchAlignments.push(alignment); return; }
      if (childAtoms.concat(parentAtoms).some(function (atom) { return lockedAtomIds.has(atom.id); })) {
        alignment.status = "blocked-by-direct-rail";
        familyBranchAlignments.push(alignment);
        return;
      }
      const branch = collectPrimaryDescendantAtoms(childAtoms);
      if (branch.blockedByDirectRail) {
        alignment.status = "blocked-by-descendant-direct-rail";
        familyBranchAlignments.push(alignment);
        return;
      }
      branch.atoms.forEach(function (atom) { shiftAtom(atom, atom.x + delta, "family-branch-under-union:" + union.id, false); });
      const familyAtoms = Array.from(new Map(parentAtoms.concat(branch.atoms).map(function (atom) { return [atom.id, atom]; })).values());
      alignment.outwardDelta = moveFamilyBranchOutsideCollisions(familyAtoms, parentCenter, union.id);
      const movedChildren = primaryChildNodes(union);
      const movedMin = Math.min.apply(null, movedChildren.map(function (child) { return child.x; }));
      const movedMax = Math.max.apply(null, movedChildren.map(function (child) { return child.x + cardWidth; }));
      alignment.appliedDelta = delta;
      alignment.parentCenterX = currentUnionCenter(union);
      alignment.childrenCenterX = (movedMin + movedMax) / 2;
      alignment.horizontalDrift = Math.abs(alignment.parentCenterX - alignment.childrenCenterX);
      alignment.status = alignment.horizontalDrift < 0.5 ? "aligned" : "partial";
      familyBranchAlignments.push(alignment);
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

    const directConnections = [];
    const connectionKeys = new Set();
    function addDirectConnection(union, personId, role) {
      if (!union || !nodeById.has(personId)) return;
      const key = union.id + "|" + personId + "|" + role;
      if (connectionKeys.has(key)) return;
      connectionKeys.add(key);
      const person = nodeById.get(personId);
      const unionCenterX = currentUnionCenter(union);
      const targetX = person.x + cardWidth / 2;
      const drift = Math.abs(unionCenterX - targetX);
      const connection = { unionNodeId: union.id, personId: personId, role: role, generation: union.generation, personGeneration: person.generation, unionCenterX: unionCenterX, targetX: targetX, horizontalDrift: drift, locked: role === "ancestor", exceptionReason: "" };
      directConnections.push(connection);
    }
    const ancestorSpineTargets = new Set([focusNode && focusNode.id].filter(Boolean));
    directAncestorIds.forEach(function (personId) { ancestorSpineTargets.add(personId); });
    ancestorSpineTargets.forEach(function (personId) {
      const unionId = unionModel.primaryUnionByChild[personId];
      if (unionId) addDirectConnection(unionModel.unionById.get(unionId), personId, "ancestor");
    });
    unionModel.unionNodes.forEach(function (union) {
      if (!directUnionNodeIds.has(union.id)) return;
      const directParent = union.parentIds.map(function (id) { return nodeById.get(id); }).filter(function (node) { return node && directPersonIds.has(node.id); }).sort(function (first, second) { return Math.abs(first.generation - focusGeneration) - Math.abs(second.generation - focusGeneration) || stable(first.id).localeCompare(stable(second.id)); })[0];
      if (directParent && union.childLinks.some(function (link) { return directPersonIds.has(link.childId); })) addDirectConnection(union, directParent.id, "descendant");
    });

    const ancestorConnections = directConnections.filter(function (connection) { return connection.role === "ancestor"; });
    ancestorConnections.forEach(function (connection) {
      const union = unionModel.unionById.get(connection.unionNodeId);
      const parentAtoms = union ? Array.from(new Set(union.parentIds.map(function (id) { return atomByPerson.get(id); }).filter(Boolean))) : [];
      const conflicting = ancestorConnections.find(function (other) {
        if (other === connection || other.generation !== connection.generation) return false;
        const otherUnion = unionModel.unionById.get(other.unionNodeId);
        const otherAtoms = otherUnion ? Array.from(new Set(otherUnion.parentIds.map(function (id) { return atomByPerson.get(id); }).filter(Boolean))) : [];
        if (!parentAtoms.length || !otherAtoms.length || parentAtoms.some(function (atom) { return otherAtoms.includes(atom); })) return false;
        const required = parentAtoms.reduce(function (sum, atom) { return sum + atom.width; }, 0) / parentAtoms.length / 2 + otherAtoms.reduce(function (sum, atom) { return sum + atom.width; }, 0) / otherAtoms.length / 2 + LOCKED_ATOM_GAP;
        return Math.abs(connection.targetX - other.targetX) < required;
      });
      if (conflicting && connection.horizontalDrift > 16) connection.exceptionReason = "locked-couple-geometry-conflict";
    });

    const directLineageRails = ancestorConnections.map(function (connection) {
      const person = nodeById.get(connection.personId);
      const union = unionModel.unionById.get(connection.unionNodeId);
      const parentNodes = union ? union.parentIds.map(function (id) { return nodeById.get(id); }).filter(Boolean) : [];
      const sourceY = parentNodes.length ? Math.max.apply(null, parentNodes.map(function (node) { return node.y + cardHeight / 2; })) : (person ? person.y - 1 : 0);
      const targetY = person ? person.y : sourceY;
      return {
        id: "direct-rail:" + connection.unionNodeId + "--" + connection.personId,
        targetPersonId: connection.personId,
        sourceUnionNodeId: connection.unionNodeId,
        targetX: connection.targetX,
        unionX: connection.unionCenterX,
        horizontalDrift: connection.horizontalDrift,
        generationFrom: connection.generation,
        generationTo: connection.personGeneration,
        sourceY: sourceY,
        targetY: targetY,
        isPrimary: connection.personId === (focusNode && focusNode.id) || directAncestorIds.has(connection.personId),
        locked: true,
        exceptionReason: connection.exceptionReason
      };
    }).sort(function (first, second) { return second.generationFrom - first.generationFrom || first.id.localeCompare(second.id); });
    const spineExclusionZones = directLineageRails.map(function (rail) {
      const minX = Math.min(rail.targetX, rail.unionX) - RAIL_HALF_WIDTH;
      const maxX = Math.max(rail.targetX, rail.unionX) + RAIL_HALF_WIDTH;
      return {
        railId: rail.id,
        centerX: rail.targetX,
        minX: minX,
        maxX: maxX,
        topY: Math.min(rail.sourceY, rail.targetY),
        bottomY: Math.max(rail.sourceY, rail.targetY),
        sourceUnionNodeId: rail.sourceUnionNodeId,
        targetPersonId: rail.targetPersonId
      };
    });
    const collateralAtomIds = [];
    atomsByLayer.forEach(function (atoms) {
      atoms.forEach(function (atom) {
        if (atom.component !== (focusNode && focusNode.component) || atom.personIds.some(function (id) { return directPersonIds.has(id); })) return;
        collateralAtomIds.push(atom.id);
        if (atom.x < spineX && atom.x + atom.width > spineX) diagnostics.push({ type: "collateral-subtree-crosses-spine", severity: "warning", placementAtomId: atom.id, personIds: atom.personIds.slice(), message: "傍系FamilySubtreeが直系スパインを横切っています。" });
      });
    });

    const directSpine = {
      focusPersonId: focusNode && focusNode.id || "",
      spineX: spineX,
      focusGeneration: focusGeneration,
      directAncestorIds: Array.from(directAncestorIds).sort(),
      directDescendantIds: Array.from(directDescendantIds).sort(),
      directPersonIds: Array.from(directPersonIds).sort(),
      directUnionNodeIds: Array.from(directUnionNodeIds).sort(),
      directConnections: directConnections,
      directLineageRails: directLineageRails,
      spineExclusionZones: spineExclusionZones,
      lockedUnionNodeIds: Array.from(lockedUnionNodeIds).sort(),
      lockedPersonIds: Array.from(lockedPersonIds).sort(),
      compactionMoves: compactionMoves,
      familyBranchAlignments: familyBranchAlignments,
      viewBoxExpansion: null,
      initialViewportTarget: focusNode ? { centerX: spineX, centerY: focusNode.y + cardHeight / 2, focusPersonId: focusNode.id, preferredScale: 1 } : null,
      collateralAtomIds: collateralAtomIds.sort(),
      bounds: null
    };

    return {
      coupleBlocks: coupleBlocks,
      coupleByUnionId: coupleByUnionId,
      placementAtoms: Array.from(atomsByLayer.values()).reduce(function (all, atoms) { return all.concat(atoms); }, []),
      directSpine: directSpine,
      diagnostics: diagnostics,
      timings: { coupleBlockGenerationMs: performance.now() - startedAt }
    };
  }

  globalThis.CoupleBlockLayout = Object.freeze({
    apply: apply,
    constants: Object.freeze({ COUPLE_GAP: COUPLE_GAP, SIBLING_ATOM_GAP: SIBLING_ATOM_GAP, FAMILY_ATOM_GAP: FAMILY_ATOM_GAP })
  });
}());
