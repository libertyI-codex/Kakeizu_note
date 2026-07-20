(function () {
  "use strict";

  const Resolver = globalThis.GenerationResolver;
  const UnionBuilder = globalThis.UnionNodeBuilder;
  const SubtreeLayout = globalThis.FamilySubtreeLayout;
  const CoupleLayout = globalThis.CoupleBlockLayout;
  const Validator = globalThis.FamilyLayoutValidator;
  const CARD_WIDTH = 184;
  const CARD_HEIGHT = 128;
  const BASE_CORRIDOR_HEIGHT = 58;
  const TRACK_SPACING = 20;
  const PARTNER_TRACK_SPACING = 14;
  const PADDING_X = 84;
  const PADDING_Y = 64;
  const DISCONNECTED_GAP = 130;
  const BUS_STUB = 9;
  const PORT_STEP = 14;
  const EPSILON = 0.75;

  function stable(value) { return String(value === undefined || value === null ? "" : value); }
  function fullName(person) { return ((person && person.familyName || "") + " " + (person && person.givenName || "")).trim(); }
  function comparePeople(first, second) {
    if (!first || !second) return stable(first && first.id).localeCompare(stable(second && second.id));
    const firstBirth = first.birthDate || ""; const secondBirth = second.birthDate || "";
    if (firstBirth && secondBirth && firstBirth !== secondBirth) return firstBirth.localeCompare(secondBirth);
    if (firstBirth && !secondBirth) return -1;
    if (!firstBirth && secondBirth) return 1;
    return stable(first.createdAt).localeCompare(stable(second.createdAt)) || fullName(first).localeCompare(fullName(second), "ja") || stable(first.id).localeCompare(stable(second.id));
  }
  function relationshipType(value) { return value === "adoptive" || value === "step" ? value : "biological"; }
  function typeRank(value) { return { biological: 0, adoptive: 1, step: 2, partner: 3 }[value] === undefined ? 4 : { biological: 0, adoptive: 1, step: 2, partner: 3 }[value]; }
  function partnerStatusRank(value) { return { current: 0, unknown: 1, separated: 2, divorced: 3, ended: 4 }[value] === undefined ? 1 : { current: 0, unknown: 1, separated: 2, divorced: 3, ended: 4 }[value]; }
  function generationOf(personId, state) {
    const relative = state.personGenerations[personId];
    return Number.isFinite(relative) ? relative : (Number.isFinite(state.localGenerations[personId]) ? state.localGenerations[personId] : 0);
  }
  function componentOf(personId, state) { return Number.isFinite(state.componentByPerson[personId]) ? state.componentByPerson[personId] : 0; }
  function corridorId(component, parentGeneration, childGeneration) { return "corridor:" + component + ":" + parentGeneration + "-to-" + childGeneration; }
  function pathFrom(points) {
    if (!points || !points.length) return "";
    let path = "M " + points[0].x + " " + points[0].y;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]; const current = points[index];
      if (Math.abs(previous.x - current.x) < EPSILON) path += " V " + current.y;
      else if (Math.abs(previous.y - current.y) < EPSILON) path += " H " + current.x;
      else path += " L " + current.x + " " + current.y;
    }
    return path;
  }
  function segment(first, second, route, role, suffix, targetChildId) {
    return {
      segmentId: route.routeId + ":" + role + ":" + suffix,
      routeId: route.routeId, familyKey: route.familyKey, familySubtreeId: route.familySubtreeId,
      unionNodeId: route.unionNodeId, role: role, targetChildId: targetChildId || "",
      x1: first.x, y1: first.y, x2: second.x, y2: second.y,
      orientation: Math.abs(first.y - second.y) < EPSILON ? "horizontal" : "vertical"
    };
  }
  function segmentsFrom(points, route, role, targetChildId) {
    const result = [];
    for (let index = 1; index < points.length; index += 1) {
      if (Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y) < EPSILON) continue;
      result.push(segment(points[index - 1], points[index], route, role, index, targetChildId));
    }
    return result;
  }

  function computeBounds(nodes) {
    if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0 };
    const minX = Math.min.apply(null, nodes.map(function (node) { return node.x; })) - PADDING_X;
    const maxX = Math.max.apply(null, nodes.map(function (node) { return node.x + CARD_WIDTH; })) + PADDING_X;
    const minY = Math.min.apply(null, nodes.map(function (node) { return node.y; })) - PADDING_Y;
    const maxY = Math.max.apply(null, nodes.map(function (node) { return node.y + CARD_HEIGHT; })) + PADDING_Y;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function legacyFamilyUnits(model) {
    return model.unionNodes.reduce(function (units, union) {
      const byType = new Map();
      union.childLinks.forEach(function (link) {
        if (!byType.has(link.relationshipType)) byType.set(link.relationshipType, []);
        byType.get(link.relationshipType).push({ id: link.childId, relationships: link.relationships.slice(), isPrimary: link.isPrimary });
      });
      if (!byType.size) byType.set("partner", []);
      byType.forEach(function (children, type) {
        units.push({
          familyKey: union.familyKey + ":" + type, baseFamilyKey: union.familyKey, routeId: "route:" + union.id + ":" + type,
          unionNodeId: union.id, familySubtreeId: union.subtreeId, parentIds: union.parentIds.slice(), partnerRelationship: union.partnerRelationship,
          partnerRelationId: union.partnerRelationId, relationshipType: type, children: children, drawPartnerLine: type === Array.from(byType.keys()).sort(function (a, b) { return typeRank(a) - typeRank(b); })[0]
        });
      });
      return units;
    }, []).sort(function (first, second) { return first.routeId.localeCompare(second.routeId); });
  }

  function computeTreeLayout(persons, relationships, focusPersonId, options) {
    const totalStartedAt = performance.now();
    if (!persons.length) return { nodes: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT, generationLayers: [], familyBlocks: [], familySubtrees: [], unionNodes: [], siblingGroups: [], corridors: [], diagnostics: [] };
    if (!Resolver || !UnionBuilder || !SubtreeLayout || !Validator) throw new Error("家系図レイアウトに必要なプログラムを読み込めませんでした。");
    if (!CoupleLayout) throw new Error("CoupleBlockレイアウトを読み込めませんでした。");
    const generationStartedAt = performance.now();
    const generationState = Resolver.resolve(persons, relationships, focusPersonId, options || {});
    const generationCalculationMs = performance.now() - generationStartedAt;
    const unionModel = UnionBuilder.build(persons, relationships, generationState);
    /* Expose the deterministic comparator without leaking another global. */
    unionModel.comparePeople = comparePeople;
    const subtreeState = SubtreeLayout.build(persons, relationships, generationState, unionModel, { cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT });
    const coupleState = CoupleLayout.apply(persons, relationships, generationState, unionModel, subtreeState, { cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT });
    const nodes = subtreeState.nodes;
    const minX = Math.min.apply(null, nodes.map(function (node) { return node.x; }));
    if (minX < PADDING_X) {
      const offset = PADDING_X - minX;
      nodes.forEach(function (node) { node.x += offset; });
      unionModel.unionNodes.forEach(function (union) { union.centerX += offset; if (union.bounds) union.bounds.x += offset; });
      subtreeState.familySubtrees.forEach(function (subtree) { subtree.centerX += offset; subtree.minX += offset; subtree.maxX += offset; if (subtree.bounds) subtree.bounds.x += offset; });
      subtreeState.siblingGroups.forEach(function (group) { group.minX += offset; group.maxX += offset; group.centerX += offset; });
      coupleState.coupleBlocks.forEach(function (block) { block.centerX += offset; block.minX += offset; block.maxX += offset; });
      coupleState.placementAtoms.forEach(function (atom) { atom.x += offset; });
      coupleState.directSpine.spineX += offset;
      coupleState.directSpine.directConnections.forEach(function (connection) { connection.unionCenterX += offset; connection.targetX += offset; });
    }
    const layoutDiagnostics = unionModel.diagnostics.concat(subtreeState.diagnostics, coupleState.diagnostics);
    const layout = {
      nodes: nodes,
      bounds: computeBounds(nodes),
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
      generationGap: BASE_CORRIDOR_HEIGHT,
      disconnectedStartY: 0,
      personById: new Map(persons.map(function (person) { return [person.id, person]; })),
      focusPersonId: generationState.focusPersonId,
      personGenerations: generationState.personGenerations,
      localGenerations: generationState.localGenerations,
      generationLayers: [],
      familyBlocks: subtreeState.familySubtrees,
      familySubtrees: subtreeState.familySubtrees,
      subtreeById: subtreeState.subtreeById,
      siblingGroups: subtreeState.siblingGroups,
      coupleBlocks: coupleState.coupleBlocks,
      coupleByUnionId: coupleState.coupleByUnionId,
      placementAtoms: coupleState.placementAtoms,
      directSpine: coupleState.directSpine,
      disconnectedComponents: generationState.disconnectedComponents,
      generationDiagnostics: generationState.diagnostics,
      layoutDiagnostics: layoutDiagnostics,
      generationState: generationState,
      unionModel: unionModel,
      unionNodes: unionModel.unionNodes,
      familyUnits: legacyFamilyUnits(unionModel),
      personPorts: {},
      trackGroups: [],
      performance: Object.assign({ generationCalculationMs: generationCalculationMs }, unionModel.timings, subtreeState.timings, coupleState.timings)
    };
    layout.performance.computeBeforeRoutingMs = performance.now() - totalStartedAt;
    return layout;
  }

  function prepareRoutes(layout) {
    const nodeById = new Map(layout.nodes.map(function (node) { return [node.id, node]; }));
    const routes = [];
    layout.unionNodes.forEach(function (union) {
      const linksByType = new Map();
      union.childLinks.forEach(function (link) {
        if (!linksByType.has(link.relationshipType)) linksByType.set(link.relationshipType, []);
        linksByType.get(link.relationshipType).push(link);
      });
      if (!linksByType.size && union.partnerRelationship) linksByType.set("partner", []);
      const types = Array.from(linksByType.keys()).sort(function (first, second) { return typeRank(first) - typeRank(second); });
      types.forEach(function (type, typeIndex) {
        const links = linksByType.get(type).slice().sort(function (first, second) {
          const firstNode = nodeById.get(first.childId); const secondNode = nodeById.get(second.childId);
          return (firstNode ? firstNode.x : 0) - (secondNode ? secondNode.x : 0) || stable(first.childId).localeCompare(stable(second.childId));
        });
        const parents = union.parentIds.map(function (id) { return nodeById.get(id); }).filter(Boolean);
        const children = links.map(function (link) { return { id: link.childId, node: nodeById.get(link.childId), relationships: link.relationships.slice(), isPrimary: link.isPrimary, relationshipType: link.relationshipType, portX: 0, portY: 0, portIndex: 0, pathD: "", segments: [], role: link.relationshipType === "adoptive" ? "adoptive-route" : (link.relationshipType === "step" ? "step-route" : "child-stem") }; }).filter(function (child) { return child.node; });
        const parentGenerations = Array.from(new Set(parents.map(function (node) { return node.generation; })));
        const childGenerations = Array.from(new Set(children.map(function (child) { return child.node.generation; })));
        const parentGeneration = parentGenerations.length ? parentGenerations[0] : union.generation;
        const childGeneration = childGenerations.length ? childGenerations[0] : (Number.isFinite(parentGeneration) ? parentGeneration - 1 : null);
        const component = parents.length ? parents[0].component : (children.length ? children[0].node.component : 0);
        routes.push({
          familyKey: union.familyKey + ":" + type,
          baseFamilyKey: union.familyKey,
          familySubtreeId: union.subtreeId,
          unionNodeId: union.id,
          coupleBlock: layout.coupleByUnionId && layout.coupleByUnionId.get(union.id) || null,
          coupleBlockId: layout.coupleByUnionId && layout.coupleByUnionId.get(union.id) ? layout.coupleByUnionId.get(union.id).id : "",
          routeId: "route:" + union.id + ":" + type,
          parentIds: union.parentIds.slice(), parentNodes: parents, partnerRelationship: union.partnerRelationship,
          partnerRelationId: union.partnerRelationId, relationshipType: type, childIds: children.map(function (child) { return child.id; }), children: children,
          parentGeneration: parentGeneration, childGeneration: childGeneration, component: component,
          corridorId: corridorId(component, parentGeneration, childGeneration), corridorKey: corridorId(component, parentGeneration, childGeneration),
          trackGroupId: "track-group:" + union.subtreeId + ":" + type, trackIndex: -1, typeIndex: typeIndex,
          drawPartnerLine: Boolean(union.partnerRelationship && typeIndex === 0), partnerHasObstacles: false, partnerTrackIndex: -1,
          partnerGenerationMismatch: parentGenerations.length > 1, parentGenerationMismatch: parentGenerations.length > 1,
          childGenerationMismatch: childGenerations.length > 1, componentMismatch: parents.concat(children.map(function (child) { return child.node; })).some(function (node) { return node.component !== component; }),
          nonAdjacent: children.length > 0 && Number.isFinite(parentGeneration) && Number.isFinite(childGeneration) && parentGeneration - childGeneration !== 1,
          generationConflict: false, unionAnchorX: union.centerX, unionAnchorY: 0, sourceX: union.centerX, sourceY: 0,
          busMinX: 0, busMaxX: 0, busY: 0, parentPathD: "", busPathD: "", partnerPathD: "", partnerRouteY: 0,
          partnerLinePaths: [], partnerHitPathD: "", partnerPorts: null, partnerMarker: null,
          segments: [], routingIssues: [], routeLength: 0
        });
      });
    });
    routes.forEach(function (route) { route.generationConflict = route.parentGenerationMismatch || route.childGenerationMismatch || route.componentMismatch || route.nonAdjacent; });
    return routes.sort(function (first, second) {
      return first.component - second.component || Number(second.parentGeneration) - Number(first.parentGeneration) || first.familySubtreeId.localeCompare(second.familySubtreeId) || first.unionNodeId.localeCompare(second.unionNodeId) || typeRank(first.relationshipType) - typeRank(second.relationshipType);
    });
  }

  function allocateTrackGroups(routes) {
    const byCorridor = new Map();
    routes.filter(function (route) { return route.children.length; }).forEach(function (route) {
      if (!byCorridor.has(route.corridorId)) byCorridor.set(route.corridorId, []);
      byCorridor.get(route.corridorId).push(route);
    });
    const groups = [];
    byCorridor.forEach(function (corridorRoutes, id) {
      corridorRoutes.sort(function (first, second) { return first.familySubtreeId.localeCompare(second.familySubtreeId) || first.unionNodeId.localeCompare(second.unionNodeId) || typeRank(first.relationshipType) - typeRank(second.relationshipType); });
      corridorRoutes.forEach(function (route, index) {
        /* A track is intentionally never reused by another UnionNode. This is
           more spacious, but two family buses can no longer appear continuous. */
        route.trackIndex = index;
        route.trackGroupId = "track-group:" + route.familySubtreeId + ":" + route.unionNodeId + ":" + route.relationshipType;
        groups.push({ familySubtreeId: route.familySubtreeId, familyKey: route.familyKey, corridorId: id, minX: 0, maxX: 0, tracks: [index], sideTracks: [], id: route.trackGroupId });
      });
    });
    return { byCorridor: byCorridor, trackGroups: groups };
  }

  function applyGenerationLayerY(layout, routes, allocation) {
    const nodesByComponent = new Map();
    layout.nodes.forEach(function (node) { if (!nodesByComponent.has(node.component)) nodesByComponent.set(node.component, []); nodesByComponent.get(node.component).push(node); });
    const generationLayers = [];
    let componentTop = PADDING_Y;
    Array.from(nodesByComponent.keys()).sort(function (a, b) { return a - b; }).forEach(function (component) {
      const componentNodes = nodesByComponent.get(component);
      const generations = Array.from(new Set(componentNodes.map(function (node) { return node.generation; }))).sort(function (a, b) { return b - a; });
      let y = componentTop;
      generations.forEach(function (generation, index) {
        componentNodes.filter(function (node) { return node.generation === generation; }).forEach(function (node) { node.y = y; });
        generationLayers.push({ component: component, generation: generation, y: y, personIds: componentNodes.filter(function (node) { return node.generation === generation; }).map(function (node) { return node.id; }).sort(), disconnected: component !== 0 });
        if (index < generations.length - 1) {
          const next = generations[index + 1];
          const id = corridorId(component, generation, next);
          const corridorRoutes = allocation.byCorridor.get(id) || [];
          const partnerObstacleCount = corridorRoutes.filter(function (route) { return route.drawPartnerLine && route.parentNodes.length === 2; }).length;
          const routeCount = Math.max(1, corridorRoutes.length);
          y += CARD_HEIGHT + BASE_CORRIDOR_HEIGHT + routeCount * TRACK_SPACING + Math.min(partnerObstacleCount, 4) * PARTNER_TRACK_SPACING;
        }
      });
      const bottom = Math.max.apply(null, componentNodes.map(function (node) { return node.y + CARD_HEIGHT; }));
      if (component === 0 && nodesByComponent.size > 1) layout.disconnectedStartY = bottom + DISCONNECTED_GAP / 2;
      componentTop = bottom + DISCONNECTED_GAP;
    });
    layout.generationLayers = generationLayers;
    layout.disconnectedComponents = (layout.generationState.disconnectedComponents || []).map(function (component) {
      const first = layout.nodes.find(function (node) { return component.personIds.includes(node.id); });
      return Object.assign({}, component, { localGenerationLayers: generationLayers.filter(function (layer) { return first && layer.component === first.component; }) });
    });
  }

  function updateDirectSpineBounds(layout, routes) {
    const spine = layout.directSpine;
    if (!spine || !spine.focusPersonId) return;
    const directIds = new Set(spine.directPersonIds || []);
    const directUnionIds = new Set(spine.directUnionNodeIds || []);
    const directNodes = layout.nodes.filter(function (node) { return directIds.has(node.id); });
    const directRoutes = routes.filter(function (route) { return directUnionIds.has(route.unionNodeId); });
    (spine.directConnections || []).forEach(function (connection) {
      const route = directRoutes.find(function (item) { return item.unionNodeId === connection.unionNodeId; });
      const person = layout.nodes.find(function (node) { return node.id === connection.personId; });
      if (route) connection.unionCenterX = route.unionAnchorX;
      if (person) connection.targetX = person.x + CARD_WIDTH / 2;
      connection.horizontalDrift = Math.abs(connection.unionCenterX - connection.targetX);
    });
    const yValues = [];
    directNodes.forEach(function (node) { yValues.push(node.y, node.y + CARD_HEIGHT); });
    directRoutes.forEach(function (route) {
      if (Number.isFinite(route.unionAnchorY)) yValues.push(route.unionAnchorY);
      if (route.children.length && Number.isFinite(route.busY)) yValues.push(route.busY);
    });
    if (!yValues.length) return;
    const top = Math.min.apply(null, yValues) - PADDING_Y;
    const bottom = Math.max.apply(null, yValues) + PADDING_Y;
    const halfWidth = CARD_WIDTH * 1.75;
    spine.bounds = { x: spine.spineX - halfWidth, y: top, width: halfWidth * 2, height: Math.max(CARD_HEIGHT + PADDING_Y * 2, bottom - top) };
    spine.axisMinY = top; spine.axisMaxY = bottom;
  }

  function allocatePersonPorts(layout, routes) {
    const entriesByChild = new Map();
    routes.forEach(function (route) { route.children.forEach(function (child) { if (!entriesByChild.has(child.id)) entriesByChild.set(child.id, []); entriesByChild.get(child.id).push({ route: route, child: child }); }); });
    const ports = {};
    layout.nodes.forEach(function (node) {
      ports[node.id] = {
        personId: node.id,
        parentTop: { x: node.x + CARD_WIDTH / 2, y: node.y },
        childBottom: { x: node.x + CARD_WIDTH / 2, y: node.y + CARD_HEIGHT },
        parentPort: { x: node.x + CARD_WIDTH / 2, y: node.y },
        childPort: { x: node.x + CARD_WIDTH / 2, y: node.y + CARD_HEIGHT },
        partnerLeft: { x: node.x, y: node.y + CARD_HEIGHT / 2 },
        partnerRight: { x: node.x + CARD_WIDTH, y: node.y + CARD_HEIGHT / 2 },
        partnerLeftPort: { x: node.x, y: node.y + CARD_HEIGHT / 2, name: "partner-left-port" },
        partnerRightPort: { x: node.x + CARD_WIDTH, y: node.y + CARD_HEIGHT / 2, name: "partner-right-port" },
        partnerPortsByRelationship: {},
        secondaryPartnerPorts: [],
        adoptiveTop: { x: node.x + CARD_WIDTH / 2 - PORT_STEP, y: node.y },
        stepTop: { x: node.x + CARD_WIDTH / 2 + PORT_STEP, y: node.y },
        secondaryUnionPorts: []
      };
    });
    const partnerEntries = new Map();
    (layout.coupleBlocks || []).forEach(function (block) {
      [[block.leftPersonId, "right"], [block.rightPersonId, "left"]].forEach(function (entry) {
        const key = entry[0] + ":" + entry[1];
        if (!partnerEntries.has(key)) partnerEntries.set(key, []);
        partnerEntries.get(key).push({ block: block, side: entry[1] });
      });
    });
    partnerEntries.forEach(function (entries, key) {
      entries.sort(function (first, second) { return partnerStatusRank(first.block.status) - partnerStatusRank(second.block.status) || stable(first.block.relationshipId).localeCompare(stable(second.block.relationshipId)); });
      const personId = key.slice(0, key.lastIndexOf(":"));
      const personPorts = ports[personId];
      if (!personPorts) return;
      entries.forEach(function (entry, index) {
        const sign = index % 2 ? -1 : 1;
        const offset = index ? sign * Math.ceil(index / 2) * 12 : 0;
        const x = entry.side === "left" ? personPorts.partnerLeft.x : personPorts.partnerRight.x;
        const y = (entry.side === "left" ? personPorts.partnerLeft.y : personPorts.partnerRight.y) + offset;
        const name = index ? "secondary-partner-" + entry.side + "-port-" + index : "partner-" + entry.side + "-port";
        const assignment = { x: x, y: y, side: entry.side, name: name, index: index, relationshipId: entry.block.relationshipId };
        personPorts.partnerPortsByRelationship[entry.block.relationshipId] = assignment;
        entry.block.portAssignments[personId] = assignment;
        if (index) personPorts.secondaryPartnerPorts.push(assignment);
      });
    });
    entriesByChild.forEach(function (entries, childId) {
      entries.sort(function (first, second) { return typeRank(first.route.relationshipType) - typeRank(second.route.relationshipType) || first.route.routeId.localeCompare(second.route.routeId); });
      entries.forEach(function (entry, index) {
        const base = ports[childId].parentTop;
        let offset = 0;
        if (entry.route.relationshipType === "adoptive") offset = -PORT_STEP;
        else if (entry.route.relationshipType === "step") offset = PORT_STEP;
        if (index > 2) offset += (index % 2 ? -1 : 1) * Math.ceil((index - 2) / 2) * PORT_STEP;
        offset = Math.max(-CARD_WIDTH / 2 + 18, Math.min(CARD_WIDTH / 2 - 18, offset));
        entry.child.portX = base.x + offset; entry.child.portY = base.y; entry.child.portIndex = index;
        if (index) ports[childId].secondaryUnionPorts.push({ routeId: entry.route.routeId, x: entry.child.portX, y: entry.child.portY, relationshipType: entry.route.relationshipType });
      });
    });
    layout.personPorts = ports;
  }

  function countPartnerObstacles(route, layout) {
    if (route.parentNodes.length !== 2) return 0;
    const centers = route.parentNodes.map(function (node) { return node.x + CARD_WIDTH / 2; }).sort(function (a, b) { return a - b; });
    return layout.nodes.filter(function (node) {
      return !route.parentIds.includes(node.id) && node.component === route.component && node.generation === route.parentGeneration && node.x + CARD_WIDTH / 2 > centers[0] && node.x + CARD_WIDTH / 2 < centers[1];
    }).length;
  }

  function offsetPolyline(points, offset) {
    if (!points || points.length < 2) return (points || []).slice();
    const directions = [];
    const normals = [];
    for (let index = 1; index < points.length; index += 1) {
      const dx = points[index].x - points[index - 1].x; const dy = points[index].y - points[index - 1].y;
      const length = Math.hypot(dx, dy) || 1;
      const direction = { x: dx / length, y: dy / length };
      directions.push(direction); normals.push({ x: -direction.y, y: direction.x });
    }
    function shifted(point, normal) { return { x: point.x + normal.x * offset, y: point.y + normal.y * offset }; }
    const result = [shifted(points[0], normals[0])];
    for (let index = 1; index < points.length - 1; index += 1) {
      const firstPoint = shifted(points[index], normals[index - 1]);
      const secondPoint = shifted(points[index], normals[index]);
      const firstDirection = directions[index - 1]; const secondDirection = directions[index];
      const cross = firstDirection.x * secondDirection.y - firstDirection.y * secondDirection.x;
      if (Math.abs(cross) < EPSILON) {
        result.push({ x: (firstPoint.x + secondPoint.x) / 2, y: (firstPoint.y + secondPoint.y) / 2 });
      } else {
        const deltaX = secondPoint.x - firstPoint.x; const deltaY = secondPoint.y - firstPoint.y;
        const amount = (deltaX * secondDirection.y - deltaY * secondDirection.x) / cross;
        result.push({ x: firstPoint.x + firstDirection.x * amount, y: firstPoint.y + firstDirection.y * amount });
      }
    }
    result.push(shifted(points[points.length - 1], normals[normals.length - 1]));
    return result;
  }

  function buildPartnerDoubleLineGeometry(route, layout) {
    if (!route.partnerRelationship || route.parentNodes.length !== 2) return null;
    const relationshipId = route.partnerRelationship.id;
    const ordered = route.parentNodes.slice().sort(function (first, second) { return first.x - second.x || stable(first.id).localeCompare(stable(second.id)); });
    const leftNode = ordered[0]; const rightNode = ordered[1];
    const leftPorts = layout.personPorts[leftNode.id]; const rightPorts = layout.personPorts[rightNode.id];
    const leftPort = leftPorts.partnerPortsByRelationship[relationshipId] || leftPorts.partnerRightPort;
    const rightPort = rightPorts.partnerPortsByRelationship[relationshipId] || rightPorts.partnerLeftPort;
    const start = { x: leftPort.x, y: leftPort.y }; const end = { x: rightPort.x, y: rightPort.y };
    const obstacleCount = countPartnerObstacles(route, layout);
    const shortHorizontal = obstacleCount === 0 && Math.abs(start.y - end.y) < EPSILON;
    let centerPoints;
    let unionPoint;
    if (shortHorizontal) {
      centerPoints = [start, end];
      unionPoint = { x: (start.x + end.x) / 2, y: start.y };
    } else if (obstacleCount === 0) {
      const middleX = (start.x + end.x) / 2;
      centerPoints = [start, { x: middleX, y: start.y }, { x: middleX, y: end.y }, end];
      unionPoint = { x: middleX, y: (start.y + end.y) / 2 };
    } else {
      const leftStubX = start.x + 18; const rightStubX = end.x - 18;
      const laneY = Math.max(leftNode.y, rightNode.y) + CARD_HEIGHT + 20 + Math.max(0, route.typeIndex) * 10;
      centerPoints = [start, { x: leftStubX, y: start.y }, { x: leftStubX, y: laneY }, { x: rightStubX, y: laneY }, { x: rightStubX, y: end.y }, end];
      unionPoint = { x: (leftStubX + rightStubX) / 2, y: laneY };
    }
    const separation = 5;
    const upper = offsetPolyline(centerPoints, -separation / 2);
    const lower = offsetPolyline(centerPoints, separation / 2);
    route.partnerPorts = {
      left: { personId: leftNode.id, x: start.x, y: start.y, name: leftPort.name || "partner-right-port" },
      right: { personId: rightNode.id, x: end.x, y: end.y, name: rightPort.name || "partner-left-port" }
    };
    route.partnerLinePaths = [pathFrom(upper), pathFrom(lower)];
    route.partnerHitPathD = pathFrom(centerPoints);
    route.partnerPathD = route.partnerHitPathD;
    route.partnerSegments = segmentsFrom(centerPoints, route, "partner-double-line");
    route.partnerHasObstacles = !shortHorizontal;
    route.partnerRouteY = unionPoint.y;
    route.partnerMarker = { x: unionPoint.x, y: unionPoint.y };
    return unionPoint;
  }

  function buildRouteGeometry(route, layout, corridor, trackGroup) {
    if (!route.parentNodes.length) return;
    const subtree = layout.subtreeById.get(route.familySubtreeId);
    const parentBottom = Math.max.apply(null, route.parentNodes.map(function (node) { return node.y + CARD_HEIGHT; }));
    const childTop = route.children.length ? Math.min.apply(null, route.children.map(function (child) { return child.node.y; })) : parentBottom + BASE_CORRIDOR_HEIGHT;
    const centers = route.parentNodes.map(function (node) { return node.x + CARD_WIDTH / 2; }).sort(function (a, b) { return a - b; });
    const childCenter = route.children.length ? route.children.reduce(function (sum, child) { return sum + child.portX; }, 0) / route.children.length : centers.reduce(function (sum, value) { return sum + value; }, 0) / centers.length;
    let anchorX = route.coupleBlock ? route.coupleBlock.centerX : childCenter;
    if (!route.coupleBlock && centers.length === 2) anchorX = Math.max(centers[0] + 14, Math.min(centers[1] - 14, childCenter));
    else if (centers.length === 1) anchorX = Math.max(centers[0] - CARD_WIDTH / 2 + 18, Math.min(centers[0] + CARD_WIDTH / 2 - 18, childCenter));
    route.unionAnchorX = anchorX; route.sourceX = anchorX;
    const partnerUnionPoint = buildPartnerDoubleLineGeometry(route, layout);
    route.partnerHasObstacles = partnerUnionPoint ? route.partnerHasObstacles : false;
    const partnerIndex = Math.max(0, route.trackIndex);
    route.partnerTrackIndex = route.partnerHasObstacles ? partnerIndex : -1;
    if (!partnerUnionPoint) route.partnerRouteY = parentBottom + 12 + partnerIndex * PARTNER_TRACK_SPACING;
    if (partnerUnionPoint) route.unionAnchorX = partnerUnionPoint.x;
    route.unionAnchorY = partnerUnionPoint ? partnerUnionPoint.y : route.partnerRouteY;
    route.sourceY = route.unionAnchorY;
    if (!route.children.length) {
      if (route.partnerRelationship && route.parentNodes.length === 2) {
        route.segments = route.drawPartnerLine ? route.partnerSegments : [];
        route.routeLength = route.segments.reduce(function (sum, item) { return sum + Math.hypot(item.x2 - item.x1, item.y2 - item.y1); }, 0);
      }
      return;
    }
    const busBase = corridor ? corridor.top + 30 : parentBottom + 42;
    route.busY = busBase + route.trackIndex * TRACK_SPACING;
    if (route.busY >= childTop - 14) route.busY = childTop - 14 - Math.max(0, (corridor && corridor.trackCount - route.trackIndex - 1 || 0) * 2);
    const childXs = route.children.map(function (child) { return child.portX; });
    const minChild = childXs.length ? Math.min.apply(null, childXs) : anchorX;
    const maxChild = childXs.length ? Math.max.apply(null, childXs) : anchorX;
    route.busMinX = Math.min(anchorX, minChild); route.busMaxX = Math.max(anchorX, maxChild);
    if (Math.abs(route.busMaxX - route.busMinX) < BUS_STUB * 2) { route.busMinX -= BUS_STUB; route.busMaxX += BUS_STUB; }
    if (subtree) {
      if (route.busMinX < subtree.minX) subtree.minX = route.busMinX - 20;
      if (route.busMaxX > subtree.maxX) subtree.maxX = route.busMaxX + 20;
      subtree.bounds.x = subtree.minX; subtree.bounds.width = subtree.maxX - subtree.minX;
      route.busMinX = Math.max(route.busMinX, subtree.minX + 1); route.busMaxX = Math.min(route.busMaxX, subtree.maxX - 1);
    }
    trackGroup.minX = route.busMinX; trackGroup.maxX = route.busMaxX;

    const parentSegments = [];
    const parentPaths = [];
    if (route.parentNodes.length === 2 && route.partnerRelationship) {
      const stemPoints = [{ x: route.unionAnchorX, y: route.unionAnchorY }, { x: route.unionAnchorX, y: route.busY }];
      parentPaths.push(pathFrom(stemPoints)); parentSegments.push.apply(parentSegments, segmentsFrom(stemPoints, route, "parent-stem"));
    } else {
      route.parentNodes.forEach(function (node, index) {
        const start = { x: node.x + CARD_WIDTH / 2, y: node.y + CARD_HEIGHT };
        const turn = { x: start.x, y: route.partnerRouteY };
        const anchor = { x: anchorX, y: route.partnerRouteY };
        const points = [start, turn, anchor];
        parentPaths.push(pathFrom(points)); parentSegments.push.apply(parentSegments, segmentsFrom(points, route, "parent-stem"));
      });
      const stemPoints = [{ x: anchorX, y: route.partnerRouteY }, { x: anchorX, y: route.busY }];
      parentPaths.push(pathFrom(stemPoints)); parentSegments.push.apply(parentSegments, segmentsFrom(stemPoints, route, "parent-stem"));
    }
    route.parentPathD = parentPaths.join(" ");
    route.busPathD = pathFrom([{ x: route.busMinX, y: route.busY }, { x: route.busMaxX, y: route.busY }]);
    const busSegments = [segment({ x: route.busMinX, y: route.busY }, { x: route.busMaxX, y: route.busY }, route, "children-bus", 1, "")];
    route.children.forEach(function (child) {
      const points = [{ x: child.portX, y: route.busY }, { x: child.portX, y: child.portY }];
      child.pathD = pathFrom(points);
      child.segments = segmentsFrom(points, route, child.role, child.id);
    });
    route.segments = (route.drawPartnerLine ? route.partnerSegments || [] : []).concat(parentSegments, busSegments, route.children.reduce(function (all, child) { return all.concat(child.segments); }, []));
    route.routeLength = route.segments.reduce(function (sum, item) { return sum + Math.hypot(item.x2 - item.x1, item.y2 - item.y1); }, 0);
    if (subtree) {
      const ys = route.parentNodes.concat(route.children.map(function (child) { return child.node; })).map(function (node) { return [node.y, node.y + CARD_HEIGHT]; }).reduce(function (all, pair) { return all.concat(pair); }, [route.busY]);
      subtree.bounds.y = Math.min.apply(null, ys); subtree.bounds.height = Math.max.apply(null, ys) - subtree.bounds.y;
      const union = layout.unionModel.unionById.get(route.unionNodeId); union.centerX = anchorX; union.anchorY = route.unionAnchorY; union.bounds = Object.assign({}, subtree.bounds);
    }
  }

  function findCrossings(routes) {
    const horizontal = []; const vertical = [];
    routes.forEach(function (route) {
      route.segments.forEach(function (item) {
        if (item.orientation === "horizontal") horizontal.push(item);
        else if (item.orientation === "vertical") vertical.push(item);
      });
    });
    const result = []; const seen = new Set();
    horizontal.forEach(function (h) {
      vertical.forEach(function (v) {
        if (h.familyKey === v.familyKey) return;
        const minX = Math.min(h.x1, h.x2); const maxX = Math.max(h.x1, h.x2); const minY = Math.min(v.y1, v.y2); const maxY = Math.max(v.y1, v.y2);
        if (v.x1 <= minX + EPSILON || v.x1 >= maxX - EPSILON || h.y1 <= minY + EPSILON || h.y1 >= maxY - EPSILON) return;
        const key = [Math.round(v.x1 * 10), Math.round(h.y1 * 10), h.familyKey, v.familyKey].join("|");
        if (seen.has(key)) return; seen.add(key);
        result.push({ x: v.x1, y: h.y1, horizontalFamilyKey: h.familyKey, verticalFamilyKey: v.familyKey, horizontalRole: h.role, verticalRole: v.role, verticalChildId: v.targetChildId || "", horizontalRouteId: h.routeId, verticalRouteId: v.routeId });
      });
    });
    return result;
  }

  function routeFamilyUnits(persons, relationships, nodes, cardWidth, cardHeight, layout) {
    const startedAt = performance.now();
    const activeLayout = layout || computeTreeLayout(persons, relationships, "", {});
    const routeGenerationStartedAt = performance.now();
    const routes = prepareRoutes(activeLayout);
    const unionNodeGenerationMs = activeLayout.performance.unionNodeGenerationMs || 0;
    const allocation = allocateTrackGroups(routes);
    applyGenerationLayerY(activeLayout, routes, allocation);
    allocatePersonPorts(activeLayout, routes);
    const corridors = [];
    allocation.byCorridor.forEach(function (corridorRoutes, id) {
      const parents = corridorRoutes.reduce(function (all, route) { return all.concat(route.parentNodes); }, []);
      const children = corridorRoutes.reduce(function (all, route) { return all.concat(route.children.map(function (child) { return child.node; })); }, []);
      const top = parents.length ? Math.max.apply(null, parents.map(function (node) { return node.y + CARD_HEIGHT; })) : 0;
      const bottom = children.length ? Math.min.apply(null, children.map(function (node) { return node.y; })) : top + BASE_CORRIDOR_HEIGHT;
      corridors.push({ id: id, key: id, parentGeneration: corridorRoutes[0].parentGeneration, childGeneration: corridorRoutes[0].childGeneration, component: corridorRoutes[0].component, top: top, bottom: bottom, trackCount: corridorRoutes.length, trackSpacing: TRACK_SPACING, familyKeys: corridorRoutes.map(function (route) { return route.familyKey; }), trackGroups: allocation.trackGroups.filter(function (group) { return group.corridorId === id; }) });
    });
    const corridorById = new Map(corridors.map(function (corridor) { return [corridor.id, corridor]; }));
    const trackGroupById = new Map(allocation.trackGroups.map(function (group) { return [group.id, group]; }));
    routes.forEach(function (route) { buildRouteGeometry(route, activeLayout, corridorById.get(route.corridorId), trackGroupById.get(route.trackGroupId)); });
    updateDirectSpineBounds(activeLayout, routes);
    const crossings = findCrossings(routes);
    const routeGenerationMs = performance.now() - routeGenerationStartedAt;
    const diagnosticStartedAt = performance.now();
    activeLayout.routes = routes; activeLayout.corridors = corridors; activeLayout.trackGroups = allocation.trackGroups;
    activeLayout.bounds = computeBounds(activeLayout.nodes);
    const routeXs = routes.reduce(function (all, route) { return all.concat(route.segments.reduce(function (values, item) { return values.concat([item.x1, item.x2]); }, [])); }, []);
    const routeYs = routes.reduce(function (all, route) { return all.concat(route.segments.reduce(function (values, item) { return values.concat([item.y1, item.y2]); }, [])); }, []);
    if (routeXs.length) {
      const minX = Math.min(activeLayout.bounds.x, Math.min.apply(null, routeXs) - PADDING_X); const maxX = Math.max(activeLayout.bounds.x + activeLayout.bounds.width, Math.max.apply(null, routeXs) + PADDING_X);
      const minY = Math.min(activeLayout.bounds.y, Math.min.apply(null, routeYs) - PADDING_Y); const maxY = Math.max(activeLayout.bounds.y + activeLayout.bounds.height, Math.max.apply(null, routeYs) + PADDING_Y);
      activeLayout.bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    const diagnostics = Validator.validate(activeLayout, routes, relationships, crossings);
    const diagnosticMs = performance.now() - diagnosticStartedAt;
    routes.forEach(function (route) { route.routingIssues = diagnostics.issues.filter(function (issue) { return (issue.familyKeys || []).includes(route.familyKey) || issue.routeId === route.routeId; }); });
    activeLayout.performance.routeGenerationMs = routeGenerationMs;
    activeLayout.performance.diagnosticMs = diagnosticMs;
    activeLayout.performance.totalLayoutMs = performance.now() - startedAt + (activeLayout.performance.computeBeforeRoutingMs || 0);
    diagnostics.performance = Object.assign({}, activeLayout.performance, { unionNodeGenerationMs: unionNodeGenerationMs });
    return { routes: routes, corridors: corridors, trackGroups: allocation.trackGroups, crossings: crossings, diagnostics: diagnostics };
  }

  function buildFamilyUnits(persons, relationships, generationState) { return legacyFamilyUnits(UnionBuilder.build(persons, relationships, generationState)); }
  function buildSiblingGroups(persons, relationships, unitsOrState, generationState) {
    const state = generationState || unitsOrState;
    return UnionBuilder.build(persons, relationships, state).siblingGroups;
  }

  globalThis.TreeLayout = Object.freeze({
    compute: computeTreeLayout,
    buildFamilyUnits: buildFamilyUnits,
    buildSiblingGroups: buildSiblingGroups,
    routeFamilyUnits: routeFamilyUnits,
    comparePeople: comparePeople,
    CARD_WIDTH: CARD_WIDTH,
    CARD_HEIGHT: CARD_HEIGHT,
    FAMILY_LANE_GAP: TRACK_SPACING,
    FAMILY_INTERVAL_MARGIN: 16,
    BASE_CORRIDOR_HEIGHT: BASE_CORRIDOR_HEIGHT
  });
}());
