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
  const ROUTING_CLEARANCE = 10;
  const MIN_TRACK_GAP = 9;
  const CHILD_PORT_STEP = 14;
  const CHILD_PORT_LIMIT = 70;

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

  function intervalsAreSeparated(first, second, margin) {
    const clearance = margin === undefined ? FAMILY_INTERVAL_MARGIN : margin;
    return first.end + clearance < second.start || second.end + clearance < first.start;
  }

  function rangeOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.min(Math.max(firstStart, firstEnd), Math.max(secondStart, secondEnd)) - Math.max(Math.min(firstStart, firstEnd), Math.min(secondStart, secondEnd));
  }

  function pointInInterval(value, interval, margin) {
    const clearance = margin || 0;
    return value >= interval.start - clearance && value <= interval.end + clearance;
  }

  function pointsToPath(points) {
    if (!points || !points.length) return "";
    let path = "M " + points[0].x + " " + points[0].y;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const point = points[index];
      if (Math.abs(previous.x - point.x) < 0.01) path += " V " + point.y;
      else if (Math.abs(previous.y - point.y) < 0.01) path += " H " + point.x;
      else path += " L " + point.x + " " + point.y;
    }
    return path;
  }

  function pointsToSegments(points, metadata) {
    const segments = [];
    for (let index = 1; index < points.length; index += 1) {
      const first = points[index - 1];
      const second = points[index];
      if (Math.hypot(second.x - first.x, second.y - first.y) < 0.1) continue;
      segments.push(Object.assign({}, metadata, {
        x1: first.x, y1: first.y, x2: second.x, y2: second.y,
        orientation: Math.abs(first.y - second.y) < 0.01 ? "horizontal" : "vertical"
      }));
    }
    return segments;
  }

  function routeVerticalXs(route) {
    return [route.sourceX].concat(route.children.map(function (child) { return child.portX; }));
  }

  function routesConflictInProjection(first, second) {
    if (!intervalsAreSeparated(first.interval, second.interval, ROUTING_CLEARANCE)) return true;
    if (routeVerticalXs(first).some(function (x) { return pointInInterval(x, second.interval, ROUTING_CLEARANCE); })) return true;
    if (routeVerticalXs(second).some(function (x) { return pointInInterval(x, first.interval, ROUTING_CLEARANCE); })) return true;
    return routeVerticalXs(first).some(function (firstX) {
      return routeVerticalXs(second).some(function (secondX) { return Math.abs(firstX - secondX) < ROUTING_CLEARANCE; });
    });
  }

  function routeOrderingPenalty(route, lane, other, otherLane) {
    let penalty = 0;
    if (pointInInterval(route.sourceX, other.interval, 0) && otherLane < lane) penalty += 12;
    route.children.forEach(function (child) {
      if (pointInInterval(child.portX, other.interval, 0) && otherLane > lane) penalty += 12;
    });
    if (pointInInterval(other.sourceX, route.interval, 0) && lane < otherLane) penalty += 12;
    other.children.forEach(function (child) {
      if (pointInInterval(child.portX, route.interval, 0) && lane > otherLane) penalty += 12;
    });
    routeVerticalXs(route).forEach(function (firstX) {
      routeVerticalXs(other).forEach(function (secondX) {
        if (Math.abs(firstX - secondX) < ROUTING_CLEARANCE) penalty += 4;
      });
    });
    return penalty;
  }

  function allocateChildPorts(layerRoutes, cardWidth) {
    const occupied = [];
    const usesByChild = new Map();
    layerRoutes.forEach(function (route) {
      occupied.push({ x: route.sourceX, familyKey: route.familyKey });
    });
    const entries = [];
    layerRoutes.forEach(function (route) {
      route.children.forEach(function (child) { entries.push({ route: route, child: child, desiredX: child.node.x + cardWidth / 2 }); });
    });
    entries.sort(function (first, second) { return first.desiredX - second.desiredX || first.route.familyKey.localeCompare(second.route.familyKey); });
    entries.forEach(function (entry) {
      const useIndex = usesByChild.get(entry.child.id) || 0;
      usesByChild.set(entry.child.id, useIndex + 1);
      const preferredDirection = useIndex % 2 ? -1 : 1;
      const preferredDistance = Math.ceil(useIndex / 2) * CHILD_PORT_STEP * preferredDirection;
      const offsets = [preferredDistance, 0];
      for (let distance = CHILD_PORT_STEP; distance <= CHILD_PORT_LIMIT; distance += CHILD_PORT_STEP) offsets.push(-distance, distance);
      let selected = entry.desiredX;
      let selectedScore = Number.POSITIVE_INFINITY;
      offsets.filter(function (offset, index, values) { return Math.abs(offset) <= CHILD_PORT_LIMIT && values.indexOf(offset) === index; }).forEach(function (offset) {
        const candidate = entry.desiredX + offset;
        let score = Math.abs(offset) * 0.04;
        occupied.forEach(function (track) {
          if (track.familyKey === entry.route.familyKey) return;
          const distance = Math.abs(candidate - track.x);
          if (distance < ROUTING_CLEARANCE) score += 1000 + (ROUTING_CLEARANCE - distance) * 50;
          else if (distance < CHILD_PORT_STEP * 1.5) score += CHILD_PORT_STEP * 1.5 - distance;
        });
        if (score < selectedScore) { selected = candidate; selectedScore = score; }
      });
      entry.child.portX = selected;
      entry.child.portIndex = useIndex;
      occupied.push({ x: selected, familyKey: entry.route.familyKey });
    });
  }

  function allocatePartnerTracks(routes, cardWidth, cardHeight) {
    routes.forEach(function (route) {
      route.partnerPoints = null;
      route.partnerPathD = "";
      route.partnerLane = -1;
      route.partnerRouteY = route.parentBottom + 9;
    });
    const groups = new Map();
    routes.filter(function (route) { return route.partnerHasObstacles; }).forEach(function (route) {
      const key = String(route.parentGeneration);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(route);
    });
    groups.forEach(function (group) {
      const lanes = [];
      group.sort(function (first, second) { return first.partnerInterval.start - second.partnerInterval.start || first.familyKey.localeCompare(second.familyKey); });
      group.forEach(function (route) {
        let lane = 0;
        while (lanes[lane] && !lanes[lane].every(function (interval) { return intervalsAreSeparated(interval, route.partnerInterval, ROUTING_CLEARANCE); })) lane += 1;
        if (!lanes[lane]) lanes[lane] = [];
        lanes[lane].push(route.partnerInterval);
        route.partnerLane = lane;
        route.partnerRouteY = route.parentBottom + 9 + lane * 9;
        route.sourceY = route.partnerRouteY;
      });
    });
    routes.forEach(function (route) {
      if (!route.partnerRelationship || route.parentNodes.length !== 2) return;
      const left = route.parentNodes[0].x < route.parentNodes[1].x ? route.parentNodes[0] : route.parentNodes[1];
      const right = left === route.parentNodes[0] ? route.parentNodes[1] : route.parentNodes[0];
      if (route.partnerHasObstacles) {
        route.partnerPoints = [
          { x: left.x + cardWidth / 2, y: left.y + cardHeight },
          { x: left.x + cardWidth / 2, y: route.partnerRouteY },
          { x: right.x + cardWidth / 2, y: route.partnerRouteY },
          { x: right.x + cardWidth / 2, y: right.y + cardHeight }
        ];
      } else if (left.generation === right.generation && right.x > left.x + cardWidth) {
        const y = (left.y + right.y) / 2 + cardHeight / 2;
        route.partnerPoints = [{ x: left.x + cardWidth, y: y }, { x: right.x, y: y }];
      } else {
        const y = Math.max(left.y, right.y) + cardHeight + 30;
        route.partnerPoints = [
          { x: left.x + cardWidth / 2, y: left.y + cardHeight },
          { x: left.x + cardWidth / 2, y: y },
          { x: right.x + cardWidth / 2, y: y },
          { x: right.x + cardWidth / 2, y: right.y + cardHeight }
        ];
      }
      route.partnerPathD = pointsToPath(route.partnerPoints);
    });
  }

  function refreshRouteVerticalMetrics(routes, cardHeight) {
    routes.forEach(function (route) {
      route.parentBottom = route.parentNodes.length ? Math.max.apply(null, route.parentNodes.map(function (node) { return node.y + cardHeight; })) : 0;
      route.childTop = route.children.length ? Math.min.apply(null, route.children.map(function (child) { return child.node.y; })) : route.parentBottom;
      const sameGeneration = route.parentNodes.length > 1 && route.parentNodes.every(function (node) { return node.generation === route.parentNodes[0].generation; });
      route.sourceY = sameGeneration
        ? route.parentNodes.reduce(function (sum, node) { return sum + node.y; }, 0) / route.parentNodes.length + cardHeight / 2
        : route.parentBottom;
    });
  }

  function buildRouteGeometry(route, cardWidth) {
    route.segments = [];
    if (route.partnerPoints) {
      route.segments = route.segments.concat(pointsToSegments(route.partnerPoints, {
        familyKey: route.familyKey, role: "partner-line", relatedPersonIds: route.parentIds.slice()
      }));
    }
    if (!route.children.length || route.lane < 0) return;
    const parentPoints = [{ x: route.sourceX, y: route.sourceY }, { x: route.sourceX, y: route.busY }];
    route.parentPathD = pointsToPath(parentPoints);
    route.segments = route.segments.concat(pointsToSegments(parentPoints, {
      familyKey: route.familyKey, role: "parent-stem", relatedPersonIds: route.parentIds.slice()
    }));
    route.busPathD = "M " + route.interval.start + " " + route.busY + " H " + route.interval.end;
    route.segments.push({
      familyKey: route.familyKey, role: "children-bus", orientation: "horizontal",
      x1: route.interval.start, y1: route.busY, x2: route.interval.end, y2: route.busY,
      relatedPersonIds: route.parentIds.concat(route.children.map(function (child) { return child.id; }))
    });
    route.children.forEach(function (child) {
      const points = [{ x: child.portX, y: route.busY }, { x: child.portX, y: child.node.y }];
      child.pathD = pointsToPath(points);
      child.segments = pointsToSegments(points, {
        familyKey: route.familyKey, role: "child-stem", childId: child.id,
        relatedPersonIds: route.parentIds.concat([child.id])
      });
      route.segments = route.segments.concat(child.segments);
    });
  }

  function findOrthogonalCrossings(routes) {
    const segments = routes.reduce(function (all, route) { return all.concat(route.segments || []); }, []);
    const crossings = [];
    const seen = new Set();
    segments.forEach(function (horizontal) {
      if (horizontal.orientation !== "horizontal") return;
      segments.forEach(function (vertical) {
        if (vertical.orientation !== "vertical" || horizontal.familyKey === vertical.familyKey) return;
        const x = vertical.x1;
        const y = horizontal.y1;
        if (x < Math.min(horizontal.x1, horizontal.x2) - 0.1 || x > Math.max(horizontal.x1, horizontal.x2) + 0.1) return;
        if (y < Math.min(vertical.y1, vertical.y2) - 0.1 || y > Math.max(vertical.y1, vertical.y2) + 0.1) return;
        const key = [Math.round(x * 10), Math.round(y * 10), horizontal.familyKey, vertical.familyKey, horizontal.role, vertical.role].join("|");
        if (seen.has(key)) return;
        seen.add(key);
        crossings.push({
          x: x, y: y,
          horizontalFamilyKey: horizontal.familyKey, horizontalRole: horizontal.role,
          verticalFamilyKey: vertical.familyKey, verticalRole: vertical.role,
          verticalChildId: vertical.childId || ""
        });
      });
    });
    return crossings;
  }

  function segmentIntersectsCard(segment, node, cardWidth, cardHeight) {
    if ((segment.relatedPersonIds || []).includes(node.id)) return false;
    const left = node.x + 3;
    const right = node.x + cardWidth - 3;
    const top = node.y + 3;
    const bottom = node.y + cardHeight - 3;
    if (segment.orientation === "horizontal") {
      if (segment.y1 <= top || segment.y1 >= bottom) return false;
      return rangeOverlap(segment.x1, segment.x2, left, right) > 0;
    }
    if (segment.x1 <= left || segment.x1 >= right) return false;
    return rangeOverlap(segment.y1, segment.y2, top, bottom) > 0;
  }

  function diagnoseRouting(routes, crossings, nodes, cardWidth, cardHeight, corridors) {
    const diagnostics = [];
    const segments = routes.reduce(function (all, route) { return all.concat(route.segments || []); }, []);
    for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
      const first = segments[firstIndex];
      nodes.forEach(function (node) {
        if (segmentIntersectsCard(first, node, cardWidth, cardHeight)) {
          diagnostics.push({ code: "card-collision", severity: "error", familyKeys: [first.familyKey], role: first.role, personId: node.id });
        }
      });
      for (let secondIndex = firstIndex + 1; secondIndex < segments.length; secondIndex += 1) {
        const second = segments[secondIndex];
        if (first.familyKey === second.familyKey || first.orientation !== second.orientation) continue;
        if (first.orientation === "horizontal" && Math.abs(first.y1 - second.y1) < 0.8 && rangeOverlap(first.x1, first.x2, second.x1, second.x2) > 1) {
          diagnostics.push({ code: "horizontal-overlap", severity: "error", familyKeys: [first.familyKey, second.familyKey], role: first.role + "/" + second.role });
        }
        if (first.orientation === "vertical" && Math.abs(first.x1 - second.x1) < 0.8 && rangeOverlap(first.y1, first.y2, second.y1, second.y2) > 1) {
          diagnostics.push({ code: "vertical-overlap", severity: "error", familyKeys: [first.familyKey, second.familyKey], role: first.role + "/" + second.role });
        }
      }
    }
    routes.forEach(function (route) {
      const length = (route.segments || []).reduce(function (sum, segment) { return sum + Math.abs(segment.x2 - segment.x1) + Math.abs(segment.y2 - segment.y1); }, 0);
      route.routeLength = length;
      if (length > Math.max(1200, cardWidth * 7)) diagnostics.push({ code: "long-route", severity: "warning", familyKeys: [route.familyKey], length: Math.round(length) });
    });
    corridors.forEach(function (corridor) {
      if (corridor.trackCount > 1 && corridor.trackGap < MIN_TRACK_GAP) diagnostics.push({ code: "dense-corridor", severity: "warning", familyKeys: corridor.familyKeys.slice(), corridorKey: corridor.key });
    });
    return {
      issues: diagnostics,
      crossingCount: crossings.length,
      errorCount: diagnostics.filter(function (item) { return item.severity === "error"; }).length,
      warningCount: diagnostics.filter(function (item) { return item.severity === "warning"; }).length
    };
  }

  function routeFamilyUnits(persons, relationships, nodes, cardWidth, cardHeight) {
    const nodeMap = new Map(nodes.map(function (node) { return [node.id, node]; }));
    const units = buildFamilyUnits(persons, relationships);
    const routes = units.map(function (unit) {
      const parentNodes = unit.parentIds.map(function (id) { return nodeMap.get(id); }).filter(Boolean);
      const children = unit.children.map(function (child) {
        return { id: child.id, node: nodeMap.get(child.id), relationships: child.relationships, portX: 0, portIndex: 0 };
      }).filter(function (child) { return child.node; }).sort(function (first, second) {
        return first.node.x - second.node.x || first.id.localeCompare(second.id);
      });
      const sourceX = parentNodes.length ? parentNodes.reduce(function (sum, node) { return sum + node.x + cardWidth / 2; }, 0) / parentNodes.length : 0;
      const parentBottom = parentNodes.length ? Math.max.apply(null, parentNodes.map(function (node) { return node.y + cardHeight; })) : 0;
      const parentGeneration = parentNodes.length ? Math.max.apply(null, parentNodes.map(function (node) { return node.generation; })) : 0;
      const childGeneration = children.length ? Math.min.apply(null, children.map(function (child) { return child.node.generation; })) : parentGeneration;
      const childTop = children.length ? Math.min.apply(null, children.map(function (child) { return child.node.y; })) : parentBottom;
      const component = parentNodes[0] ? parentNodes[0].component : (children[0] ? children[0].node.component : 0);
      let partnerHasObstacles = false;
      let partnerInterval = { start: sourceX, end: sourceX };
      if (parentNodes.length === 2 && parentNodes[0].generation === parentNodes[1].generation) {
        const centers = parentNodes.map(function (node) { return node.x + cardWidth / 2; });
        partnerInterval = { start: Math.min.apply(null, centers), end: Math.max.apply(null, centers) };
        partnerHasObstacles = nodes.some(function (node) {
          if (unit.parentIds.includes(node.id) || node.generation !== parentGeneration) return false;
          return node.x + cardWidth / 2 > partnerInterval.start && node.x + cardWidth / 2 < partnerInterval.end;
        });
      }
      const sameGeneration = parentNodes.length > 1 && parentNodes.every(function (node) { return node.generation === parentNodes[0].generation; });
      const sourceY = sameGeneration ? parentNodes.reduce(function (sum, node) { return sum + node.y; }, 0) / parentNodes.length + cardHeight / 2 : parentBottom;
      return Object.assign({}, unit, {
        parentNodes: parentNodes, children: children, sourceX: sourceX, sourceY: sourceY,
        parentBottom: parentBottom, childTop: childTop, parentGeneration: parentGeneration, childGeneration: childGeneration,
        component: component, layerKey: parentGeneration + ">" + childGeneration,
        partnerHasObstacles: partnerHasObstacles, partnerInterval: partnerInterval, partnerLane: -1, partnerRouteY: parentBottom + 9,
        interval: { start: sourceX, end: sourceX }, lane: -1, busY: 0, segments: []
      });
    });

    const routesByLayer = new Map();
    routes.filter(function (route) { return route.parentNodes.length && route.children.length; }).forEach(function (route) {
      if (!routesByLayer.has(route.layerKey)) routesByLayer.set(route.layerKey, []);
      routesByLayer.get(route.layerKey).push(route);
    });
    const layerEntries = Array.from(routesByLayer.entries()).sort(function (first, second) {
      const firstRoute = first[1][0];
      const secondRoute = second[1][0];
      return firstRoute.parentGeneration - secondRoute.parentGeneration || firstRoute.childGeneration - secondRoute.childGeneration || first[0].localeCompare(second[0]);
    });
    layerEntries.forEach(function (entry) {
      const layerRoutes = entry[1];
      allocateChildPorts(layerRoutes, cardWidth);
      layerRoutes.forEach(function (route) {
        const xs = [route.sourceX].concat(route.children.map(function (child) { return child.portX; }));
        route.interval = { start: Math.min.apply(null, xs), end: Math.max.apply(null, xs) };
        if (route.interval.end - route.interval.start < FAMILY_BUS_STUB * 2) {
          route.interval.start -= FAMILY_BUS_STUB;
          route.interval.end += FAMILY_BUS_STUB;
        }
      });
      const conflicts = new Map(layerRoutes.map(function (route) { return [route.familyKey, new Set()]; }));
      for (let first = 0; first < layerRoutes.length; first += 1) {
        for (let second = first + 1; second < layerRoutes.length; second += 1) {
          if (!routesConflictInProjection(layerRoutes[first], layerRoutes[second])) continue;
          conflicts.get(layerRoutes[first].familyKey).add(layerRoutes[second].familyKey);
          conflicts.get(layerRoutes[second].familyKey).add(layerRoutes[first].familyKey);
        }
      }
      const ordered = layerRoutes.slice().sort(function (first, second) {
        return conflicts.get(second.familyKey).size - conflicts.get(first.familyKey).size || (second.interval.end - second.interval.start) - (first.interval.end - first.interval.start) || first.familyKey.localeCompare(second.familyKey);
      });
      const assigned = [];
      ordered.forEach(function (route) {
        const usedLanes = new Set(assigned.filter(function (other) {
          return conflicts.get(route.familyKey).has(other.familyKey);
        }).map(function (other) { return other.lane; }));
        let lane = 0;
        while (usedLanes.has(lane)) lane += 1;
        route.lane = lane;
        assigned.push(route);
      });
      const maximumLane = Math.max.apply(null, layerRoutes.map(function (route) { return route.lane; }));
      refreshRouteVerticalMetrics(routes, cardHeight);
      allocatePartnerTracks(routes, cardWidth, cardHeight);
      const topFromParents = Math.max.apply(null, layerRoutes.map(function (route) { return route.parentBottom; })) + 16;
      const topFromPartners = Math.max.apply(null, layerRoutes.map(function (route) { return route.partnerHasObstacles ? route.partnerRouteY + 9 : topFromParents; }));
      const top = Math.max(topFromParents, topFromPartners);
      const bottom = Math.min.apply(null, layerRoutes.map(function (route) { return route.childTop; })) - 18;
      const requiredBottom = top + maximumLane * FAMILY_LANE_GAP;
      if (bottom < requiredBottom) {
        const shift = requiredBottom - bottom;
        const childGeneration = layerRoutes[0].childGeneration;
        nodes.forEach(function (node) {
          if (node.generation >= childGeneration) node.y += shift;
        });
      }
    });

    refreshRouteVerticalMetrics(routes, cardHeight);
    allocatePartnerTracks(routes, cardWidth, cardHeight);
    const corridors = [];
    layerEntries.forEach(function (entry) {
      const layerKey = entry[0];
      const layerRoutes = entry[1];
      const topFromParents = Math.max.apply(null, layerRoutes.map(function (route) { return route.parentBottom; })) + 16;
      const topFromPartners = Math.max.apply(null, layerRoutes.map(function (route) { return route.partnerHasObstacles ? route.partnerRouteY + 9 : topFromParents; }));
      const top = Math.max(topFromParents, topFromPartners);
      const bottom = Math.min.apply(null, layerRoutes.map(function (route) { return route.childTop; })) - 18;
      const maximumLane = Math.max.apply(null, layerRoutes.map(function (route) { return route.lane; }));
      const available = Math.max(1, bottom - top);
      const baseY = maximumLane > 0 ? top : top + available * 0.42;
      layerRoutes.forEach(function (route) {
        route.busY = Math.min(bottom, baseY + route.lane * FAMILY_LANE_GAP);
        buildRouteGeometry(route, cardWidth);
      });
      corridors.push({
        key: layerKey, top: top, bottom: bottom, trackGap: FAMILY_LANE_GAP,
        trackCount: maximumLane + 1, familyKeys: layerRoutes.map(function (route) { return route.familyKey; })
      });
    });
    routes.filter(function (route) { return !route.children.length; }).forEach(function (route) { buildRouteGeometry(route, cardWidth); });
    const crossings = findOrthogonalCrossings(routes);
    const diagnostics = diagnoseRouting(routes, crossings, nodes, cardWidth, cardHeight, corridors);
    routes.forEach(function (route) {
      route.routingIssues = diagnostics.issues.filter(function (issue) { return issue.familyKeys.includes(route.familyKey); });
    });
    return { routes: routes, corridors: corridors, crossings: crossings, diagnostics: diagnostics };
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
