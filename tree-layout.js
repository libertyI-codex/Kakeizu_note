(function () {
  "use strict";

  const CARD_WIDTH = 184;
  const CARD_HEIGHT = 128;
  const PERSON_GAP = 28;
  const FAMILY_GAP = 76;
  const GENERATION_GAP = 112;
  const DISCONNECTED_GAP = 96;
  const PADDING = 84;
  const FAMILY_LANE_GAP = 14;
  const FAMILY_INTERVAL_MARGIN = 12;
  const FAMILY_BUS_STUB = 8;

  function displayName(person) {
    return ((person.familyName || "") + " " + (person.givenName || "")).trim();
  }

  function comparePeople(a, b) {
    const birthA = a.birthDate || "";
    const birthB = b.birthDate || "";
    if (birthA && birthB && birthA !== birthB) return birthA.localeCompare(birthB);
    if (birthA && !birthB) return -1;
    if (!birthA && birthB) return 1;
    const createdA = a.createdAt || "";
    const createdB = b.createdAt || "";
    if (createdA !== createdB) return createdA.localeCompare(createdB);
    return displayName(a).localeCompare(displayName(b), "ja");
  }

  function buildAdjacency(persons, relationships) {
    const adjacency = new Map();
    persons.forEach(function (person) { adjacency.set(person.id, []); });
    relationships.forEach(function (relationship) {
      if (!adjacency.has(relationship.fromPersonId) || !adjacency.has(relationship.toPersonId)) return;
      adjacency.get(relationship.fromPersonId).push(relationship.toPersonId);
      adjacency.get(relationship.toPersonId).push(relationship.fromPersonId);
    });
    return adjacency;
  }

  function buildComponents(persons, adjacency, focusPersonId) {
    const visited = new Set();
    const components = [];
    persons.forEach(function (person) {
      if (visited.has(person.id)) return;
      const ids = [];
      const queue = [person.id];
      visited.add(person.id);
      while (queue.length) {
        const id = queue.shift();
        ids.push(id);
        (adjacency.get(id) || []).forEach(function (next) {
          if (visited.has(next)) return;
          visited.add(next);
          queue.push(next);
        });
      }
      components.push(ids);
    });
    components.sort(function (a, b) {
      if (a.includes(focusPersonId)) return -1;
      if (b.includes(focusPersonId)) return 1;
      if (a.length !== b.length) return b.length - a.length;
      return a[0].localeCompare(b[0]);
    });
    const componentByPerson = new Map();
    components.forEach(function (ids, index) {
      ids.forEach(function (id) { componentByPerson.set(id, index); });
    });
    return { components: components, componentByPerson: componentByPerson };
  }

  function buildDistances(adjacency, focusPersonId) {
    const distances = new Map();
    if (!focusPersonId || !adjacency.has(focusPersonId)) return distances;
    const queue = [focusPersonId];
    distances.set(focusPersonId, 0);
    while (queue.length) {
      const current = queue.shift();
      adjacency.get(current).forEach(function (next) {
        if (distances.has(next)) return;
        distances.set(next, distances.get(current) + 1);
        queue.push(next);
      });
    }
    return distances;
  }

  function assignGenerations(persons, relationships, componentsInfo) {
    const generation = new Map();
    const indegree = new Map();
    const children = new Map();
    persons.forEach(function (person) {
      generation.set(person.id, 0);
      indegree.set(person.id, 0);
      children.set(person.id, []);
    });
    const parentLinks = relationships.filter(function (relationship) { return relationship.type === "parent-child"; });
    const partnerLinks = relationships.filter(function (relationship) { return relationship.type === "partner"; });
    parentLinks.forEach(function (relationship) {
      if (!indegree.has(relationship.fromPersonId) || !indegree.has(relationship.toPersonId)) return;
      children.get(relationship.fromPersonId).push(relationship.toPersonId);
      indegree.set(relationship.toPersonId, indegree.get(relationship.toPersonId) + 1);
    });
    const queue = persons.filter(function (person) { return indegree.get(person.id) === 0; }).map(function (person) { return person.id; });
    const workingIndegree = new Map(indegree);
    while (queue.length) {
      const parentId = queue.shift();
      children.get(parentId).forEach(function (childId) {
        generation.set(childId, Math.max(generation.get(childId), generation.get(parentId) + 1));
        workingIndegree.set(childId, workingIndegree.get(childId) - 1);
        if (workingIndegree.get(childId) === 0) queue.push(childId);
      });
    }
    const limit = Math.max(3, persons.length * 2);
    for (let pass = 0; pass < limit; pass += 1) {
      let changed = false;
      partnerLinks.forEach(function (relationship) {
        const from = generation.get(relationship.fromPersonId);
        const to = generation.get(relationship.toPersonId);
        if (from === undefined || to === undefined) return;
        const shared = Math.max(from, to);
        if (from !== shared) { generation.set(relationship.fromPersonId, shared); changed = true; }
        if (to !== shared) { generation.set(relationship.toPersonId, shared); changed = true; }
      });
      parentLinks.forEach(function (relationship) {
        const parentGeneration = generation.get(relationship.fromPersonId);
        const childGeneration = generation.get(relationship.toPersonId);
        if (parentGeneration === undefined || childGeneration === undefined) return;
        if (childGeneration < parentGeneration + 1) {
          generation.set(relationship.toPersonId, parentGeneration + 1);
          changed = true;
        }
      });
      if (!changed) break;
    }

    const primaryIds = componentsInfo.components[0] || [];
    const primaryValues = primaryIds.map(function (id) { return generation.get(id) || 0; });
    const primaryMin = primaryValues.length ? Math.min.apply(null, primaryValues) : 0;
    primaryIds.forEach(function (id) { generation.set(id, (generation.get(id) || 0) - primaryMin); });
    const primaryMax = primaryIds.length ? Math.max.apply(null, primaryIds.map(function (id) { return generation.get(id) || 0; })) : 0;
    componentsInfo.components.slice(1).forEach(function (ids) {
      const values = ids.map(function (id) { return generation.get(id) || 0; });
      const minimum = values.length ? Math.min.apply(null, values) : 0;
      ids.forEach(function (id) {
        generation.set(id, primaryMax + 2 + (generation.get(id) || 0) - minimum);
      });
    });
    return { generation: generation, primaryMax: primaryMax };
  }

  function makePartnerGroups(persons, relationships, generationMap, focusPersonId, distances) {
    const parent = new Map();
    persons.forEach(function (person) { parent.set(person.id, person.id); });
    function find(id) {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      let current = id;
      while (parent.get(current) !== current) {
        const next = parent.get(current);
        parent.set(current, root);
        current = next;
      }
      return root;
    }
    function union(a, b) {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootB, rootA);
    }
    const partnerRelationships = relationships.filter(function (relationship) { return relationship.type === "partner"; });
    partnerRelationships.forEach(function (relationship) {
      if (!parent.has(relationship.fromPersonId) || !parent.has(relationship.toPersonId)) return;
      if (generationMap.get(relationship.fromPersonId) === generationMap.get(relationship.toPersonId)) union(relationship.fromPersonId, relationship.toPersonId);
    });
    const groups = new Map();
    persons.forEach(function (person) {
      const key = find(person.id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(person);
    });
    groups.forEach(function (group) {
      if (group.length < 2) return;
      const degree = new Map(group.map(function (person) { return [person.id, 0]; }));
      partnerRelationships.forEach(function (relationship) {
        if (degree.has(relationship.fromPersonId) && degree.has(relationship.toPersonId)) {
          degree.set(relationship.fromPersonId, degree.get(relationship.fromPersonId) + 1);
          degree.set(relationship.toPersonId, degree.get(relationship.toPersonId) + 1);
        }
      });
      const anchor = group.find(function (person) { return person.id === focusPersonId; }) || group.slice().sort(function (a, b) {
        if (degree.get(a.id) !== degree.get(b.id)) return degree.get(b.id) - degree.get(a.id);
        const distanceA = distances.has(a.id) ? distances.get(a.id) : 9999;
        const distanceB = distances.has(b.id) ? distances.get(b.id) : 9999;
        return distanceA - distanceB || comparePeople(a, b);
      })[0];
      const partners = group.filter(function (person) { return person.id !== anchor.id; });
      partners.sort(function (a, b) {
        function orderFor(person) {
          const relationship = partnerRelationships.find(function (item) {
            return (item.fromPersonId === anchor.id && item.toPersonId === person.id) || (item.toPersonId === anchor.id && item.fromPersonId === person.id);
          });
          return relationship && Number.isFinite(Number(relationship.sortOrder)) ? Number(relationship.sortOrder) : Number.MAX_SAFE_INTEGER;
        }
        return orderFor(a) - orderFor(b) || comparePeople(a, b);
      });
      let arranged;
      if (partners.length === 1) arranged = [anchor, partners[0]];
      else if (partners.length === 2) arranged = [partners[0], anchor, partners[1]];
      else {
        const midpoint = Math.ceil(partners.length / 2);
        arranged = partners.slice(0, midpoint).concat(anchor, partners.slice(midpoint));
      }
      group.splice.apply(group, [0, group.length].concat(arranged));
    });
    return Array.from(groups.values());
  }

  function familyPairKey(firstId, secondId) {
    return [firstId, secondId].sort().join("--");
  }

  function buildFamilyUnits(persons, relationships) {
    const personIds = new Set(persons.map(function (person) { return person.id; }));
    const partnerByKey = new Map();
    const units = new Map();

    function ensurePartnerUnit(relationship) {
      const parentIds = [relationship.fromPersonId, relationship.toPersonId].sort();
      const familyKey = familyPairKey(parentIds[0], parentIds[1]);
      if (!units.has(familyKey)) {
        units.set(familyKey, {
          familyKey: familyKey,
          parentIds: parentIds,
          partnerRelationship: relationship,
          children: []
        });
      }
      return units.get(familyKey);
    }

    function ensureSingleParentUnit(parentId) {
      const familyKey = parentId;
      if (!units.has(familyKey)) {
        units.set(familyKey, {
          familyKey: familyKey,
          parentIds: [parentId],
          partnerRelationship: null,
          children: []
        });
      }
      return units.get(familyKey);
    }

    relationships.forEach(function (relationship) {
      if (relationship.type !== "partner") return;
      if (!personIds.has(relationship.fromPersonId) || !personIds.has(relationship.toPersonId)) return;
      const key = familyPairKey(relationship.fromPersonId, relationship.toPersonId);
      if (partnerByKey.has(key)) return;
      partnerByKey.set(key, relationship);
      ensurePartnerUnit(relationship);
    });

    const parentsByChild = new Map();
    relationships.forEach(function (relationship) {
      if (relationship.type !== "parent-child") return;
      if (!personIds.has(relationship.fromPersonId) || !personIds.has(relationship.toPersonId)) return;
      if (!parentsByChild.has(relationship.toPersonId)) parentsByChild.set(relationship.toPersonId, []);
      parentsByChild.get(relationship.toPersonId).push(relationship);
    });

    parentsByChild.forEach(function (parentRelationships, childId) {
      const usedRelationships = new Set();
      for (let first = 0; first < parentRelationships.length; first += 1) {
        for (let second = first + 1; second < parentRelationships.length; second += 1) {
          const firstRelationship = parentRelationships[first];
          const secondRelationship = parentRelationships[second];
          if (usedRelationships.has(firstRelationship) || usedRelationships.has(secondRelationship)) continue;
          const pairKey = familyPairKey(firstRelationship.fromPersonId, secondRelationship.fromPersonId);
          const partnerRelationship = partnerByKey.get(pairKey);
          if (!partnerRelationship) continue;
          const unit = ensurePartnerUnit(partnerRelationship);
          if (!unit.children.some(function (child) { return child.id === childId; })) {
            unit.children.push({ id: childId, relationships: [firstRelationship, secondRelationship] });
          }
          usedRelationships.add(firstRelationship);
          usedRelationships.add(secondRelationship);
        }
      }
      parentRelationships.forEach(function (relationship) {
        if (usedRelationships.has(relationship)) return;
        const unit = ensureSingleParentUnit(relationship.fromPersonId);
        const existing = unit.children.find(function (child) { return child.id === childId; });
        if (existing) existing.relationships.push(relationship);
        else unit.children.push({ id: childId, relationships: [relationship] });
      });
    });

    return Array.from(units.values()).sort(function (first, second) {
      const firstCreated = first.partnerRelationship && first.partnerRelationship.createdAt || "";
      const secondCreated = second.partnerRelationship && second.partnerRelationship.createdAt || "";
      return firstCreated.localeCompare(secondCreated) || first.familyKey.localeCompare(second.familyKey);
    });
  }

  function intervalsAreSeparated(first, second) {
    return first.end + FAMILY_INTERVAL_MARGIN < second.start || second.end + FAMILY_INTERVAL_MARGIN < first.start;
  }

  function routeFamilyUnits(persons, relationships, nodes, cardWidth, cardHeight) {
    const nodeMap = new Map(nodes.map(function (node) { return [node.id, node]; }));
    const units = buildFamilyUnits(persons, relationships);
    const routes = units.map(function (unit) {
      const parentNodes = unit.parentIds.map(function (id) { return nodeMap.get(id); }).filter(Boolean);
      const children = unit.children.map(function (child) {
        return { id: child.id, node: nodeMap.get(child.id), relationships: child.relationships };
      }).filter(function (child) { return child.node; }).sort(function (first, second) {
        return first.node.x - second.node.x || first.id.localeCompare(second.id);
      });
      const sourceX = parentNodes.length
        ? parentNodes.reduce(function (sum, node) { return sum + node.x + cardWidth / 2; }, 0) / parentNodes.length
        : 0;
      const parentBottom = parentNodes.length ? Math.max.apply(null, parentNodes.map(function (node) { return node.y + cardHeight; })) : 0;
      let partnerHasObstacles = false;
      if (parentNodes.length === 2 && parentNodes[0].generation === parentNodes[1].generation) {
        const leftCenter = Math.min(parentNodes[0].x, parentNodes[1].x) + cardWidth / 2;
        const rightCenter = Math.max(parentNodes[0].x, parentNodes[1].x) + cardWidth / 2;
        partnerHasObstacles = nodes.some(function (node) {
          if (unit.parentIds.includes(node.id) || node.generation !== parentNodes[0].generation) return false;
          const center = node.x + cardWidth / 2;
          return center > leftCenter && center < rightCenter;
        });
      }
      const partnerRouteY = parentBottom + 10;
      const sourceY = partnerHasObstacles
        ? partnerRouteY
        : (parentNodes.length > 1 && parentNodes.every(function (node) { return node.generation === parentNodes[0].generation; })
          ? parentNodes.reduce(function (sum, node) { return sum + node.y; }, 0) / parentNodes.length + cardHeight / 2
          : parentBottom);
      const childTop = children.length ? Math.min.apply(null, children.map(function (child) { return child.node.y; })) : parentBottom;
      const centers = children.map(function (child) { return child.node.x + cardWidth / 2; });
      let intervalStart = centers.length ? Math.min.apply(null, [sourceX].concat(centers)) : sourceX;
      let intervalEnd = centers.length ? Math.max.apply(null, [sourceX].concat(centers)) : sourceX;
      if (children.length && intervalEnd - intervalStart < FAMILY_BUS_STUB * 2) {
        intervalStart -= FAMILY_BUS_STUB;
        intervalEnd += FAMILY_BUS_STUB;
      }
      const parentGeneration = parentNodes.length ? Math.max.apply(null, parentNodes.map(function (node) { return node.generation; })) : 0;
      const childGeneration = children.length ? Math.min.apply(null, children.map(function (child) { return child.node.generation; })) : parentGeneration;
      const component = parentNodes[0] ? parentNodes[0].component : (children[0] ? children[0].node.component : 0);
      return Object.assign({}, unit, {
        parentNodes: parentNodes,
        children: children,
        sourceX: sourceX,
        sourceY: sourceY,
        partnerHasObstacles: partnerHasObstacles,
        partnerRouteY: partnerRouteY,
        parentBottom: parentBottom,
        childTop: childTop,
        interval: { start: intervalStart, end: intervalEnd },
        layerKey: component + ":" + parentGeneration + ">" + childGeneration,
        lane: -1,
        busY: 0
      });
    });

    const routesByLayer = new Map();
    routes.filter(function (route) { return route.parentNodes.length && route.children.length; }).forEach(function (route) {
      if (!routesByLayer.has(route.layerKey)) routesByLayer.set(route.layerKey, []);
      routesByLayer.get(route.layerKey).push(route);
    });

    routesByLayer.forEach(function (layerRoutes) {
      const lanes = [];
      layerRoutes.sort(function (first, second) {
        return first.interval.start - second.interval.start || first.interval.end - second.interval.end || first.familyKey.localeCompare(second.familyKey);
      });
      layerRoutes.forEach(function (route) {
        let lane = 0;
        while (lanes[lane] && !lanes[lane].every(function (interval) { return intervalsAreSeparated(interval, route.interval); })) lane += 1;
        if (!lanes[lane]) lanes[lane] = [];
        lanes[lane].push(route.interval);
        route.lane = lane;
      });

      const lower = Math.max.apply(null, layerRoutes.map(function (route) { return route.parentBottom; })) + 14;
      const upper = Math.min.apply(null, layerRoutes.map(function (route) { return route.childTop; })) - 16;
      const maximumLane = Math.max.apply(null, layerRoutes.map(function (route) { return route.lane; }));
      const preferredBase = lower + Math.max(8, Math.min(24, (upper - lower) * 0.28));
      const availableForLanes = Math.max(0, upper - preferredBase);
      const laneGap = maximumLane > 0 ? Math.max(2, Math.min(FAMILY_LANE_GAP, availableForLanes / maximumLane)) : FAMILY_LANE_GAP;
      layerRoutes.forEach(function (route) { route.busY = preferredBase + route.lane * laneGap; });
    });
    return routes;
  }

  function centerParentGroups(groupsByGeneration, positions, relationships) {
    const childrenByParent = new Map();
    relationships.forEach(function (relationship) {
      if (relationship.type !== "parent-child") return;
      if (!childrenByParent.has(relationship.fromPersonId)) childrenByParent.set(relationship.fromPersonId, new Set());
      childrenByParent.get(relationship.fromPersonId).add(relationship.toPersonId);
    });
    const generations = Array.from(groupsByGeneration.keys()).sort(function (first, second) { return second - first; });
    generations.forEach(function (generation) {
      const entries = groupsByGeneration.get(generation).map(function (group) {
        const nodes = group.map(function (person) { return positions.get(person.id); }).filter(Boolean);
        const left = Math.min.apply(null, nodes.map(function (node) { return node.x; }));
        const right = Math.max.apply(null, nodes.map(function (node) { return node.x + CARD_WIDTH; }));
        const childIds = new Set();
        group.forEach(function (person) {
          (childrenByParent.get(person.id) || []).forEach(function (childId) { childIds.add(childId); });
        });
        const childCenters = Array.from(childIds).map(function (childId) { return positions.get(childId); }).filter(Boolean).map(function (node) { return node.x + CARD_WIDTH / 2; });
        return { group: group, nodes: nodes, left: left, right: right, childCenters: childCenters };
      }).sort(function (first, second) { return first.left - second.left; });

      entries.forEach(function (entry, index) {
        if (!entry.childCenters.length) return;
        const width = entry.right - entry.left;
        const currentCenter = entry.left + width / 2;
        const desiredCenter = entry.childCenters.reduce(function (sum, x) { return sum + x; }, 0) / entry.childCenters.length;
        const limitedShift = Math.max(-FAMILY_GAP * 1.5, Math.min(FAMILY_GAP * 1.5, desiredCenter - currentCenter));
        let targetLeft = entry.left + limitedShift;
        const previous = entries[index - 1];
        const next = entries[index + 1];
        if (previous) targetLeft = Math.max(targetLeft, previous.right + FAMILY_GAP);
        if (next) targetLeft = Math.min(targetLeft, next.left - FAMILY_GAP - width);
        const shift = targetLeft - entry.left;
        if (Math.abs(shift) < 0.5) return;
        entry.nodes.forEach(function (node) { node.x += shift; });
        entry.left += shift;
        entry.right += shift;
      });
    });
  }

  function computeTreeLayout(persons, relationships, focusPersonId) {
    if (!persons.length) {
      return { nodes: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT, disconnectedStartY: 0 };
    }
    const personById = new Map(persons.map(function (person) { return [person.id, person]; }));
    const adjacency = buildAdjacency(persons, relationships);
    const componentsInfo = buildComponents(persons, adjacency, focusPersonId);
    const distances = buildDistances(adjacency, focusPersonId);
    const generationInfo = assignGenerations(persons, relationships, componentsInfo);
    const generationMap = generationInfo.generation;
    const parentsByChild = new Map();
    relationships.forEach(function (relationship) {
      if (relationship.type !== "parent-child") return;
      if (!parentsByChild.has(relationship.toPersonId)) parentsByChild.set(relationship.toPersonId, []);
      parentsByChild.get(relationship.toPersonId).push(relationship);
    });
    const groups = makePartnerGroups(persons, relationships, generationMap, focusPersonId, distances);
    const groupsByGeneration = new Map();
    groups.forEach(function (group) {
      const generation = generationMap.get(group[0].id) || 0;
      if (!groupsByGeneration.has(generation)) groupsByGeneration.set(generation, []);
      groupsByGeneration.get(generation).push(group);
    });

    const positions = new Map();
    const sortedGenerations = Array.from(groupsByGeneration.keys()).sort(function (a, b) { return a - b; });
    sortedGenerations.forEach(function (generation) {
      const generationGroups = groupsByGeneration.get(generation);
      generationGroups.forEach(function (group) {
        const parentXs = [];
        const customOrders = [];
        group.forEach(function (person) {
          (parentsByChild.get(person.id) || []).forEach(function (relationship) {
            const parentPosition = positions.get(relationship.fromPersonId);
            if (parentPosition) parentXs.push(parentPosition.x + CARD_WIDTH / 2);
            if (Number.isFinite(Number(relationship.sortOrder))) customOrders.push(Number(relationship.sortOrder));
          });
        });
        group._parentCenter = parentXs.length ? parentXs.reduce(function (sum, x) { return sum + x; }, 0) / parentXs.length : null;
        group._order = customOrders.length ? Math.min.apply(null, customOrders) : Number.MAX_SAFE_INTEGER;
        group._distance = Math.min.apply(null, group.map(function (person) { return distances.has(person.id) ? distances.get(person.id) : 9999; }));
        group._component = componentsInfo.componentByPerson.get(group[0].id) || 0;
        group._defaultPerson = group.slice().sort(comparePeople)[0];
      });
      generationGroups.sort(function (a, b) {
        if (a._component !== b._component) return a._component - b._component;
        if (a._parentCenter !== null && b._parentCenter !== null && Math.abs(a._parentCenter - b._parentCenter) > 1) return a._parentCenter - b._parentCenter;
        if (a._parentCenter !== null && b._parentCenter === null) return -1;
        if (a._parentCenter === null && b._parentCenter !== null) return 1;
        if (a._order !== b._order) return a._order - b._order;
        if (a._distance !== b._distance) return a._distance - b._distance;
        return comparePeople(a._defaultPerson, b._defaultPerson);
      });
      const widths = generationGroups.map(function (group) {
        return group.length * CARD_WIDTH + Math.max(0, group.length - 1) * PERSON_GAP;
      });
      const totalWidth = widths.reduce(function (sum, width) { return sum + width; }, 0) + Math.max(0, widths.length - 1) * FAMILY_GAP;
      let cursor = -totalWidth / 2;
      generationGroups.forEach(function (group, groupIndex) {
        group.forEach(function (person, personIndex) {
          const disconnected = (componentsInfo.componentByPerson.get(person.id) || 0) > 0;
          const y = generation * (CARD_HEIGHT + GENERATION_GAP) + (disconnected ? DISCONNECTED_GAP : 0);
          positions.set(person.id, {
            id: person.id,
            x: cursor + personIndex * (CARD_WIDTH + PERSON_GAP),
            y: y,
            generation: generation,
            component: componentsInfo.componentByPerson.get(person.id) || 0,
            disconnected: disconnected
          });
        });
        cursor += widths[groupIndex] + FAMILY_GAP;
      });
    });

    centerParentGroups(groupsByGeneration, positions, relationships);
    const positionedNodes = Array.from(positions.values());
    const minimumNodeX = Math.min.apply(null, positionedNodes.map(function (node) { return node.x; }));
    if (minimumNodeX < PADDING) {
      const horizontalShift = PADDING - minimumNodeX;
      positionedNodes.forEach(function (node) { node.x += horizontalShift; });
    }

    const nodes = persons.map(function (person) {
      return positions.get(person.id) || { id: person.id, x: 0, y: 0, generation: 0, component: 0, disconnected: false };
    });
    const minX = Math.min.apply(null, nodes.map(function (node) { return node.x; })) - PADDING;
    const minY = Math.min.apply(null, nodes.map(function (node) { return node.y; })) - PADDING;
    const maxX = Math.max.apply(null, nodes.map(function (node) { return node.x + CARD_WIDTH; })) + PADDING;
    const maxY = Math.max.apply(null, nodes.map(function (node) { return node.y + CARD_HEIGHT; })) + PADDING;
    const disconnectedNodes = nodes.filter(function (node) { return node.disconnected; });
    const disconnectedStartY = disconnectedNodes.length ? Math.min.apply(null, disconnectedNodes.map(function (node) { return node.y; })) - 40 : 0;
    return {
      nodes: nodes,
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
      generationGap: GENERATION_GAP,
      disconnectedStartY: disconnectedStartY,
      personById: personById
    };
  }

  globalThis.TreeLayout = Object.freeze({
    compute: computeTreeLayout,
    buildFamilyUnits: buildFamilyUnits,
    routeFamilyUnits: routeFamilyUnits,
    comparePeople: comparePeople,
    CARD_WIDTH: CARD_WIDTH,
    CARD_HEIGHT: CARD_HEIGHT,
    FAMILY_LANE_GAP: FAMILY_LANE_GAP,
    FAMILY_INTERVAL_MARGIN: FAMILY_INTERVAL_MARGIN
  });
}());
