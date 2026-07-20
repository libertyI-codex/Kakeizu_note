(function () {
  "use strict";

  const EPSILON = 0.75;
  function stable(value) { return String(value === undefined || value === null ? "" : value); }
  function normalizedIds(values) { return Array.from(new Set((values || []).map(stable))).sort(); }
  function sameIds(first, second) { return normalizedIds(first).join("|") === normalizedIds(second).join("|"); }
  function between(value, first, second, margin) { return value >= Math.min(first, second) - margin && value <= Math.max(first, second) + margin; }
  function isHorizontal(segment) { return Math.abs(segment.y1 - segment.y2) < EPSILON; }
  function isVertical(segment) { return Math.abs(segment.x1 - segment.x2) < EPSILON; }

  function validate(layout, routes, relationships, crossings) {
    const startedAt = performance.now();
    const issues = [];
    const seenIssue = new Set();
    function add(code, severity, details, message) {
      const key = [code, stable(details && details.routeId), stable(details && details.personId), stable(details && details.otherRouteId)].join("|");
      if (seenIssue.has(key)) return;
      seenIssue.add(key);
      issues.push(Object.assign({ code: code, type: code, severity: severity, message: message || code, familyKeys: [] }, details || {}));
    }

    const nodes = layout.nodes || [];
    const nodeIds = new Set();
    nodes.forEach(function (node) {
      if (nodeIds.has(node.id)) add("person-card-duplicated", "error", { personId: node.id }, "同じ人物カードが複数生成されています。");
      nodeIds.add(node.id);
    });
    const nodeById = new Map(nodes.map(function (node) { return [node.id, node]; }));
    const directSpine = layout.directSpine || null;
    const directPersonIds = new Set(directSpine && directSpine.directPersonIds || []);
    const ancestorSpineTargets = new Set([directSpine && directSpine.focusPersonId].filter(Boolean).concat(directSpine && directSpine.directAncestorIds || []));
    const focusNode = directSpine ? nodeById.get(directSpine.focusPersonId) : null;
    if (layout.personById && typeof layout.personById.forEach === "function") layout.personById.forEach(function (_, personId) {
      if (!nodeById.has(personId)) add("person-without-primary-position", "error", { personId: personId }, "人物の主表示位置がありません。");
    });
    for (let first = 0; first < nodes.length; first += 1) for (let second = first + 1; second < nodes.length; second += 1) {
      const a = nodes[first]; const b = nodes[second];
      if (a.component !== b.component || a.generation !== b.generation) continue;
      if (Math.min(a.x + layout.cardWidth, b.x + layout.cardWidth) - Math.max(a.x, b.x) > EPSILON && Math.abs(a.y - b.y) < layout.cardHeight - EPSILON) {
        add("generation-layer-overlap", "error", { personId: a.id, otherPersonId: b.id }, "同一世代の人物カードが重なっています。");
      }
    }

    const unionIds = new Set();
    (layout.unionNodes || []).forEach(function (union) {
      if (unionIds.has(union.id)) add("duplicate-union-node", "error", { unionNodeId: union.id, familyKeys: [union.familyKey] }, "UnionNodeが重複しています。");
      unionIds.add(union.id);
      if (!union.parentIds.length || union.parentIds.some(function (id) { return !nodeById.has(id); })) add("union-node-parent-mismatch", "error", { unionNodeId: union.id, familyKeys: [union.familyKey] }, "UnionNodeの親IDと表示人物が一致しません。");
    });

    const relationshipById = new Map(relationships.map(function (item) { return [item.id, item]; }));
    const coupleIds = new Set();
    (layout.coupleBlocks || []).forEach(function (block) {
      if (coupleIds.has(block.id)) add("duplicate-couple-block", "error", { coupleBlockId: block.id, relationshipId: block.relationshipId }, "CoupleBlockが重複しています。");
      coupleIds.add(block.id);
      const relationship = relationshipById.get(block.relationshipId);
      const displayedIds = [block.leftPersonId, block.rightPersonId];
      if (!relationship || relationship.type !== "partner" || !sameIds(displayedIds, [relationship.fromPersonId, relationship.toPersonId])) {
        add("couple-block-relationship-mismatch", "error", { coupleBlockId: block.id, relationshipId: block.relationshipId }, "CoupleBlockとrelationshipsの人物IDが一致しません。");
      }
      const left = nodeById.get(block.leftPersonId); const right = nodeById.get(block.rightPersonId);
      if (block.status === "current" && left && right && left.generation === right.generation) {
        const gap = right.x - (left.x + layout.cardWidth);
        if (gap < 23 || gap > 37) add("current-couple-not-adjacent", "warning", { coupleBlockId: block.id, relationshipId: block.relationshipId }, "現在のパートナーが標準間隔で隣接していません。");
      }
    });
    const busSegments = [];
    routes.forEach(function (route) {
      const subtree = layout.subtreeById && layout.subtreeById.get(route.familySubtreeId);
      if (route.drawPartnerLine && route.partnerRelationship) {
        if (!route.coupleBlockId || !coupleIds.has(route.coupleBlockId)) add("couple-block-missing", "error", { routeId: route.routeId, relationshipId: route.partnerRelationship.id, familyKeys: [route.familyKey] }, "パートナー線に対応するCoupleBlockがありません。");
        if (!route.partnerPorts || !route.partnerPorts.left || !route.partnerPorts.right) add("partner-port-missing", "error", { routeId: route.routeId, relationshipId: route.partnerRelationship.id, familyKeys: [route.familyKey] }, "パートナー線の専用ポートがありません。");
        if (!route.partnerLinePaths || route.partnerLinePaths.length !== 2) add("partner-double-line-missing", "error", { routeId: route.routeId, relationshipId: route.partnerRelationship.id, familyKeys: [route.familyKey] }, "婚姻・パートナー線が二重線になっていません。");
      }
      if (!route.unionNodeId || !unionIds.has(route.unionNodeId)) add("union-node-missing", "error", { routeId: route.routeId, familyKeys: [route.familyKey] }, "経路に対応するUnionNodeがありません。");
      if (!route.children.length && route.busPathD) add("children-bus-without-child", "error", { routeId: route.routeId, familyKeys: [route.familyKey] }, "子どもがいないchildren-busが生成されています。");
      if (route.children.length && subtree && (route.busMinX < subtree.minX - EPSILON || route.busMaxX > subtree.maxX + EPSILON)) {
        add("children-bus-outside-subtree", "error", { routeId: route.routeId, familyKeys: [route.familyKey] }, "children-busがFamilySubtree境界を越えています。");
      }
      const bus = (route.segments || []).find(function (segment) { return segment.role === "children-bus"; });
      if (bus) busSegments.push(bus);
      const parentSegments = (route.segments || []).filter(function (segment) { return segment.role === "parent-stem"; });
      if (route.children.length && (!parentSegments.length || !parentSegments.some(function (segment) {
        return (Math.abs(segment.x2 - route.unionAnchorX) < EPSILON && Math.abs(segment.y2 - route.busY) < EPSILON) || (Math.abs(segment.x1 - route.unionAnchorX) < EPSILON && Math.abs(segment.y1 - route.busY) < EPSILON);
      }))) add("parent-stem-wrong-union", "error", { routeId: route.routeId, familyKeys: [route.familyKey] }, "parent-stemが同じUnionNodeのchildren-busへ接続していません。");
      route.children.forEach(function (child) {
        if (!child.id || !route.childIds.includes(child.id)) add("child-union-mismatch", "error", { routeId: route.routeId, personId: child.id, familyKeys: [route.familyKey] }, "子どもの所属UnionNodeが一致しません。");
        const stem = (child.segments || []).filter(function (segment) { return segment.role === "child-stem" || segment.role === "adoptive-route" || segment.role === "step-route"; });
        if (!stem.length) add("child-stem-wrong-target", "error", { routeId: route.routeId, personId: child.id, familyKeys: [route.familyKey] }, "子どもへの接続線がありません。");
        const last = stem[stem.length - 1];
        if (last && (Math.abs(last.x2 - child.portX) > EPSILON || Math.abs(last.y2 - child.portY) > EPSILON)) add("child-stem-wrong-target", "error", { routeId: route.routeId, personId: child.id, familyKeys: [route.familyKey] }, "child-stemが対象人物の専用ポートへ接続していません。");
        if (bus && stem.length && (Math.abs(stem[0].y1 - bus.y1) > EPSILON || !between(stem[0].x1, bus.x1, bus.x2, EPSILON))) add("child-stem-wrong-union", "error", { routeId: route.routeId, personId: child.id, familyKeys: [route.familyKey] }, "child-stemの始点が同じUnionNodeのchildren-bus上にありません。");
        const relationshipParents = child.relationships.map(function (item) { return item.fromPersonId; });
        if (!sameIds(relationshipParents, route.parentIds)) add("route-data-relationship-mismatch", "error", { routeId: route.routeId, personId: child.id, familyKeys: [route.familyKey] }, "SVG経路の親IDとrelationshipsが一致しません。");
        child.relationships.forEach(function (item) {
          const stored = relationshipById.get(item.id);
          if (!stored || stored.toPersonId !== child.id || !route.parentIds.includes(stored.fromPersonId)) add("route-data-relationship-mismatch", "error", { routeId: route.routeId, personId: child.id, familyKeys: [route.familyKey] }, "SVG経路から元のrelationshipを逆引きできません。");
        });
        if (directSpine && directPersonIds.has(child.id)) {
          if (route.parentNodes.some(function (parent) { return parent.y >= child.node.y - EPSILON; })) add("ancestor-union-not-above-child", "error", { routeId: route.routeId, personId: child.id, unionNodeId: route.unionNodeId, familyKeys: [route.familyKey] }, "直系祖先のUnionNodeが対象人物より上にありません。");
          if (ancestorSpineTargets.has(child.id)) {
            const drift = Math.abs(route.unionAnchorX - (child.node.x + layout.cardWidth / 2));
            if (drift > layout.cardWidth * 1.5) add("direct-line-horizontal-drift", "warning", { routeId: route.routeId, personId: child.id, unionNodeId: route.unionNodeId, horizontalDrift: drift, familyKeys: [route.familyKey] }, "直系UnionNodeと対象人物の横方向のずれが大きくなっています。");
          }
        }
      });
      if (directSpine && route.parentNodes.some(function (parent) { return directPersonIds.has(parent.id); }) && route.children.some(function (child) { return directPersonIds.has(child.id); })) {
        const directParent = route.parentNodes.filter(function (parent) { return directPersonIds.has(parent.id); }).sort(function (first, second) { return Math.abs(first.generation - directSpine.focusGeneration) - Math.abs(second.generation - directSpine.focusGeneration) || stable(first.id).localeCompare(stable(second.id)); })[0];
        const directChildren = route.children.filter(function (child) { return directPersonIds.has(child.id); });
        if (directParent && directChildren.some(function (child) { return child.node.y <= directParent.y + EPSILON; })) add("descendant-union-not-below-focus", "error", { routeId: route.routeId, personId: directParent.id, unionNodeId: route.unionNodeId, familyKeys: [route.familyKey] }, "直系子孫のFamilySubtreeが基準側人物より下にありません。");
        if (directParent) {
          const drift = Math.abs(route.unionAnchorX - (directParent.x + layout.cardWidth / 2));
          if (drift > layout.cardWidth * 1.5) add("direct-line-horizontal-drift", "warning", { routeId: route.routeId, personId: directParent.id, unionNodeId: route.unionNodeId, horizontalDrift: drift, familyKeys: [route.familyKey] }, "子孫へ向かう直系UnionNodeの横方向のずれが大きくなっています。");
          if (drift > layout.cardWidth * 2.5) {
            const layerNodes = nodes.filter(function (node) { return node.component === directParent.component && node.generation === directParent.generation; }).sort(function (first, second) { return first.x - second.x; });
            let maximumGap = 0;
            for (let index = 1; index < layerNodes.length; index += 1) maximumGap = Math.max(maximumGap, layerNodes[index].x - (layerNodes[index - 1].x + layout.cardWidth));
            if (maximumGap > layout.cardWidth) add("unused-space-with-direct-line-displacement", "error", { routeId: route.routeId, personId: directParent.id, unionNodeId: route.unionNodeId, horizontalDrift: drift, familyKeys: [route.familyKey] }, "空き領域がある状態で直系UnionNodeが大きく横へずれています。");
          }
        }
      }
      if (route.children.length) {
        const span = route.children.map(function (child) { return child.portX; });
        const minimum = Math.min.apply(null, span); const maximum = Math.max.apply(null, span);
        if (route.unionAnchorX < minimum - 24 || route.unionAnchorX > maximum + 24) add("union-center-outside-child-span", "warning", { routeId: route.routeId, familyKeys: [route.familyKey] }, "UnionNode中心が子ども群の外側にあります。人物カードを複製しない制約を優先しています。");
      }
    });

    for (let first = 0; first < busSegments.length; first += 1) for (let second = first + 1; second < busSegments.length; second += 1) {
      const a = busSegments[first]; const b = busSegments[second];
      if (a.familyKey === b.familyKey) continue;
      if (Math.abs(a.y1 - b.y1) < EPSILON && Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2)) >= Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2)) - EPSILON) {
        add("cross-family-bus-contact", "error", { routeId: a.routeId, otherRouteId: b.routeId, familyKeys: [a.familyKey, b.familyKey] }, "異なる家族のchildren-busが接触しています。");
      }
    }

    const partnerPairs = new Set(relationships.filter(function (item) { return item.type === "partner"; }).reduce(function (values, item) { values.push([item.fromPersonId, item.toPersonId].sort().join("|")); return values; }, []));
    if (directSpine) {
      (layout.placementAtoms || []).forEach(function (atom) {
        if (atom.component !== (focusNode && focusNode.component) || atom.personIds.some(function (id) { return directPersonIds.has(id); })) return;
        if (atom.x < directSpine.spineX - EPSILON && atom.x + atom.width > directSpine.spineX + EPSILON) add("collateral-subtree-crosses-spine", "warning", { placementAtomId: atom.id, personIds: atom.personIds.slice() }, "傍系FamilySubtreeが直系スパインを横切っています。");
      });
    }
    (layout.siblingGroups || []).forEach(function (group) {
      if (!group.orderedChildIds.length) return;
      const memberSet = new Set(group.orderedChildIds);
      const intruders = nodes.filter(function (node) { return node.generation === group.generation && node.x + layout.cardWidth / 2 > group.minX && node.x + layout.cardWidth / 2 < group.maxX && !memberSet.has(node.id); });
      if (intruders.length) {
        const spouse = intruders.find(function (node) { return group.orderedChildIds.some(function (id) { return partnerPairs.has([id, node.id].sort().join("|")); }); });
        if (spouse) add("spouse-ancestor-inside-sibling-group", "warning", { siblingGroupId: group.id, personId: spouse.id }, "配偶者側の人物が兄弟グループ内部へ入っています。");
        else add("unrelated-person-inside-sibling-group", "error", { siblingGroupId: group.id, personId: intruders[0].id }, "兄弟グループ内へ無関係な人物が入り込んでいます。");
      }
    });

    const subtrees = layout.familySubtrees || [];
    subtrees.forEach(function (subtree) {
      if (subtree.maxX - subtree.minX + EPSILON < subtree.computedWidth) add("subtree-width-underestimated", "warning", { familySubtreeId: subtree.id, familyKeys: [subtree.familyKey] }, "FamilySubtree境界を実配置に合わせて拡張しました。");
    });
    for (let first = 0; first < subtrees.length; first += 1) for (let second = first + 1; second < subtrees.length; second += 1) {
      const a = subtrees[first]; const b = subtrees[second];
      if (a.generation !== b.generation) continue;
      const aMembers = new Set(a.memberPersonIds || a.directPersonIds || []);
      if ((b.memberPersonIds || b.directPersonIds || []).some(function (id) { return aMembers.has(id); })) continue;
      const overlap = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      if (overlap <= EPSILON) continue;
      add("family-subtree-overlap", "warning", { familySubtreeId: a.id, otherFamilySubtreeId: b.id, familyKeys: [a.familyKey, b.familyKey] }, "独立したFamilySubtreeの専用横境界が重なっています。");
      const intrusion = (b.directPersonIds || []).map(function (id) { return nodeById.get(id); }).filter(Boolean).find(function (node) { const center = node.x + layout.cardWidth / 2; return center > a.minX + EPSILON && center < a.maxX - EPSILON; });
      if (intrusion) add("family-subtree-intrusion", "warning", { familySubtreeId: a.id, otherFamilySubtreeId: b.id, personId: intrusion.id, familyKeys: [a.familyKey, b.familyKey] }, "別FamilySubtreeの人物が専用横境界内にあります。");
    }

    (layout.generationDiagnostics || []).forEach(function (item) {
      const code = item.type || "generation-conflict";
      add(code, item.severity === "error" ? "error" : "warning", { personId: item.personId, relationshipIds: item.relationshipIds || [] }, item.message);
    });
    (layout.layoutDiagnostics || []).forEach(function (item) {
      add(item.type || item.code || "layout-warning", item.severity === "error" ? "error" : "warning", item, item.message);
    });

    const result = {
      issues: issues,
      errorCount: issues.filter(function (item) { return item.severity === "error"; }).length,
      warningCount: issues.filter(function (item) { return item.severity !== "error"; }).length,
      crossingCount: (crossings || []).length,
      validationMs: performance.now() - startedAt
    };
    return result;
  }

  globalThis.FamilyLayoutValidator = Object.freeze({ validate: validate });
}());
