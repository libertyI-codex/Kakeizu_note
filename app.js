(function () {
  "use strict";

  const DB = globalThis.FamilyTreeDB;
  const Layout = globalThis.TreeLayout;
  const PersonCandidates = globalThis.PersonCandidateUtils;
  const Kinship = globalThis.KinshipCalculator;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const state = {
    persons: [],
    relationships: [],
    duplicateExclusions: [],
    visiblePersons: [],
    visibleRelationships: [],
    settings: null,
    kinshipState: null,
    kinshipFilter: "all",
    currentTree: null,
    selectedPersonId: "",
    selectedFamilyKey: "",
    layout: null,
    transform: { x: 0, y: 0, scale: 1 },
    pointers: new Map(),
    dragMoved: false,
    pinch: null,
    suppressClickUntil: 0,
    photoValue: "",
    saveScaleTimer: null,
    personFormContext: null,
    personSaving: false,
    relativeSource: "new",
    selectedExistingRelativeId: "",
    relationshipMenu: null,
    currentView: "tree",
    mergePair: null,
    photoInfo: null,
    searchTimer: null
  };
  const elements = {};

  function cacheElements() {
    [
      "personSearch", "searchResults", "menuButton", "privacyNotice", "treeStage", "treeSvg", "treeViewport",
      "treeLoading", "treeEmpty", "treeError", "treeErrorMessage", "retryButton", "zoomOutButton", "zoomInButton",
      "centerButton", "fitAllButton", "resetScaleButton", "focusButton", "detailPanel", "detailContent", "detailBackdrop", "personDialog", "personForm",
      "treeSection", "peopleSection", "peopleCount", "peopleSort", "peopleFilter", "personList", "issuesButton", "mobileMenuButton",
      "personDialogTitle", "personId", "photoPreview", "photoInput", "removePhotoButton", "photoCompressionNotice", "familyName", "givenName",
      "formerFamilyName", "familyNameKana", "givenNameKana", "nickname", "otherNames", "honorific", "nameMemo", "gender", "personVerificationStatus", "birthDate", "isDeceased", "deathDate",
      "birthDatePrecision", "birthDateYear", "birthDateMonth", "birthDateDay", "birthDateApproximate", "birthDatePreview",
      "birthYearField", "birthMonthField", "birthDayField", "birthApproximateField",
      "deathDatePrecision", "deathDateYear", "deathDateMonth", "deathDateDay", "deathDateApproximate", "deathDatePreview",
      "deathYearField", "deathMonthField", "deathDayField", "deathApproximateField", "deathDateLabel", "birthplace", "memo", "personFormError", "savePersonButton", "relationshipDialog",
      "relationshipForm", "relationshipDialogTitle", "relationshipId", "relationshipBaseId", "relationKind", "relationTarget",
      "parentDirectionField", "baseParentLabel", "baseChildLabel", "relationType", "relationStatusLabel", "relationStatus",
      "relationStartDate", "relationEndDate", "relationMemo", "relationshipVerificationStatus", "relationshipFormError", "saveRelationshipButton",
      "relativeDialog", "relativeForm", "relativeBaseId", "relativeRole", "relativeNewPanel", "relativeExistingPanel",
      "relativePersonSearch", "relativePersonResults", "quickRelationType", "quickStatusLabel", "quickStatus",
      "quickStartDate", "quickEndDate", "quickMemo", "relativeFormError", "relativeContinueButton",
      "relationshipMenuDialog", "relationshipMenuTitle", "moveRelationUpButton", "moveRelationDownButton",
      "resetRelationOrderButton", "focusDialog", "focusPersonList", "viewRangeButton", "viewSummary", "kinshipSummary", "kinshipLegend", "kinshipFilter", "viewRangeDialog", "viewRangeForm",
      "treeViewMode", "kinshipDepth", "includePartners", "showGenerationLabels", "kinshipDisplayMode", "settingsDialog", "exportButton", "importInput", "importMode",
      "openPeopleButton", "openIssuesButton", "duplicateButton", "issuesDialog", "issuesContent", "duplicateDialog", "duplicateContent",
      "mergeDialog", "mergeForm", "mergeKeepChoices", "mergeFields", "mergeError", "mergeBackupButton", "mergeSubmitButton",
      "openPngButton", "pngDialog", "pngForm", "pngPrivacyMode", "savePngButton", "pngError",
      "openPrintButton", "printDialog", "printForm", "printTitle", "printNote", "printPaperSize", "printScope", "printPrivacyMode",
      "printShowDate", "printShowGenerationLabels", "printPreview", "printButton", "printArea", "printPageStyle",
      "resetSampleButton", "deleteAllButton", "toastRegion"
    ].forEach(function (id) { elements[id] = document.getElementById(id); });
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function fullName(person) {
    if (!person) return "不明な人物";
    return ((person.familyName || "") + " " + (person.givenName || "")).trim() || "名前未設定";
  }

  function initialOf(person) {
    const name = (person && (person.givenName || person.familyName)) || "人";
    return Array.from(name)[0] || "人";
  }

  function compactText(value, length) {
    const chars = Array.from(value || "");
    return chars.length > length ? chars.slice(0, length - 1).join("") + "…" : chars.join("");
  }

  function yearFromDate(value) {
    return value && /^\d{4}/.test(value) ? value.slice(0, 4) : "";
  }

  function personDatePrecision(person, kind) {
    const key = kind + "DatePrecision";
    return person && person[key] ? person[key] : DB.inferDatePrecision(person && person[kind + "Date"]);
  }

  function formatPersonDate(person, kind, unknownLabel) {
    const value = person && person[kind + "Date"];
    const precision = personDatePrecision(person, kind);
    if (!value || precision === "unknown") return unknownLabel || "不明";
    const parts = value.split("-").map(Number);
    let text = parts[0] + "年";
    if (precision === "month" || precision === "day") text += parts[1] + "月";
    if (precision === "day") text += parts[2] + "日";
    if (person[kind + "DateApproximate"]) text += "頃";
    return text;
  }

  function lifeYears(person) {
    const birth = yearFromDate(person.birthDate);
    const death = person.isDeceased ? yearFromDate(person.deathDate) : "";
    if (!birth && !death) return person.isDeceased ? "故人" : "生年不明";
    const birthText = birth ? birth + "年" + (person.birthDateApproximate ? "頃" : "") : "?";
    const deathText = death ? death + "年" + (person.deathDateApproximate ? "頃" : "") : "?";
    if (person.isDeceased) return birthText + "–" + deathText;
    return birth ? birthText + "生" : "生年不明";
  }

  function formatDate(value) {
    if (!value) return "未登録";
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? Number(match[1]) + "年" + Number(match[2]) + "月" + Number(match[3]) + "日" : value;
  }

  function normalizedPersonText(person) {
    return DB.normalizeSearchText([
      person.familyName, person.givenName, person.formerFamilyName, person.familyNameKana, person.givenNameKana,
      person.nickname, person.otherNames, person.honorific, person.nameMemo, person.birthplace
    ].join(" "));
  }

  function matchesPersonSearch(person, query) {
    const normalized = DB.normalizeSearchText(query);
    return !normalized || normalizedPersonText(person).includes(normalized);
  }

  function personCandidateOptionLabel(person) {
    const details = [];
    const kana = ((person.familyNameKana || "") + " " + (person.givenNameKana || "")).trim();
    if (person.formerFamilyName) details.push("旧姓 " + person.formerFamilyName);
    if (kana) details.push(kana);
    if (person.birthDate) details.push(formatPersonDate(person, "birth", ""));
    if (person.isDeceased) details.push("故人");
    return fullName(person) + (details.length ? "（" + details.join("・") + "）" : "");
  }

  function candidateIdentityHtml(person, showIdentifier) {
    const formerName = person.formerFamilyName ? "<span>旧姓 " + escapeHtml(person.formerFamilyName) + "</span>" : "";
    const kana = ((person.familyNameKana || "") + " " + (person.givenNameKana || "")).trim();
    const kanaText = kana ? "<span>" + escapeHtml(kana) + "</span>" : "";
    const life = person.birthDate ? formatPersonDate(person, "birth", "") : "生年未登録";
    const deceased = person.isDeceased ? "<span class=\"candidate-deceased\">故人</span>" : "";
    const identifier = showIdentifier ? "<span class=\"candidate-identifier\">識別 " + escapeHtml(String(person.id || "").slice(-8)) + "</span>" : "";
    return "<span class=\"candidate-person-copy\"><strong>" + escapeHtml(fullName(person)) + "</strong>" +
      ((formerName || kanaText) ? "<small class=\"candidate-name-notes\">" + formerName + kanaText + "</small>" : "") +
      "<small class=\"candidate-life\"><span>" + escapeHtml(life) + "</span>" + deceased + identifier + "</small></span>";
  }

  function parentPathExists(startId, targetId) {
    const childrenByParent = new Map();
    state.relationships.forEach(function (relationship) {
      if (relationship.type !== "parent-child") return;
      if (!childrenByParent.has(relationship.fromPersonId)) childrenByParent.set(relationship.fromPersonId, []);
      childrenByParent.get(relationship.fromPersonId).push(relationship.toPersonId);
    });
    const queue = [startId];
    const visited = new Set();
    while (queue.length) {
      const personId = queue.shift();
      if (personId === targetId) return true;
      if (visited.has(personId)) continue;
      visited.add(personId);
      (childrenByParent.get(personId) || []).forEach(function (childId) { queue.push(childId); });
    }
    return false;
  }

  function canAddRelationshipCandidate(baseId, candidateId, spec) {
    if (!baseId || !candidateId || baseId === candidateId) return false;
    const base = findPerson(baseId);
    const candidate = findPerson(candidateId);
    if (!base || !candidate) return false;
    if (state.currentTree && ((base.treeId && base.treeId !== state.currentTree.id) || (candidate.treeId && candidate.treeId !== state.currentTree.id))) return false;
    if (spec.type === "partner") {
      return !state.relationships.some(function (relationship) {
        return relationship.type === "partner" &&
          ((relationship.fromPersonId === baseId && relationship.toPersonId === candidateId) ||
           (relationship.fromPersonId === candidateId && relationship.toPersonId === baseId));
      });
    }
    let parentId = baseId;
    let childId = candidateId;
    if (spec.role === "parent" || spec.direction === "base-child") { parentId = candidateId; childId = baseId; }
    const duplicateOrReverse = state.relationships.some(function (relationship) {
      return relationship.type === "parent-child" &&
        ((relationship.fromPersonId === parentId && relationship.toPersonId === childId) ||
         (relationship.fromPersonId === childId && relationship.toPersonId === parentId));
    });
    return !duplicateOrReverse && !parentPathExists(childId, parentId);
  }

  function relationLabel(type) {
    return { biological: "実親", adoptive: "養親", step: "継親", marriage: "婚姻", partnership: "パートナー" }[type] || "関係";
  }

  function childRelationLabel(type) {
    return { biological: "実親子", adoptive: "養親子", step: "継親子" }[type] || "親子";
  }

  function statusLabel(status, relationshipType) {
    if (status === "current") return relationshipType === "marriage" ? "婚姻中" : "関係継続中";
    return { divorced: "離婚", separated: "別居", ended: "関係終了", unknown: "不明" }[status] || "不明";
  }

  function verificationLabel(status) {
    return { confirmed: "確認済み", probable: "可能性が高い", unconfirmed: "未確認", disputed: "情報が食い違っている" }[status] || "未確認";
  }

  function avatarHtml(person, className) {
    const classValue = className || "mini-avatar";
    if (person.photo) return "<span class=\"" + classValue + "\"><img src=\"" + escapeHtml(person.photo) + "\" alt=\"\"></span>";
    return "<span class=\"" + classValue + "\">" + escapeHtml(initialOf(person)) + "</span>";
  }

  function findPerson(id) {
    return state.persons.find(function (person) { return person.id === id; });
  }

  function findRelationship(id) {
    return state.relationships.find(function (relationship) { return relationship.id === id; });
  }

  function showToast(message, isError) {
    const toast = document.createElement("div");
    toast.className = "toast" + (isError ? " is-error" : "");
    toast.textContent = message;
    elements.toastRegion.appendChild(toast);
    globalThis.setTimeout(function () { toast.remove(); }, isError ? 5000 : 3200);
  }

  function readableError(error, fallback) {
    if (error && typeof error.message === "string" && error.message.trim()) return error.message;
    return fallback || "処理に失敗しました。";
  }

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = busyLabel || "処理中…";
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalLabel || button.textContent;
      button.disabled = false;
      delete button.dataset.originalLabel;
    }
  }

  async function refreshData(options) {
    const previousScale = state.transform.scale;
    const data = await DB.readAll();
    state.persons = data.persons;
    state.relationships = data.relationships;
    state.settings = data.settings;
    state.currentTree = data.currentTree || null;
    state.duplicateExclusions = data.duplicateExclusions || [];
    if (state.selectedPersonId && !findPerson(state.selectedPersonId)) closeDetail();
    renderTree();
    state.transform.scale = Math.max(0.25, Math.min(2.5, previousScale || Number(data.settings.scale) || 1));
    applyTransform();
    if (state.selectedPersonId) renderDetail();
    renderPersonList();
    if (options && options.center) requestAnimationFrame(centerTree);
    if (options && options.revealPersonId) requestAnimationFrame(function () { revealPerson(options.revealPersonId); });
  }

  function svgElement(name, attributes) {
    const element = document.createElementNS(SVG_NS, name);
    Object.keys(attributes || {}).forEach(function (key) { element.setAttribute(key, String(attributes[key])); });
    return element;
  }

  function addPath(parent, d, className, attributes) {
    if (!d || /NaN/.test(d)) return null;
    const pathAttributes = Object.assign({ d: d, class: className || "tree-link" }, attributes || {});
    if (pathAttributes["data-segment-id"] && parent.querySelectorAll) {
      const baseSegmentId = String(pathAttributes["data-segment-id"]);
      const duplicateCount = Array.from(parent.querySelectorAll("[data-segment-id]")).filter(function (item) { return item.getAttribute("data-segment-id") === baseSegmentId || item.getAttribute("data-segment-id").indexOf(baseSegmentId + ":part-") === 0; }).length;
      if (duplicateCount) pathAttributes["data-segment-id"] = baseSegmentId + ":part-" + duplicateCount;
    }
    const path = svgElement("path", pathAttributes);
    parent.appendChild(path);
    return path;
  }

  function parentLineClass(relationships) {
    let className = "tree-link";
    if (relationships.some(function (item) { return item.relationshipType === "adoptive"; })) className += " tree-parent-adoptive";
    else if (relationships.some(function (item) { return item.relationshipType === "step"; })) className += " tree-parent-step";
    if (relationships.some(function (item) { return item.verificationStatus && item.verificationStatus !== "confirmed"; })) className += " is-unverified";
    return className;
  }

  function partnerLineClass(relationship) {
    let className = "tree-link tree-partner-link";
    if (relationship.status === "separated") className += " is-separated";
    if (relationship.status === "divorced") className += " is-divorced";
    if (relationship.status === "ended") className += " is-ended";
    if (relationship.status === "unknown") className += " is-unknown";
    if (relationship.verificationStatus && relationship.verificationStatus !== "confirmed") className += " is-unverified";
    return className;
  }

  function familyLineAttributes(family, role, childIds) {
    const targetChildId = childIds && childIds.length === 1 ? childIds[0] : "";
    return {
      "data-family-key": family.familyKey,
      "data-family-subtree-id": family.familySubtreeId || "",
      "data-union-node-id": family.unionNodeId || "",
      "data-route-id": family.routeId,
      "data-segment-id": family.routeId + ":" + role + (targetChildId ? ":" + targetChildId : ""),
      "data-relation-role": role,
      "data-parent-ids": family.parentIds.join(" "),
      "data-child-ids": (childIds || family.children.map(function (child) { return child.id; })).join(" "),
      "data-target-child-id": targetChildId,
      "data-parent-generation": family.parentGeneration === null ? "unknown" : family.parentGeneration,
      "data-child-generation": family.childGeneration === null ? "unknown" : family.childGeneration,
      "data-corridor-id": family.corridorId || family.corridorKey || "",
      "data-track-group-id": family.trackGroupId || "",
      "data-track-index": Number.isFinite(family.trackIndex) ? family.trackIndex : -1,
      "data-relationship-type": family.relationshipType || "",
      "data-family-lane": Number.isFinite(family.trackIndex) ? family.trackIndex : -1
    };
  }

  function partnerLineAttributes(family, relationship, role, lineIndex) {
    const ports = family.partnerPorts || {};
    return {
      "data-family-key": family.familyKey,
      "data-family-subtree-id": family.familySubtreeId || "",
      "data-couple-block-id": family.coupleBlockId || "",
      "data-union-node-id": family.unionNodeId || "",
      "data-route-id": family.routeId,
      "data-segment-id": family.routeId + ":" + role + ":" + (Number.isFinite(lineIndex) ? lineIndex : "hit"),
      "data-relation-role": role,
      "data-partner-person-ids": relationship.fromPersonId + " " + relationship.toPersonId,
      "data-parent-ids": relationship.fromPersonId + " " + relationship.toPersonId,
      "data-child-ids": family.childIds.join(" "),
      "data-relationship-id": relationship.id,
      "data-relationship-type": relationship.relationshipType === "marriage" ? "marriage" : "partnership",
      "data-status": relationship.status || "current",
      "data-left-port": ports.left && ports.left.name || "partner-right-port",
      "data-right-port": ports.right && ports.right.name || "partner-left-port",
      "data-line-index": Number.isFinite(lineIndex) ? lineIndex : -1,
      tabindex: role === "partner-interaction-hit-area" ? "0" : "-1",
      role: role === "partner-interaction-hit-area" ? "button" : "img"
    };
  }

  function renderPartnerLine(fragment, relationship, from, to, cardWidth, cardHeight, family) {
    const className = partnerLineClass(relationship);
    const typeLabel = relationship.relationshipType === "marriage" ? "婚姻" : "パートナー";
    const statusLabel = { current: "現在", separated: "別居", divorced: "離婚", ended: "関係終了", unknown: "不明" }[relationship.status || "current"] || "不明";
    const accessibleLabel = typeLabel + "・" + statusLabel;
    (family.partnerLinePaths || [family.partnerPathD]).forEach(function (pathD, index) {
      const path = addPath(fragment, pathD, className, partnerLineAttributes(family, relationship, "partner-double-line", index));
      if (path) {
        path.setAttribute("aria-label", accessibleLabel);
        const title = svgElement("title", {}); title.textContent = accessibleLabel; path.appendChild(title);
      }
    });
    const marker = family.partnerMarker || { x: family.unionAnchorX, y: family.unionAnchorY };
    if (relationship.status === "divorced") {
      addPath(fragment, "M " + (marker.x - 4) + " " + (marker.y + 8) + " L " + (marker.x + 4) + " " + (marker.y - 8), "tree-link tree-partner-marker is-divorced", partnerLineAttributes(family, relationship, "partner-status-marker", 0));
    } else if (relationship.status === "ended") {
      addPath(fragment, "M " + (marker.x - 5) + " " + (marker.y - 6) + " L " + (marker.x + 5) + " " + (marker.y + 6) + " M " + (marker.x + 5) + " " + (marker.y - 6) + " L " + (marker.x - 5) + " " + (marker.y + 6), "tree-link tree-partner-marker is-ended", partnerLineAttributes(family, relationship, "partner-status-marker", 0));
    }
    const hit = addPath(fragment, family.partnerHitPathD || family.partnerPathD, "tree-interaction-hit tree-partner-interaction-hit", partnerLineAttributes(family, relationship, "partner-interaction-hit-area"));
    if (hit) { hit.setAttribute("aria-label", accessibleLabel + "の詳細を表示"); const title = svgElement("title", {}); title.textContent = accessibleLabel; hit.appendChild(title); }
  }

  function renderConnections(fragment, layout, persons, relationships) {
    const sourceRelationships = relationships || state.relationships;
    const nodeMap = new Map(layout.nodes.map(function (node) { return [node.id, node]; }));
    const routing = Layout.routeFamilyUnits(persons, sourceRelationships, layout.nodes, layout.cardWidth, layout.cardHeight, layout);
    const families = routing.routes;
    families.forEach(function (family) {
      const childIds = family.children.map(function (child) { return child.id; });
      const issueCodes = family.routingIssues.map(function (issue) { return issue.code; });
      const routingStatus = family.routingIssues.some(function (issue) { return issue.severity === "error"; }) ? "error" : (issueCodes.length ? "warning" : "ok");
      const group = svgElement("g", {
        class: "tree-family-unit" + (family.generationConflict ? " is-generation-conflict" : ""),
        "data-family-key": family.familyKey,
        "data-family-subtree-id": family.familySubtreeId || "",
        "data-couple-block-id": family.coupleBlockId || "",
        "data-union-node-id": family.unionNodeId || "",
        "data-route-id": family.routeId,
        "data-parent-ids": family.parentIds.join(" "),
        "data-child-ids": childIds.join(" "),
        "data-parent-generation": family.parentGeneration === null ? "unknown" : family.parentGeneration,
        "data-child-generation": family.childGeneration === null ? "unknown" : family.childGeneration,
        "data-corridor-id": family.corridorId || family.corridorKey || "",
        "data-track-group-id": family.trackGroupId || "",
        "data-track-index": Number.isFinite(family.trackIndex) ? family.trackIndex : -1,
        "data-relationship-type": family.relationshipType || "",
        "data-family-lane": Number.isFinite(family.trackIndex) ? family.trackIndex : -1,
        "data-routing-status": routingStatus,
        "data-routing-issues": issueCodes.join(" "),
        "data-route-length": Math.round(family.routeLength || 0),
        tabindex: "0", role: "button", "aria-label": "家族線を選択"
      });
      if (family.drawPartnerLine && family.partnerRelationship && family.parentIds.length === 2) {
        const firstParent = nodeMap.get(family.partnerRelationship.fromPersonId);
        const secondParent = nodeMap.get(family.partnerRelationship.toPersonId);
        if (firstParent && secondParent) {
          renderPartnerLine(group, family.partnerRelationship, firstParent, secondParent, layout.cardWidth, layout.cardHeight, family);
        }
      }
      if (family.parentNodes.length && family.children.length) {
        const routeRelationships = family.children.reduce(function (all, child) { return all.concat(child.relationships); }, []);
        addPath(group, family.parentPathD, parentLineClass(routeRelationships), familyLineAttributes(family, "parent-stem"));
        addPath(group, family.busPathD, parentLineClass(routeRelationships), familyLineAttributes(family, "children-bus"));
        addPath(group, family.busPathD, "tree-interaction-hit", familyLineAttributes(family, "interaction-hit-area"));
        group.appendChild(svgElement("circle", Object.assign({ class: "tree-union-anchor", cx: family.unionAnchorX, cy: family.unionAnchorY, r: 3.5 }, familyLineAttributes(family, "union-anchor"))));
        family.children.forEach(function (child) {
          addPath(group, child.pathD, parentLineClass(child.relationships), familyLineAttributes(family, child.role || "child-stem", [child.id]));
          addPath(group, child.pathD, "tree-interaction-hit", familyLineAttributes(family, "interaction-hit-area", [child.id]));
        });
      }
      if (group.childNodes.length) fragment.appendChild(group);
    });
    if (routing.crossings.length) {
      const crossingLayer = svgElement("g", { class: "tree-crossing-layer", "aria-hidden": "true" });
      routing.crossings.forEach(function (crossing) {
        const verticalFamily = families.find(function (family) { return family.familyKey === crossing.verticalFamilyKey; });
        let verticalClass = "tree-link";
        if (verticalFamily && crossing.verticalRole === "child-stem") {
          const child = verticalFamily.children.find(function (item) { return item.id === crossing.verticalChildId; });
          if (child) verticalClass = parentLineClass(child.relationships);
        } else if (verticalFamily && crossing.verticalRole === "partner-double-line" && verticalFamily.partnerRelationship) {
          verticalClass = partnerLineClass(verticalFamily.partnerRelationship);
        }
        const marker = svgElement("g", {
          class: "tree-crossing-marker",
          "data-crossing-type": "non-connection",
          "data-horizontal-family-key": crossing.horizontalFamilyKey,
          "data-vertical-family-key": crossing.verticalFamilyKey,
          "data-horizontal-role": crossing.horizontalRole,
          "data-vertical-role": crossing.verticalRole
        });
        marker.appendChild(svgElement("circle", { class: "tree-crossing-gap", cx: crossing.x, cy: crossing.y, r: 8.5 }));
        const crossingAttributes = verticalFamily ? familyLineAttributes(verticalFamily, "crossing-gap", crossing.verticalChildId ? [crossing.verticalChildId] : undefined) : { "data-relation-role": "crossing-gap", "data-family-key": crossing.verticalFamilyKey };
        crossingAttributes["data-segment-id"] = (verticalFamily && verticalFamily.routeId || "crossing") + ":crossing-gap:" + Math.round(crossing.x) + ":" + Math.round(crossing.y);
        addPath(marker, "M " + crossing.x + " " + (crossing.y - 11) + " V " + (crossing.y + 11), verticalClass + " tree-crossing-overpass", crossingAttributes);
        crossingLayer.appendChild(marker);
      });
      fragment.appendChild(crossingLayer);
    }
    return routing;
  }

  function calculateCurrentKinship(focusPersonId) {
    if (!Kinship) return null;
    state.kinshipState = Kinship.calculateKinshipMap({
      focusPersonId: focusPersonId,
      persons: state.persons,
      relationships: state.relationships
    });
    return state.kinshipState;
  }

  function kinshipFor(personId) {
    return state.kinshipState && state.kinshipState.byPersonId ? state.kinshipState.byPersonId[personId] || null : null;
  }

  function kinshipKey(result) {
    if (!result) return "outside";
    if ((result.category === "blood" || result.category === "adoptive") && result.degree >= 1 && result.degree <= 6) return "degree-" + result.degree;
    if (result.category === "self") return "self";
    if (result.category === "spouse") return "spouse";
    if (result.category === "affinity") return "affinity";
    return "outside";
  }

  function kinshipCategoryLabel(result) {
    if (!result) return "未判定";
    return { self: "基準人物", spouse: "配偶者", blood: "血族", adoptive: "養親族", affinity: "姻族", step: "継親等", formerSpouse: "元配偶者", unrelated: "親等外", unknown: "未判定" }[result.category] || "未判定";
  }

  function kinshipDisplayParts(result) {
    const mode = state.settings && state.settings.kinshipDisplayMode || "both";
    return {
      badge: mode === "label" || mode === "none" ? "" : (result ? result.displayDegree : "未判定"),
      relationship: mode === "degree" || mode === "none" ? "" : (result ? result.relationshipLabel : "関係未判定")
    };
  }

  function kinshipBackgroundClass(result, person) {
    const classes = [];
    if (person && person.isDeceased) classes.push("person-card--deceased");
    const mode = state.settings && state.settings.kinshipDisplayMode || "both";
    if (mode === "none" || !result) return classes.join(" ");
    const degree = Number(result.degree);
    const isDirectKinship = (result.category === "blood" || result.category === "adoptive") && degree >= 1 && degree <= 6;
    const isAffinityKinship = result.category === "affinity" && degree >= 1 && degree <= 3;
    if (isDirectKinship || isAffinityKinship) classes.push("person-card--kinship-" + degree);
    return classes.join(" ");
  }

  function personKana(person) {
    return ((person.familyNameKana || "") + " " + (person.givenNameKana || "")).trim();
  }

  function createTreeNode(node, person, cardWidth, cardHeight) {
    const kinship = kinshipFor(person.id);
    const kinshipParts = kinshipDisplayParts(kinship);
    const categoryKey = kinshipKey(kinship);
    const backgroundClass = kinshipBackgroundClass(kinship, person);
    const statusWords = [person.verificationStatus && person.verificationStatus !== "confirmed" ? verificationLabel(person.verificationStatus) : ""].filter(Boolean);
    const accessible = kinship && kinship.category === "self"
      ? [fullName(person), "基準人物", person.isDeceased ? "故人" : ""].filter(Boolean).join("、")
      : [fullName(person), kinship ? "基準人物から見て" + kinship.displayDegree : "親等未判定", kinship && kinship.relationshipLabel, person.isDeceased ? "故人" : ""].filter(Boolean).join("、");
    const group = svgElement("g", {
      class: "tree-node" + (backgroundClass ? " " + backgroundClass : "") + (node.isFocus ? " is-focus" : "") + (node.hasGenerationConflict ? " has-generation-conflict" : ""),
      transform: "translate(" + node.x + " " + node.y + ")", tabindex: "0", role: "button",
      "aria-label": accessible, "data-person-id": person.id,
      "data-generation": node.relativeGeneration === null ? "unknown" : node.relativeGeneration,
      "data-sibling-group-id": node.siblingGroupId || "",
      "data-kinship-key": categoryKey,
      "data-kinship-category": kinship ? kinship.category : "unknown",
      "data-kinship-degree": kinship && kinship.degree !== null ? kinship.degree : ""
    });
    group.appendChild(svgElement("title", {})).textContent = accessible + "、" + lifeYears(person);
    group.appendChild(svgElement("rect", { class: "tree-node-card", width: cardWidth, height: cardHeight, rx: 18, ry: 18 }));
    const photoX = 31;
    const photoY = 57;
    group.appendChild(svgElement("circle", { class: "tree-node-photo-bg", cx: photoX, cy: photoY, r: 21 }));
    if (person.photo) {
      const clipId = "photo-" + person.id.replace(/[^a-zA-Z0-9_-]/g, "");
      const clipPath = svgElement("clipPath", { id: clipId });
      clipPath.appendChild(svgElement("circle", { cx: photoX, cy: photoY, r: 21 }));
      group.appendChild(clipPath);
      const image = svgElement("image", { x: photoX - 21, y: photoY - 21, width: 42, height: 42, preserveAspectRatio: "xMidYMid slice", "clip-path": "url(#" + clipId + ")" });
      image.setAttribute("href", person.photo);
      group.appendChild(image);
    } else {
      const initial = svgElement("text", { class: "tree-node-initial", x: photoX, y: photoY });
      initial.textContent = initialOf(person);
      group.appendChild(initial);
    }
    const contentX = 119;
    const name = svgElement("text", { class: "tree-node-name", x: contentX, y: 38 });
    name.textContent = compactText(fullName(person), 9);
    group.appendChild(name);
    const nameNotes = [personKana(person), person.formerFamilyName ? "旧姓 " + person.formerFamilyName : ""].filter(Boolean).join("・");
    if (nameNotes) {
      const notes = svgElement("text", { class: "tree-node-kana", x: contentX, y: 56 });
      notes.textContent = compactText(nameNotes, 13);
      group.appendChild(notes);
    }
    if (kinshipParts.relationship) {
      const relationship = svgElement("text", { class: "tree-node-kinship-label", x: contentX, y: 78 });
      relationship.textContent = compactText(kinshipParts.relationship, 13);
      group.appendChild(relationship);
    }
    const years = svgElement("text", { class: "tree-node-years", x: contentX, y: 99 });
    years.textContent = lifeYears(person);
    group.appendChild(years);
    if (statusWords.length) {
      const status = svgElement("text", { class: "tree-node-status", x: contentX, y: 116 });
      status.textContent = compactText(statusWords.join("・"), 15);
      group.appendChild(status);
    }
    if (person.isDeceased) {
      group.appendChild(svgElement("rect", { class: "tree-node-deceased", x: cardWidth - 41, y: 9, width: 31, height: 18, rx: 8 }));
      const label = svgElement("text", { class: "tree-node-deceased-text", x: cardWidth - 25.5, y: 21.5 });
      label.textContent = "故人";
      group.appendChild(label);
    }
    const badgeText = node.isFocus ? "基準人物" : kinshipParts.badge;
    if (badgeText) {
      const badgeWidth = Math.min(82, Math.max(42, Array.from(badgeText).length * 9 + 12));
      group.appendChild(svgElement("rect", { class: "tree-node-kinship-badge is-" + categoryKey, x: 7, y: 7, width: badgeWidth, height: 20, rx: 9 }));
      const badge = svgElement("text", { class: "tree-node-kinship-badge-text is-" + categoryKey, x: 7 + badgeWidth / 2, y: 21 });
      badge.textContent = badgeText;
      group.appendChild(badge);
    }
    if (person.verificationStatus && person.verificationStatus !== "confirmed") {
      group.appendChild(svgElement("circle", { class: "tree-node-verification", cx: cardWidth - 14, cy: cardHeight - 14, r: 7 }));
      const verify = svgElement("text", { class: "tree-node-verification-text", x: cardWidth - 14, y: cardHeight - 11.5 });
      verify.textContent = person.verificationStatus === "disputed" ? "!" : "?";
      group.appendChild(verify);
    }
    return group;
  }

  function traverseRelations(startId, direction) {
    const ids = new Set(startId ? [startId] : []);
    const queue = startId ? [startId] : [];
    while (queue.length) {
      const current = queue.shift();
      state.relationships.forEach(function (relationship) {
        if (relationship.type !== "parent-child") return;
        let next = "";
        if (direction !== "down" && relationship.toPersonId === current) next = relationship.fromPersonId;
        if (direction !== "up" && relationship.fromPersonId === current) next = relationship.toPersonId;
        if (next && !ids.has(next)) { ids.add(next); queue.push(next); }
      });
    }
    return ids;
  }

  function addPartnersToSet(ids) {
    const result = new Set(ids);
    state.relationships.forEach(function (relationship) {
      if (relationship.type !== "partner") return;
      if (ids.has(relationship.fromPersonId)) result.add(relationship.toPersonId);
      if (ids.has(relationship.toPersonId)) result.add(relationship.fromPersonId);
    });
    return result;
  }

  function breadthFirstIds(startId, includePartners, maxDepth, parentOnly) {
    const distance = new Map();
    if (!startId) return distance;
    distance.set(startId, 0);
    const queue = [startId];
    while (queue.length) {
      const current = queue.shift();
      const currentDistance = distance.get(current);
      if (currentDistance >= maxDepth) continue;
      state.relationships.forEach(function (relationship) {
        if (parentOnly && relationship.type !== "parent-child") return;
        if (!includePartners && relationship.type === "partner") return;
        let next = "";
        if (relationship.fromPersonId === current) next = relationship.toPersonId;
        else if (relationship.toPersonId === current) next = relationship.fromPersonId;
        if (next && !distance.has(next)) { distance.set(next, currentDistance + 1); queue.push(next); }
      });
    }
    return distance;
  }

  function resolveFocusPersonId(persons, relationships) {
    const ids = new Set(persons.map(function (person) { return person.id; }));
    if (state.settings && ids.has(state.settings.focusPersonId)) return state.settings.focusPersonId;
    if (state.currentTree && ids.has(state.currentTree.rootPersonId)) return state.currentTree.rootPersonId;
    const degree = new Map(persons.map(function (person) { return [person.id, 0]; }));
    relationships.forEach(function (relationship) {
      if (degree.has(relationship.fromPersonId)) degree.set(relationship.fromPersonId, degree.get(relationship.fromPersonId) + 1);
      if (degree.has(relationship.toPersonId)) degree.set(relationship.toPersonId, degree.get(relationship.toPersonId) + 1);
    });
    const ordered = persons.slice().sort(function (first, second) {
      return (degree.get(second.id) || 0) - (degree.get(first.id) || 0) ||
        String(first.createdAt || "").localeCompare(String(second.createdAt || "")) ||
        String(first.id).localeCompare(String(second.id));
    });
    return ordered[0] ? ordered[0].id : "";
  }

  function getTreeViewData(forceAll) {
    const focusId = resolveFocusPersonId(state.persons, state.relationships);
    const mode = forceAll ? "all" : state.settings.treeViewMode;
    let ids;
    if (mode === "all" || !focusId) ids = new Set(state.persons.map(function (person) { return person.id; }));
    else if (mode === "ancestors") ids = traverseRelations(focusId, "up");
    else if (mode === "descendants") ids = traverseRelations(focusId, "down");
    else if (mode === "direct" || mode === "lineage") {
      const ancestors = traverseRelations(focusId, "up");
      const descendants = traverseRelations(focusId, "down");
      ids = new Set(Array.from(ancestors).concat(Array.from(descendants)));
    } else if (mode === "blood") ids = new Set(breadthFirstIds(focusId, false, Number.MAX_SAFE_INTEGER, true).keys());
    else {
      const depth = state.settings.kinshipDepth === "unlimited" ? Number.MAX_SAFE_INTEGER : Number(state.settings.kinshipDepth || 1);
      ids = new Set(breadthFirstIds(focusId, state.settings.includePartners, depth, false).keys());
    }
    if (!forceAll && state.settings.includePartners && mode !== "all" && mode !== "kinship" && mode !== "direct") ids = addPartnersToSet(ids);
    const persons = state.persons.filter(function (person) { return ids.has(person.id); });
    const relationships = state.relationships.filter(function (relationship) { return ids.has(relationship.fromPersonId) && ids.has(relationship.toPersonId); });
    return { persons: persons, relationships: relationships, focusPersonId: focusId };
  }

  function generationLabel(relative) {
    if (relative === 3) return "+3　曽祖父母世代";
    if (relative === 2) return "+2　祖父母世代";
    if (relative === 1) return "+1　親世代";
    if (relative === 0) return "基準人物と同世代";
    if (relative === -1) return "-1　子世代";
    if (relative === -2) return "-2　孫世代";
    if (relative === -3) return "-3　曾孫世代";
    return (relative > 0 ? "+" : "") + relative + "　" + Math.abs(relative) + "世代" + (relative > 0 ? "上" : "下");
  }

  function appendGenerationLabels(fragment, layout) {
    if (!layout || !layout.nodes.length) return;
    const generations = new Map();
    layout.nodes.forEach(function (node) {
      if (node.disconnected) return;
      if (!generations.has(node.generation)) generations.set(node.generation, node.y);
      else generations.set(node.generation, Math.min(generations.get(node.generation), node.y));
    });
    Array.from(generations.keys()).sort(function (a, b) { return b - a; }).forEach(function (generation) {
      const label = svgElement("text", { class: "tree-generation-label", x: layout.bounds.x + 14, y: generations.get(generation) - 17 });
      label.textContent = generationLabel(generation);
      fragment.appendChild(label);
    });
  }

  function refreshLayoutBounds(layout) {
    if (!layout.nodes.length) return;
    const paddingX = 120;
    const paddingY = 80;
    const segments = (layout.routes || []).reduce(function (all, route) { return all.concat(route.segments || []); }, []);
    const routeXs = segments.reduce(function (all, segment) { return all.concat([segment.x1, segment.x2]); }, []);
    const routeYs = segments.reduce(function (all, segment) { return all.concat([segment.y1, segment.y2]); }, []);
    const minX = Math.min.apply(null, layout.nodes.map(function (node) { return node.x; }).concat(routeXs)) - paddingX;
    const minY = Math.min.apply(null, layout.nodes.map(function (node) { return node.y; }).concat(routeYs)) - paddingY;
    const maxX = Math.max.apply(null, layout.nodes.map(function (node) { return node.x + layout.cardWidth; }).concat(routeXs)) + paddingX;
    const maxY = Math.max.apply(null, layout.nodes.map(function (node) { return node.y + layout.cardHeight; }).concat(routeYs)) + paddingY;
    layout.bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    layout.viewBoxExpansion = {
      left: paddingX, right: paddingX, top: paddingY, bottom: paddingY,
      x: minX, y: minY, width: maxX - minX, height: maxY - minY,
      strategy: "expand-without-coordinate-compaction"
    };
    if (layout.directSpine) layout.directSpine.viewBoxExpansion = layout.viewBoxExpansion;
    const disconnected = layout.nodes.filter(function (node) { return node.disconnected; });
    layout.disconnectedStartY = disconnected.length ? Math.min.apply(null, disconnected.map(function (node) { return node.y; })) - 40 : 0;
  }

  function createTreeScene(persons, relationships, showGenerationLabels) {
    const focusPersonId = resolveFocusPersonId(persons, relationships);
    const layout = Layout.compute(persons, relationships, focusPersonId, { rootPersonId: state.currentTree && state.currentTree.rootPersonId || "" });
    const nodeMap = new Map(layout.nodes.map(function (node) { return [node.id, node]; }));
    const personMap = new Map(persons.map(function (person) { return [person.id, person]; }));
    const fragment = document.createDocumentFragment();
    const routing = renderConnections(fragment, layout, persons, relationships);
    refreshLayoutBounds(layout);
    layout.routingDiagnostics = routing.diagnostics;
    layout.routingCrossings = routing.crossings;
    layout.routingCorridors = routing.corridors;
    if (showGenerationLabels) appendGenerationLabels(fragment, layout);
    if (layout.disconnectedStartY) {
      const y = layout.disconnectedStartY;
      addPath(fragment, "M " + (layout.bounds.x + 25) + " " + y + " H " + (layout.bounds.x + layout.bounds.width - 25), "tree-link tree-disconnected-divider");
      const label = svgElement("text", { class: "tree-disconnected-label", x: layout.bounds.x + 32, y: y - 10 });
      label.textContent = "基準人物との世代未確定";
      fragment.appendChild(label);
    }
    layout.nodes.forEach(function (node) { const person = personMap.get(node.id); if (person) fragment.appendChild(createTreeNode(node, person, layout.cardWidth, layout.cardHeight)); });
    return { layout: layout, fragment: fragment };
  }

  function updateTreeSelectionHighlight() {
    if (!elements.treeViewport) return;
    let selectedFamilyKey = state.selectedFamilyKey;
    if (selectedFamilyKey && !Array.from(elements.treeViewport.querySelectorAll(".tree-family-unit")).some(function (group) { return group.dataset.familyKey === selectedFamilyKey; })) {
      selectedFamilyKey = "";
      state.selectedFamilyKey = "";
    }
    const selectedPersonId = selectedFamilyKey ? "" : state.selectedPersonId;
    const selectedMemberIds = new Set();
    elements.treeViewport.querySelectorAll(".tree-family-unit").forEach(function (group) {
      const parentIds = (group.dataset.parentIds || "").split(/\s+/).filter(Boolean);
      const childIds = (group.dataset.childIds || "").split(/\s+/).filter(Boolean);
      const familySelected = selectedFamilyKey ? group.dataset.familyKey === selectedFamilyKey : Boolean(selectedPersonId && parentIds.concat(childIds).includes(selectedPersonId));
      group.classList.toggle("is-selected-family", familySelected);
      group.classList.toggle("is-dimmed", Boolean((selectedFamilyKey || selectedPersonId) && !familySelected));
      if (familySelected) parentIds.concat(childIds).forEach(function (id) { selectedMemberIds.add(id); });
    });
    elements.treeViewport.querySelectorAll(".tree-node").forEach(function (node) {
      node.classList.toggle("is-selected-person", Boolean(selectedPersonId && node.dataset.personId === selectedPersonId));
      node.classList.toggle("is-family-member", selectedMemberIds.has(node.dataset.personId));
    });
    elements.treeViewport.querySelectorAll(".tree-crossing-marker").forEach(function (marker) {
      const involved = [marker.dataset.horizontalFamilyKey, marker.dataset.verticalFamilyKey];
      marker.classList.toggle("is-dimmed", Boolean(selectedFamilyKey && !involved.includes(selectedFamilyKey)));
    });
    applyKinshipHighlight();
  }

  function kinshipMatchesFilter(result, filter) {
    if (filter === "all") return true;
    if (!result) return filter === "outside";
    if (/^degree-[1-6]$/.test(filter)) return kinshipKey(result) === filter;
    if (filter === "spouse") return result.category === "spouse";
    if (filter === "affinity") return result.category === "affinity";
    return filter === "outside" && kinshipKey(result) === "outside";
  }

  function applyKinshipHighlight() {
    if (!elements.treeViewport) return;
    const filter = state.kinshipFilter || "all";
    elements.treeViewport.querySelectorAll(".tree-node").forEach(function (node) {
      node.classList.toggle("is-kinship-dimmed", !kinshipMatchesFilter(kinshipFor(node.dataset.personId), filter));
    });
    elements.treeViewport.querySelectorAll(".tree-family-unit").forEach(function (group) {
      const memberIds = (group.dataset.parentIds + " " + group.dataset.childIds).trim().split(/\s+/).filter(Boolean);
      const matches = filter === "all" || memberIds.some(function (id) { return kinshipMatchesFilter(kinshipFor(id), filter); });
      group.classList.toggle("is-kinship-dimmed", !matches);
    });
  }

  function renderKinshipSummary(visibleCount) {
    if (!elements.kinshipSummary || !state.kinshipState) return;
    const focus = findPerson(state.kinshipState.focusPersonId);
    const summary = state.kinshipState.summary;
    elements.kinshipSummary.innerHTML =
      "<strong>基準人物：" + escapeHtml(fullName(focus)) + "</strong>" +
      "<span>親等表示：1～6親等</span><span>表示人数：" + visibleCount + "人</span>" +
      "<span>6親等以内：" + summary.withinSix + "人</span><span>配偶者：" + summary.spouse + "人</span>" +
      "<span>姻族：" + summary.affinity + "人</span><span>親等外・未判定：" + summary.outsideOrUnknown + "人</span>";
  }

  function viewModeLabel() {
    return { all: "全員", direct: "直系のみ", ancestors: "祖先のみ", descendants: "子孫のみ", lineage: "祖先と子孫", blood: "血縁者中心", kinship: (state.settings.kinshipDepth === "unlimited" ? "親等制限なし" : state.settings.kinshipDepth + "親等以内") }[state.settings.treeViewMode] || "全員";
  }

  function renderTree() {
    elements.treeLoading.hidden = true;
    elements.treeError.hidden = true;
    elements.treeViewport.replaceChildren();
    const view = getTreeViewData(false);
    calculateCurrentKinship(view.focusPersonId);
    state.visiblePersons = view.persons;
    state.visibleRelationships = view.relationships;
    elements.viewSummary.textContent = viewModeLabel() + "・" + view.persons.length + "人";
    renderKinshipSummary(view.persons.length);
    if (elements.kinshipLegend && !elements.kinshipLegend.dataset.initialized) {
      elements.kinshipLegend.open = globalThis.matchMedia && globalThis.matchMedia("(min-width: 841px)").matches;
      elements.kinshipLegend.dataset.initialized = "true";
    }
    if (!view.persons.length) { state.layout = null; elements.treeEmpty.hidden = false; return; }
    elements.treeEmpty.hidden = true;
    const scene = createTreeScene(view.persons, view.relationships, state.settings.showGenerationLabels);
    state.layout = scene.layout;
    elements.treeViewport.appendChild(scene.fragment);
    elements.treeViewport.setAttribute("data-routing-issue-count", String(scene.layout.routingDiagnostics.issues.length));
    elements.treeViewport.setAttribute("data-routing-error-count", String(scene.layout.routingDiagnostics.errorCount));
    elements.treeViewport.setAttribute("data-routing-crossing-count", String(scene.layout.routingDiagnostics.crossingCount));
    globalThis.__familyTreeDiagnostics = scene.layout.routingDiagnostics;
    globalThis.__generationDiagnostics = scene.layout.generationDiagnostics || [];
    globalThis.__familyTreeLayoutState = {
      focusPersonId: scene.layout.focusPersonId,
      personGenerations: Object.assign({}, scene.layout.personGenerations),
      generationLayers: scene.layout.generationLayers,
      familyBlocks: scene.layout.familyBlocks,
      familySubtrees: scene.layout.familySubtrees || [],
      unionNodes: scene.layout.unionNodes || [],
      coupleBlocks: (scene.layout.coupleBlocks || []).map(function (block) {
        return {
          id: block.id, unionNodeId: block.unionNodeId, leftPersonId: block.leftPersonId, rightPersonId: block.rightPersonId,
          relationshipId: block.relationshipId, relationshipType: block.relationshipType, status: block.status,
          generation: block.generation, centerX: block.centerX, minX: block.minX, maxX: block.maxX,
          childIds: block.childIds.slice(), adjacent: block.adjacent
        };
      }),
      directSpine: scene.layout.directSpine ? {
        focusPersonId: scene.layout.directSpine.focusPersonId,
        spineX: scene.layout.directSpine.spineX,
        focusGeneration: scene.layout.directSpine.focusGeneration,
        directAncestorIds: scene.layout.directSpine.directAncestorIds.slice(),
        directDescendantIds: scene.layout.directSpine.directDescendantIds.slice(),
        directPersonIds: scene.layout.directSpine.directPersonIds.slice(),
        directUnionNodeIds: scene.layout.directSpine.directUnionNodeIds.slice(),
        directConnections: scene.layout.directSpine.directConnections.map(function (connection) { return Object.assign({}, connection); }),
        directLineageRails: (scene.layout.directSpine.directLineageRails || []).map(function (rail) { return Object.assign({}, rail); }),
        spineExclusionZones: (scene.layout.directSpine.spineExclusionZones || []).map(function (zone) { return Object.assign({}, zone); }),
        lockedUnionNodeIds: (scene.layout.directSpine.lockedUnionNodeIds || []).slice(),
        lockedPersonIds: (scene.layout.directSpine.lockedPersonIds || []).slice(),
        compactionMoves: (scene.layout.directSpine.compactionMoves || []).map(function (move) { return Object.assign({}, move); }),
        familyBranchAlignments: (scene.layout.directSpine.familyBranchAlignments || []).map(function (alignment) { return Object.assign({}, alignment, { parentIds: alignment.parentIds.slice(), childIds: alignment.childIds.slice() }); }),
        viewBoxExpansion: scene.layout.directSpine.viewBoxExpansion ? Object.assign({}, scene.layout.directSpine.viewBoxExpansion) : null,
        initialViewportTarget: scene.layout.directSpine.initialViewportTarget ? Object.assign({}, scene.layout.directSpine.initialViewportTarget) : null,
        collateralAtomIds: scene.layout.directSpine.collateralAtomIds.slice(),
        bounds: scene.layout.directSpine.bounds ? Object.assign({}, scene.layout.directSpine.bounds) : null
      } : null,
      directLineageRails: (scene.layout.directLineageRails || []).map(function (rail) { return Object.assign({}, rail); }),
      spineExclusionZones: (scene.layout.spineExclusionZones || []).map(function (zone) { return Object.assign({}, zone); }),
      lockedUnionNodeIds: (scene.layout.lockedUnionNodeIds || []).slice(),
      lockedPersonIds: (scene.layout.lockedPersonIds || []).slice(),
      compactionMoves: (scene.layout.compactionMoves || []).map(function (move) { return Object.assign({}, move); }),
      familyBranchAlignments: (scene.layout.familyBranchAlignments || []).map(function (alignment) { return Object.assign({}, alignment, { parentIds: alignment.parentIds.slice(), childIds: alignment.childIds.slice() }); }),
      viewBoxExpansion: scene.layout.viewBoxExpansion ? Object.assign({}, scene.layout.viewBoxExpansion) : null,
      initialViewportTarget: scene.layout.initialViewportTarget ? Object.assign({}, scene.layout.initialViewportTarget) : null,
      siblingGroups: scene.layout.siblingGroups,
      corridors: scene.layout.routingCorridors || [],
      trackGroups: scene.layout.trackGroups || [],
      personPorts: scene.layout.personPorts || {},
      performance: scene.layout.performance || {},
      routes: (scene.layout.routes || []).map(function (route) {
        return {
          familyKey: route.familyKey, familySubtreeId: route.familySubtreeId, unionNodeId: route.unionNodeId, routeId: route.routeId, parentIds: route.parentIds,
          childIds: route.children.map(function (child) { return child.id; }), parentGeneration: route.parentGeneration,
          childGeneration: route.childGeneration, corridorId: route.corridorId, trackGroupId: route.trackGroupId, trackIndex: route.trackIndex,
          relationshipType: route.relationshipType, generationConflict: route.generationConflict,
          coupleBlockId: route.coupleBlockId || "", partnerPorts: route.partnerPorts || null,
          partnerLinePaths: (route.partnerLinePaths || []).slice()
        };
      }),
      disconnectedComponents: scene.layout.disconnectedComponents || [],
      kinshipState: state.kinshipState ? {
        focusPersonId: state.kinshipState.focusPersonId,
        calculatedAt: state.kinshipState.calculatedAt,
        persons: state.kinshipState.persons.map(function (item) {
          return {
            personId: item.personId, degree: item.degree, category: item.category, relationshipLabel: item.relationshipLabel,
            branch: item.branch, lineageType: item.lineageType, pathPersonIds: item.pathPersonIds.slice(),
            pathRelationshipIds: item.pathRelationshipIds.slice(), isWithinLegalRange: item.isWithinLegalRange, warnings: item.warnings.slice()
          };
        }),
        summary: Object.assign({}, state.kinshipState.summary, { degrees: Object.assign({}, state.kinshipState.summary.degrees) }),
        warnings: state.kinshipState.warnings.slice(), ambiguousPaths: state.kinshipState.ambiguousPaths.slice(),
        performanceMs: state.kinshipState.performanceMs
      } : null
    };
    if (globalThis.FAMILY_TREE_DEBUG === true) console.debug("家系図レイアウト診断", globalThis.__familyTreeLayoutState, globalThis.__familyTreeDiagnostics);
    updateTreeSelectionHighlight();
    applyTransform();
  }

  function applyTransform() {
    elements.treeViewport.setAttribute("transform", "translate(" + state.transform.x + " " + state.transform.y + ") scale(" + state.transform.scale + ")");
  }

  function centerTree(options) {
    if (!state.layout || !state.layout.bounds.width) return;
    const rect = elements.treeStage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const focusNode = state.layout.nodes.find(function (node) { return node.id === state.layout.focusPersonId; });
    const target = state.layout.initialViewportTarget || state.layout.directSpine && state.layout.directSpine.initialViewportTarget || null;
    const centerX = target && Number.isFinite(target.centerX) ? target.centerX : (focusNode ? focusNode.x + state.layout.cardWidth / 2 : state.layout.bounds.x + state.layout.bounds.width / 2);
    const centerY = target && Number.isFinite(target.centerY) ? target.centerY : (focusNode ? focusNode.y + state.layout.cardHeight / 2 : state.layout.bounds.y + state.layout.bounds.height / 2);
    const preserveScale = Boolean(options && options.preserveScale);
    const currentScale = Number(state.transform.scale) || 1;
    const scale = preserveScale ? Math.max(0.25, Math.min(2.5, currentScale)) : Math.max(0.65, Math.min(1, currentScale));
    const focusViewportY = rect.height * 0.56;
    state.transform.scale = scale;
    state.transform.x = rect.width / 2 - centerX * scale;
    state.transform.y = focusViewportY - centerY * scale - 10;
    applyTransform();
    scheduleScaleSave();
  }

  function fitWholeTree() {
    if (!state.layout || !state.layout.bounds.width) return;
    const rect = elements.treeStage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const bounds = state.layout.bounds;
    const scale = Math.max(0.18, Math.min(1.1, Math.min(rect.width / bounds.width, (rect.height - 40) / bounds.height) * 0.92));
    state.transform.scale = scale;
    state.transform.x = rect.width / 2 - (bounds.x + bounds.width / 2) * scale;
    state.transform.y = rect.height / 2 - (bounds.y + bounds.height / 2) * scale;
    applyTransform();
    scheduleScaleSave();
  }

  function resetTreeScale() {
    state.transform.scale = 1;
    centerTree({ preserveScale: true });
  }

  function revealPerson(personId) {
    if (!state.layout) return;
    const node = state.layout.nodes.find(function (item) { return item.id === personId; });
    if (!node) return;
    const rect = elements.treeStage.getBoundingClientRect();
    const scale = state.transform.scale;
    state.transform.x = rect.width / 2 - (node.x + state.layout.cardWidth / 2) * scale;
    state.transform.y = rect.height / 2 - (node.y + state.layout.cardHeight / 2) * scale;
    applyTransform();
  }

  function scheduleScaleSave() {
    clearTimeout(state.saveScaleTimer);
    state.saveScaleTimer = setTimeout(function () {
      if (!state.settings) return;
      state.settings.scale = state.transform.scale;
      DB.saveSettings({ scale: state.transform.scale }).catch(function () { showToast("表示倍率を保存できませんでした。", true); });
    }, 500);
  }

  function zoomAt(nextScale, clientX, clientY) {
    const rect = elements.treeSvg.getBoundingClientRect();
    const x = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const y = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    const oldScale = state.transform.scale;
    const scale = Math.max(0.25, Math.min(2.5, nextScale));
    state.transform.x = x - (x - state.transform.x) * (scale / oldScale);
    state.transform.y = y - (y - state.transform.y) * (scale / oldScale);
    state.transform.scale = scale;
    applyTransform();
    scheduleScaleSave();
  }

  function openDetail(personId) {
    if (!findPerson(personId)) return;
    state.selectedFamilyKey = "";
    state.selectedPersonId = personId;
    updateTreeSelectionHighlight();
    renderDetail();
    elements.detailPanel.classList.add("is-open");
    elements.detailPanel.setAttribute("aria-hidden", "false");
    if (matchMedia("(max-width: 840px)").matches) elements.detailBackdrop.hidden = false;
  }

  function closeDetail() {
    state.selectedPersonId = "";
    updateTreeSelectionHighlight();
    elements.detailPanel.classList.remove("is-open");
    elements.detailPanel.setAttribute("aria-hidden", "true");
    elements.detailBackdrop.hidden = true;
  }

  function compareRelativeItems(a, b) {
    const orderA = Number.isFinite(Number(a.relationship.sortOrder)) ? Number(a.relationship.sortOrder) : Number.MAX_SAFE_INTEGER;
    const orderB = Number.isFinite(Number(b.relationship.sortOrder)) ? Number(b.relationship.sortOrder) : Number.MAX_SAFE_INTEGER;
    return orderA - orderB || Layout.comparePeople(a.person, b.person);
  }

  function getRelativeGroups(personId) {
    const groups = { parents: [], partners: [], children: [] };
    state.relationships.forEach(function (relationship) {
      if (relationship.type === "parent-child" && relationship.toPersonId === personId) {
        const person = findPerson(relationship.fromPersonId);
        if (person) groups.parents.push({ person: person, relationship: relationship });
      } else if (relationship.type === "parent-child" && relationship.fromPersonId === personId) {
        const person = findPerson(relationship.toPersonId);
        if (person) groups.children.push({ person: person, relationship: relationship });
      } else if (relationship.type === "partner" && (relationship.fromPersonId === personId || relationship.toPersonId === personId)) {
        const relativeId = relationship.fromPersonId === personId ? relationship.toPersonId : relationship.fromPersonId;
        const person = findPerson(relativeId);
        if (person) groups.partners.push({ person: person, relationship: relationship });
      }
    });
    groups.parents.sort(function (a, b) { return Layout.comparePeople(a.person, b.person); });
    groups.partners.sort(compareRelativeItems);
    groups.children.sort(compareRelativeItems);
    return groups;
  }

  function relationSummary(item, group) {
    if (group === "partners") {
      let text = relationLabel(item.relationship.relationshipType) + "・" + statusLabel(item.relationship.status, item.relationship.relationshipType);
      if (item.relationship.startDate || item.relationship.endDate) {
        text += "（" + (yearFromDate(item.relationship.startDate) || "?") + "〜" + (yearFromDate(item.relationship.endDate) || "") + "）";
      }
      return text;
    }
    return childRelationLabel(item.relationship.relationshipType);
  }

  function relativeRows(items, group) {
    if (!items.length) return "<p class=\"empty-relative\">登録されていません</p>";
    return "<div class=\"relative-list\">" + items.map(function (item) {
      return "<div class=\"relative-row\">" +
        "<button class=\"relative-person\" type=\"button\" data-open-person=\"" + escapeHtml(item.person.id) + "\">" +
        avatarHtml(item.person) + "<span><strong>" + escapeHtml(fullName(item.person)) + "</strong><small>" + escapeHtml(relationSummary(item, group)) + "</small></span></button>" +
        "<button class=\"relative-menu-button\" type=\"button\" data-relationship-menu=\"" + escapeHtml(item.relationship.id) + "\" data-relative-id=\"" + escapeHtml(item.person.id) + "\" data-group=\"" + group + "\" aria-label=\"" + escapeHtml(fullName(item.person)) + "との関係メニュー\">⋮</button></div>";
    }).join("") + "</div>" + ((group === "children" || group === "partners") && items.length > 1 ? "<p class=\"relation-order-note\">メニューから表示順を変更できます。</p>" : "");
  }

  function kinshipPathHtml(result) {
    if (!result) return "<p class=\"empty-relative\">基準人物からの関係を判定できません。</p>";
    const branch = { paternal: "父方", maternal: "母方", descendant: "子孫", sibling: "兄弟姉妹", spouseSide: "配偶者側", mixed: "複合経路", unknown: "" }[result.branch] || "";
    const lineage = { biological: "血族", adoptive: "養親族", mixed: "血族・養親族の混合", affinity: "姻族", step: "継親等", unknown: "未判定" }[result.lineageType] || "未判定";
    const path = result.pathPersonIds.map(function (personId, index) {
      const person = findPerson(personId);
      const relation = index ? (result.pathLabels[index - 1] || "関係") + "：" : "";
      return "<li><span>" + escapeHtml(relation) + "</span><button type=\"button\" data-open-person=\"" + escapeHtml(personId) + "\">" + escapeHtml(fullName(person)) + "</button></li>";
    }).join("");
    const warnings = result.warnings.length ? "<div class=\"kinship-path-warning\"><strong>判定上の注意</strong><ul>" + result.warnings.map(function (warning) { return "<li>" + escapeHtml(warning) + "</li>"; }).join("") + "</ul></div>" : "";
    return "<div class=\"kinship-detail-summary\"><span class=\"kinship-detail-degree\">" + escapeHtml(result.displayDegree) + "</span><strong>" + escapeHtml(result.relationshipLabel) + "</strong>" +
      "<small>" + escapeHtml([lineage, branch].filter(Boolean).join("・")) + "</small></div>" +
      "<ol class=\"kinship-path-list\">" + path + "</ol>" + warnings;
  }

  function renderDetail() {
    const person = findPerson(state.selectedPersonId);
    if (!person) return;
    const groups = getRelativeGroups(person.id);
    const formerName = person.formerFamilyName ? "旧姓：" + person.formerFamilyName : "";
    const nameExtras = [person.nickname ? "通称：" + person.nickname : "", person.otherNames ? "別名：" + person.otherNames : "", person.honorific ? "敬称・補足：" + person.honorific : "", person.nameMemo ? "名前の補足：" + person.nameMemo : ""].filter(Boolean);
    const focusChip = person.id === resolveFocusPersonId(state.persons, state.relationships) ? "<span class=\"focus-chip\">基準人物</span>" : "";
    const verificationChip = "<span class=\"verification-chip is-" + escapeHtml(person.verificationStatus || "unconfirmed") + "\">" + escapeHtml(verificationLabel(person.verificationStatus)) + "</span>";
    elements.detailContent.dataset.personId = person.id;
    elements.detailContent.innerHTML =
      "<div class=\"detail-inner\"><div class=\"detail-topbar\"><button class=\"text-button\" type=\"button\" data-set-focus>基準人物にする</button><button class=\"icon-button\" type=\"button\" data-close-detail aria-label=\"詳細を閉じる\">×</button></div>" +
      "<section class=\"detail-hero\">" + avatarHtml(person, "detail-photo") + "<h2>" + escapeHtml(fullName(person)) + "</h2>" +
      (formerName ? "<p class=\"former-name\">" + escapeHtml(formerName) + "</p>" : "") +
      (person.nickname ? "<p class=\"nickname\">「" + escapeHtml(person.nickname) + "」</p>" : "") +
      (person.isDeceased ? "<span class=\"deceased-chip\">故人</span>" : "") + focusChip + verificationChip + "</section>" +
      "<div class=\"detail-actions\"><button class=\"primary-button add-relative-primary\" type=\"button\" data-add-relative>親族を追加</button><button class=\"secondary-button\" type=\"button\" data-edit-person>人物を編集</button><button class=\"secondary-button\" type=\"button\" data-add-relation>既存人物と関係を追加</button></div>" +
      "<section class=\"detail-section kinship-detail-section\"><h3>基準人物からの関係経路</h3>" + kinshipPathHtml(kinshipFor(person.id)) + "</section>" +
      "<section class=\"detail-section\"><h3>基本情報</h3><dl class=\"detail-list\">" +
      "<div><dt>生年月日</dt><dd>" + escapeHtml(formatPersonDate(person, "birth", "生年不明")) + "</dd></div>" +
      (person.isDeceased || person.deathDate ? "<div><dt>没年月日</dt><dd>" + escapeHtml(formatPersonDate(person, "death", "没年不明")) + "</dd></div>" : "") +
      (nameExtras.length ? "<div><dt>別名など</dt><dd>" + escapeHtml(nameExtras.join("\n")) + "</dd></div>" : "") +
      "<div><dt>出身地</dt><dd>" + escapeHtml(person.birthplace || "未登録") + "</dd></div><div><dt>メモ</dt><dd>" + escapeHtml(person.memo || "未登録") + "</dd></div></dl></section>" +
      "<section class=\"detail-section\"><h3>親</h3>" + relativeRows(groups.parents, "parents") + "</section>" +
      "<section class=\"detail-section\"><h3>配偶者・パートナー</h3>" + relativeRows(groups.partners, "partners") + "</section>" +
      "<section class=\"detail-section\"><h3>子ども</h3>" + relativeRows(groups.children, "children") + "</section>" +
      "<section class=\"detail-section\"><button class=\"danger-button delete-person\" type=\"button\" data-delete-person>この人物を削除</button></section></div>";
  }

  function openPersonDialog(person, options) {
    elements.personForm.reset();
    elements.personFormError.hidden = true;
    elements.personDialogTitle.textContent = options && options.title ? options.title : (person ? "人物を編集" : "人物を追加");
    elements.personId.value = person ? person.id : "";
    elements.familyName.value = person ? person.familyName : "";
    elements.givenName.value = person ? person.givenName : "";
    elements.formerFamilyName.value = person ? person.formerFamilyName : "";
    elements.familyNameKana.value = person ? person.familyNameKana : "";
    elements.givenNameKana.value = person ? person.givenNameKana : "";
    elements.nickname.value = person ? person.nickname : "";
    elements.otherNames.value = person ? person.otherNames : "";
    elements.honorific.value = person ? person.honorific : "";
    elements.nameMemo.value = person ? person.nameMemo : "";
    elements.gender.value = person ? person.gender : ((options && options.suggestedGender) || "");
    elements.personVerificationStatus.value = person ? (person.verificationStatus || "unconfirmed") : "unconfirmed";
    elements.isDeceased.checked = Boolean(person && person.isDeceased);
    fillDateEditor("birth", person);
    fillDateEditor("death", person);
    elements.birthplace.value = person ? person.birthplace : "";
    elements.memo.value = person ? person.memo : "";
    state.photoValue = person ? person.photo : "";
    state.photoInfo = null;
    elements.photoCompressionNotice.textContent = "写真は長辺1200px以内へ調整して端末内に保存します。";
    updatePhotoPreview();
    updateDeathDateState();
    elements.personDialog.showModal();
    setTimeout(function () { (person ? elements.familyName : elements.givenName).focus(); }, 30);
  }

  function populateDateSelects() {
    ["birth", "death"].forEach(function (kind) {
      const month = elements[kind + "DateMonth"];
      const day = elements[kind + "DateDay"];
      if (!month.options.length) month.innerHTML = "<option value=\"\">月</option>" + Array.from({ length: 12 }, function (_, index) { return "<option value=\"" + (index + 1) + "\">" + (index + 1) + "月</option>"; }).join("");
      if (!day.options.length) day.innerHTML = "<option value=\"\">日</option>" + Array.from({ length: 31 }, function (_, index) { return "<option value=\"" + (index + 1) + "\">" + (index + 1) + "日</option>"; }).join("");
    });
  }

  function fillDateEditor(kind, person) {
    const value = person ? (person[kind + "Date"] || "") : "";
    const precision = person ? personDatePrecision(person, kind) : "unknown";
    const parts = value.split("-");
    elements[kind + "DatePrecision"].value = precision;
    elements[kind + "DateYear"].value = parts[0] || "";
    elements[kind + "DateMonth"].value = parts[1] ? String(Number(parts[1])) : "";
    elements[kind + "DateDay"].value = parts[2] ? String(Number(parts[2])) : "";
    elements[kind + "DateApproximate"].checked = Boolean(person && person[kind + "DateApproximate"]);
    updateDateEditor(kind);
  }

  function readDateEditor(kind) {
    const precision = elements[kind + "DatePrecision"].value;
    if (precision === "unknown") return { value: "", precision: "unknown", approximate: false };
    const year = String(elements[kind + "DateYear"].value || "").padStart(4, "0");
    if (!/^\d{4}$/.test(year) || Number(year) < 1) throw new Error((kind === "birth" ? "生年" : "没年") + "を入力してください。");
    let value = year;
    if (precision === "month" || precision === "day") {
      const month = Number(elements[kind + "DateMonth"].value);
      if (month < 1 || month > 12) throw new Error((kind === "birth" ? "生年月" : "没年月") + "の月を選んでください。");
      value += "-" + String(month).padStart(2, "0");
    }
    if (precision === "day") {
      const day = Number(elements[kind + "DateDay"].value);
      if (day < 1 || day > 31) throw new Error((kind === "birth" ? "生年月日" : "没年月日") + "の日を選んでください。");
      value += "-" + String(day).padStart(2, "0");
    }
    return { value: value, precision: precision, approximate: elements[kind + "DateApproximate"].checked };
  }

  function updateDateEditor(kind) {
    const precision = elements[kind + "DatePrecision"].value;
    const unknown = precision === "unknown";
    elements[kind + "YearField"].hidden = unknown;
    elements[kind + "MonthField"].hidden = precision !== "month" && precision !== "day";
    elements[kind + "DayField"].hidden = precision !== "day";
    elements[kind + "ApproximateField"].hidden = unknown;
    let preview;
    try {
      const data = readDateEditor(kind);
      const temp = {}; temp[kind + "Date"] = data.value; temp[kind + "DatePrecision"] = data.precision; temp[kind + "DateApproximate"] = data.approximate;
      preview = formatPersonDate(temp, kind, kind === "birth" ? "生年不明" : "没年不明");
    } catch (error) { preview = kind === "birth" ? "生年を入力" : "没年を入力"; }
    elements[kind + "DatePreview"].textContent = preview;
  }

  function updatePhotoPreview() {
    if (state.photoValue) {
      elements.photoPreview.innerHTML = "<img src=\"" + escapeHtml(state.photoValue) + "\" alt=\"選択した写真\">";
      elements.removePhotoButton.hidden = false;
    } else {
      elements.photoPreview.textContent = elements.givenName.value.trim().slice(0, 1) || "写";
      elements.removePhotoButton.hidden = true;
    }
  }

  function updateDeathDateState() {
    const enabled = elements.isDeceased.checked;
    elements.deathDateLabel.querySelectorAll("input, select").forEach(function (control) { control.disabled = !enabled; });
    elements.deathDateLabel.style.opacity = enabled ? "1" : ".55";
  }

  async function readPhoto(file) {
    if (!file || !file.type.startsWith("image/")) throw new Error("画像ファイルを選んでください。");
    if (file.size > 30 * 1024 * 1024) throw new Error("写真は30MB以下のものを選んでください。");
    let drawable;
    let objectUrl = "";
    try {
      if (typeof createImageBitmap === "function") {
        try { drawable = await createImageBitmap(file, { imageOrientation: "from-image" }); }
        catch (error) { drawable = await createImageBitmap(file); }
      } else {
        objectUrl = URL.createObjectURL(file);
        drawable = await new Promise(function (resolve, reject) {
          const image = new Image();
          image.onload = function () { resolve(image); };
          image.onerror = function () { reject(new Error("写真の形式を読み込めませんでした。")); };
          image.src = objectUrl;
        });
      }
      const sourceWidth = drawable.width || drawable.naturalWidth;
      const sourceHeight = drawable.height || drawable.naturalHeight;
      if (!sourceWidth || !sourceHeight) throw new Error("写真の大きさを確認できませんでした。");
      const limit = 1200;
      const ratio = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * ratio));
      canvas.height = Math.max(1, Math.round(sourceHeight * ratio));
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("写真を圧縮できないブラウザです。");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(drawable, 0, 0, canvas.width, canvas.height);
      const useWebp = file.type === "image/png" || file.type === "image/webp";
      const dataUrl = canvas.toDataURL(useWebp ? "image/webp" : "image/jpeg", useWebp ? 0.88 : 0.86);
      const estimatedBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
      return {
        dataUrl: dataUrl,
        originalBytes: file.size,
        compressedBytes: estimatedBytes,
        width: canvas.width,
        height: canvas.height,
        compressed: ratio < 1 || estimatedBytes < file.size * 0.92
      };
    } catch (error) {
      throw new Error("写真を縮小・圧縮できませんでした。別の画像を選ぶか、画像形式を確認してください。");
    } finally {
      if (drawable && typeof drawable.close === "function") drawable.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  function typeOptions(kind, select) {
    const options = kind === "partner"
      ? [["marriage", "婚姻"], ["partnership", "パートナー"]]
      : [["biological", "実親子"], ["adoptive", "養親子"], ["step", "継親子"]];
    select.innerHTML = options.map(function (option) { return "<option value=\"" + option[0] + "\">" + option[1] + "</option>"; }).join("");
  }

  function updateRelationshipKind() {
    const kind = elements.relationKind.value;
    typeOptions(kind, elements.relationType);
    elements.parentDirectionField.hidden = kind === "partner";
    elements.relationStatusLabel.hidden = kind !== "partner";
  }

  function renderRelationshipTargetOptions(baseId, selectedId, relationship) {
    let candidates;
    if (relationship) {
      candidates = state.persons.filter(function (person) { return person.id === selectedId; });
    } else {
      const checked = elements.relationshipForm.querySelector("input[name=parentDirection]:checked");
      const spec = { type: elements.relationKind.value, direction: checked ? checked.value : "base-parent" };
      candidates = state.persons.filter(function (person) {
        return canAddRelationshipCandidate(baseId, person.id, spec);
      });
    }
    candidates = PersonCandidates.sortPersonsByKanjiName(candidates);
    elements.relationTarget.innerHTML = candidates.map(function (person) {
      return "<option value=\"" + escapeHtml(person.id) + "\">" + escapeHtml(fullName(person)) + "</option>";
    }).join("");
    elements.relationTarget.value = selectedId && candidates.some(function (person) { return person.id === selectedId; }) ? selectedId : (candidates[0] && candidates[0].id) || "";
  }

  function openRelationshipDialog(baseId, relationship) {
    const base = findPerson(baseId);
    if (!base) return;
    if (!relationship && state.persons.length < 2) {
      showToast("関係を登録するには、人物をもう1人追加してください。", true);
      return;
    }
    elements.relationshipForm.reset();
    elements.relationshipFormError.hidden = true;
    elements.relationshipDialogTitle.textContent = relationship ? "関係を編集" : "関係を追加";
    elements.relationshipId.value = relationship ? relationship.id : "";
    elements.relationshipBaseId.value = base.id;
    let targetId = "";
    if (relationship) targetId = relationship.fromPersonId === base.id ? relationship.toPersonId : relationship.fromPersonId;
    elements.relationshipVerificationStatus.value = relationship ? (relationship.verificationStatus || "unconfirmed") : "unconfirmed";
    elements.relationKind.value = relationship ? relationship.type : "parent-child";
    elements.relationKind.disabled = Boolean(relationship);
    elements.relationTarget.disabled = Boolean(relationship);
    elements.baseParentLabel.textContent = fullName(base) + "が相手の親";
    elements.baseChildLabel.textContent = fullName(base) + "が相手の子";
    updateRelationshipKind();
    if (relationship) {
      elements.relationType.value = relationship.relationshipType;
      elements.relationStatus.value = relationship.status || "current";
      elements.relationStartDate.value = relationship.startDate || "";
      elements.relationEndDate.value = relationship.endDate || "";
      elements.relationMemo.value = relationship.memo || "";
      if (relationship.type === "parent-child") {
        const direction = relationship.fromPersonId === base.id ? "base-parent" : "base-child";
        elements.relationshipForm.querySelector("input[name=parentDirection][value=" + direction + "]").checked = true;
      }
    }
    renderRelationshipTargetOptions(base.id, targetId, relationship);
    elements.relationshipDialog.showModal();
  }

  function relativeRoleInfo() {
    const value = elements.relativeRole.value;
    if (value === "partner") return { role: "partner", kind: "partner", label: "配偶者・パートナー", suggestedGender: "" };
    if (value === "child") return { role: "child", kind: "parent-child", label: "子ども", suggestedGender: "" };
    if (value === "parent-mother") return { role: "parent", kind: "parent-child", label: "母または親", suggestedGender: "female" };
    return { role: "parent", kind: "parent-child", label: "父または親", suggestedGender: "male" };
  }

  function updateRelativeRole() {
    const info = relativeRoleInfo();
    typeOptions(info.kind, elements.quickRelationType);
    elements.quickStatusLabel.hidden = info.kind !== "partner";
    if (state.relativeSource === "existing") renderRelativePersonResults();
  }

  function setRelativeSource(source) {
    state.relativeSource = source;
    document.querySelectorAll("[data-relative-source]").forEach(function (button) {
      button.classList.toggle("is-active", button.dataset.relativeSource === source);
    });
    elements.relativeNewPanel.hidden = source !== "new";
    elements.relativeExistingPanel.hidden = source !== "existing";
    elements.relativeContinueButton.textContent = source === "new" ? "人物情報を入力" : "この人物との関係を保存";
    if (source === "existing") renderRelativePersonResults();
  }

  function renderRelativePersonResults() {
    const baseId = elements.relativeBaseId.value;
    const query = elements.relativePersonSearch.value;
    const spec = quickRelationSpec();
    const candidates = state.persons.filter(function (person) {
      return canAddRelationshipCandidate(baseId, person.id, spec);
    });
    if (state.selectedExistingRelativeId && !candidates.some(function (person) { return person.id === state.selectedExistingRelativeId; })) {
      state.selectedExistingRelativeId = "";
    }
    const people = PersonCandidates.rankAndSortPersonCandidates(candidates, query).slice(0, 80);
    elements.relativePersonResults.innerHTML = people.length ? people.map(function (person) {
      const selected = person.id === state.selectedExistingRelativeId;
      const name = fullName(person);
      return "<button class=\"person-pick relation-candidate-compact\" type=\"button\" data-existing-relative=\"" + escapeHtml(person.id) + "\" aria-selected=\"" + selected + "\" aria-label=\"" + escapeHtml(name) + "\" title=\"" + escapeHtml(name) + "\"><span class=\"relation-candidate-name\">" + escapeHtml(name) + "</span></button>";
    }).join("") : "<p class=\"search-empty\">該当する人物はいません</p>";
  }

  function openRelativeDialog(baseId) {
    if (!findPerson(baseId)) return;
    elements.relativeForm.reset();
    elements.relativeBaseId.value = baseId;
    elements.relativeFormError.hidden = true;
    elements.relativePersonSearch.value = "";
    state.selectedExistingRelativeId = "";
    updateRelativeRole();
    setRelativeSource("new");
    elements.relativeDialog.showModal();
  }

  function quickRelationSpec() {
    const info = relativeRoleInfo();
    return {
      role: info.role,
      type: info.kind,
      relationshipType: elements.quickRelationType.value,
      status: info.kind === "partner" ? elements.quickStatus.value : "",
      startDate: elements.quickStartDate.value,
      endDate: elements.quickEndDate.value,
      memo: elements.quickMemo.value,
      sortOrder: null
    };
  }

  function relationshipFromRelative(baseId, targetId, spec) {
    let fromPersonId = baseId;
    let toPersonId = targetId;
    if (spec.role === "parent") { fromPersonId = targetId; toPersonId = baseId; }
    return Object.assign({}, spec, { fromPersonId: fromPersonId, toPersonId: toPersonId });
  }

  function renderFocusList() {
    const resolvedFocusId = resolveFocusPersonId(state.persons, state.relationships);
    elements.focusPersonList.innerHTML = state.persons.slice().sort(Layout.comparePeople).map(function (person) {
      return "<button class=\"person-pick" + (person.id === resolvedFocusId ? " is-current" : "") + "\" type=\"button\" data-focus-person=\"" + escapeHtml(person.id) + "\">" + avatarHtml(person) + "<span><strong>" + escapeHtml(fullName(person)) + "</strong><small>" + escapeHtml(lifeYears(person)) + "</small></span></button>";
    }).join("") || "<p class=\"search-empty\">人物が登録されていません。</p>";
  }

  function renderSearchResults() {
    const query = elements.personSearch.value.trim();
    if (!query) { elements.searchResults.hidden = true; elements.searchResults.replaceChildren(); return; }
    const results = state.persons.filter(function (person) {
      return matchesPersonSearch(person, query);
    }).slice(0, 12);
    elements.searchResults.innerHTML = results.length ? results.map(function (person) {
      return "<button class=\"search-result\" type=\"button\" role=\"option\" data-search-person=\"" + escapeHtml(person.id) + "\">" + avatarHtml(person) + "<span><strong>" + escapeHtml(fullName(person)) + "</strong><small>" + escapeHtml(lifeYears(person)) + "</small></span></button>";
    }).join("") : "<p class=\"search-empty\">該当する人物はいません</p>";
    elements.searchResults.hidden = false;
  }

  function relationshipCount(personId) {
    return state.relationships.filter(function (item) { return item.fromPersonId === personId || item.toPersonId === personId; }).length;
  }

  function informationIssues(person) {
    const issues = [];
    const relations = state.relationships.filter(function (item) { return item.fromPersonId === person.id || item.toPersonId === person.id; });
    const parents = state.relationships.filter(function (item) { return item.type === "parent-child" && item.toPersonId === person.id; });
    if (!person.familyName || !person.givenName) issues.push("氏名が不完全");
    if (!person.birthDate || personDatePrecision(person, "birth") === "unknown") issues.push("生年月日・生年が不明");
    if (!parents.length) issues.push("親が未登録");
    if (!person.photo) issues.push("写真がない");
    if (!person.familyNameKana || !person.givenNameKana) issues.push("よみがながない");
    if (!relations.length) issues.push("親族関係がない");
    if (person.isDeceased && !person.deathDate) issues.push("故人だが没年月日・没年がない");
    if (!person.isDeceased && person.deathDate) issues.push("没年月日があるが故人ではない");
    const birthBounds = DB.dateBounds(person.birthDate, personDatePrecision(person, "birth"));
    const deathBounds = DB.dateBounds(person.deathDate, personDatePrecision(person, "death"));
    if (birthBounds && deathBounds && deathBounds.end < birthBounds.start) issues.push("没年月日が生年月日より前");
    const today = new Date().toISOString().slice(0, 10);
    if (birthBounds && birthBounds.start > today) issues.push("生年月日が未来");
    if (deathBounds && deathBounds.start > today) issues.push("没年月日が未来");
    return issues;
  }

  function comparePersonList(a, b, sort) {
    if (sort === "kana") return ((a.familyNameKana || "") + (a.givenNameKana || "") || fullName(a)).localeCompare(((b.familyNameKana || "") + (b.givenNameKana || "") || fullName(b)), "ja");
    if (sort === "birth") return (a.birthDate || "9999").localeCompare(b.birthDate || "9999") || fullName(a).localeCompare(fullName(b), "ja");
    if (sort === "updated") return (b.updatedAt || "").localeCompare(a.updatedAt || "") || fullName(a).localeCompare(fullName(b), "ja");
    if (sort === "created") return (b.createdAt || "").localeCompare(a.createdAt || "") || fullName(a).localeCompare(fullName(b), "ja");
    return fullName(a).localeCompare(fullName(b), "ja");
  }

  function personMatchesFilter(person, filter) {
    if (filter === "living") return !person.isDeceased;
    if (filter === "deceased") return person.isDeceased;
    if (filter === "birth-unknown") return !person.birthDate || personDatePrecision(person, "birth") === "unknown";
    if (filter === "no-photo") return !person.photo;
    if (filter === "no-parent") return !state.relationships.some(function (item) { return item.type === "parent-child" && item.toPersonId === person.id; });
    if (filter === "unrelated") return relationshipCount(person.id) === 0;
    if (filter === "incomplete") return informationIssues(person).length > 0;
    return true;
  }

  function renderPersonList() {
    if (!elements.personList) return;
    const query = elements.personSearch.value.trim();
    const filter = elements.peopleFilter.value || "all";
    const sort = elements.peopleSort.value || "name";
    const people = state.persons.filter(function (person) { return matchesPersonSearch(person, query) && personMatchesFilter(person, filter); }).sort(function (a, b) { return comparePersonList(a, b, sort); });
    elements.peopleCount.textContent = people.length + "人";
    elements.personList.innerHTML = people.length ? people.map(function (person) {
      const issues = informationIssues(person);
      return "<button class=\"person-list-card\" type=\"button\" data-list-person=\"" + escapeHtml(person.id) + "\">" + avatarHtml(person, "list-avatar") +
        "<span class=\"person-list-main\"><strong>" + escapeHtml(fullName(person)) + "</strong>" + (person.formerFamilyName ? "<small>旧姓 " + escapeHtml(person.formerFamilyName) + "</small>" : "") +
        "<small>" + escapeHtml(lifeYears(person)) + "・関係 " + relationshipCount(person.id) + "件</small></span>" +
        (issues.length ? "<span class=\"incomplete-chip\">要確認 " + issues.length + "</span>" : "<span class=\"complete-chip\">確認済み</span>") + "</button>";
    }).join("") : "<div class=\"list-empty\"><strong>該当する人物はいません</strong><p>検索や絞り込みを変更してください。</p></div>";
  }

  function renderIssues() {
    const rows = [];
    state.persons.slice().sort(Layout.comparePeople).forEach(function (person) {
      informationIssues(person).forEach(function (issue) { rows.push({ person: person, issue: issue }); });
    });
    elements.issuesContent.innerHTML = rows.length ? "<div class=\"issue-summary\">" + rows.length + "件の確認項目があります。情報不足はエラーではなく、登録を補助する案内です。</div><div class=\"issue-list\">" + rows.map(function (row) {
      return "<button type=\"button\" data-edit-issue=\"" + escapeHtml(row.person.id) + "\">" + avatarHtml(row.person) + "<span><strong>" + escapeHtml(fullName(row.person)) + "</strong><small>" + escapeHtml(row.issue) + "</small></span><span aria-hidden=\"true\">›</span></button>";
    }).join("") + "</div>" : "<div class=\"review-empty\"><strong>大きな情報不足は見つかりませんでした</strong><p>必要に応じて人物詳細から追加情報を記録できます。</p></div>";
  }

  function relativeNameSummary(personId, group) {
    return getRelativeGroups(personId)[group].map(function (item) { return fullName(item.person); }).join("、") || "なし";
  }

  function renderDuplicateCandidates() {
    const candidates = DB.detectDuplicateCandidates(state.persons, state.relationships, state.duplicateExclusions);
    elements.duplicateContent.innerHTML = candidates.length ? candidates.map(function (candidate) {
      const a = findPerson(candidate.personAId); const b = findPerson(candidate.personBId);
      function side(person) {
        return "<div class=\"duplicate-person\">" + avatarHtml(person, "duplicate-avatar") + "<strong>" + escapeHtml(fullName(person)) + "</strong><span>" + escapeHtml(formatPersonDate(person, "birth", "生年不明")) + "</span><dl><div><dt>親</dt><dd>" + escapeHtml(relativeNameSummary(person.id, "parents")) + "</dd></div><div><dt>配偶者</dt><dd>" + escapeHtml(relativeNameSummary(person.id, "partners")) + "</dd></div><div><dt>子ども</dt><dd>" + escapeHtml(relativeNameSummary(person.id, "children")) + "</dd></div></dl></div>";
      }
      return "<article class=\"duplicate-card\"><div class=\"duplicate-reasons\"><strong>候補になった理由</strong><span>" + escapeHtml(candidate.reasons.join("・")) + "</span></div><div class=\"duplicate-compare\">" + side(a) + "<span class=\"compare-mark\">⇄</span>" + side(b) + "</div><div class=\"duplicate-actions\"><button class=\"secondary-button\" type=\"button\" data-exclude-duplicate=\"" + escapeHtml(a.id) + "|" + escapeHtml(b.id) + "\">別人として除外</button><button class=\"primary-button\" type=\"button\" data-merge-duplicate=\"" + escapeHtml(a.id) + "|" + escapeHtml(b.id) + "\">比較して統合</button></div></article>";
    }).join("") : "<div class=\"review-empty\"><strong>重複候補はありません</strong><p>除外した組み合わせは、人物が削除・統合されるまで再表示されません。</p></div>";
  }

  const MERGE_FIELD_SPECS = [
    ["familyName", "姓"], ["givenName", "名"], ["formerFamilyName", "旧姓"], ["reading", "よみがな"],
    ["nickname", "通称"], ["otherNames", "別名・幼名"], ["honorific", "敬称・続柄表記"], ["nameMemo", "名前の補足"],
    ["gender", "性別"], ["birth", "生年月日・生年"], ["death", "故人・没年月日"], ["birthplace", "出身地"], ["photo", "写真"], ["memo", "メモ"]
  ];

  function mergeFieldValue(person, field) {
    if (field === "reading") return ((person.familyNameKana || "") + " " + (person.givenNameKana || "")).trim();
    if (field === "birth") return formatPersonDate(person, "birth", "未登録");
    if (field === "death") return (person.isDeceased ? "故人・" : "存命・") + formatPersonDate(person, "death", "没年未登録");
    if (field === "gender") return { female: "女性", male: "男性", nonbinary: "ノンバイナリー", other: "その他", undisclosed: "回答しない", "": "未設定" }[person.gender] || "未設定";
    return person[field] || "未登録";
  }

  function renderMergeForm() {
    if (!state.mergePair) return;
    const a = findPerson(state.mergePair[0]); const b = findPerson(state.mergePair[1]);
    if (!a || !b) return;
    const selected = elements.mergeKeepChoices.querySelector("input[name=mergeKeep]:checked");
    const keepId = selected ? selected.value : a.id;
    const keep = keepId === a.id ? a : b;
    const merge = keepId === a.id ? b : a;
    elements.mergeKeepChoices.innerHTML = [a, b].map(function (person) { return "<label class=\"merge-keep-card\"><input type=\"radio\" name=\"mergeKeep\" value=\"" + escapeHtml(person.id) + "\"" + (person.id === keepId ? " checked" : "") + ">" + avatarHtml(person) + "<span><strong>" + escapeHtml(fullName(person)) + "</strong><small>この人物IDを残す</small></span></label>"; }).join("");
    elements.mergeFields.innerHTML = "<div class=\"merge-field merge-field-heading\"><strong>項目</strong><span>残す人物</span><span>統合する人物</span></div>" + MERGE_FIELD_SPECS.map(function (spec) {
      const field = spec[0]; const keepValue = mergeFieldValue(keep, field); const mergeValue = mergeFieldValue(merge, field);
      const defaultChoice = keepValue === "未登録" && mergeValue !== "未登録" ? "merge" : "keep";
      function choice(value, label, text, person) {
        if (field === "photo") return "<label><input type=\"radio\" name=\"merge-field-" + field + "\" value=\"" + value + "\"" + (defaultChoice === value ? " checked" : "") + ">" + avatarHtml(person, "merge-photo") + "<span>" + label + "</span></label>";
        return "<label><input type=\"radio\" name=\"merge-field-" + field + "\" value=\"" + value + "\"" + (defaultChoice === value ? " checked" : "") + "><span>" + escapeHtml(text) + "</span></label>";
      }
      return "<div class=\"merge-field\"><strong>" + escapeHtml(spec[1]) + "</strong>" + choice("keep", "残す", keepValue, keep) + choice("merge", "統合元", mergeValue, merge) + "</div>";
    }).join("");
  }

  function openMergeDialog(personAId, personBId) {
    state.mergePair = [personAId, personBId];
    elements.mergeError.hidden = true;
    elements.mergeKeepChoices.innerHTML = "<input type=\"radio\" name=\"mergeKeep\" value=\"" + escapeHtml(personAId) + "\" checked>";
    renderMergeForm();
    elements.mergeDialog.showModal();
  }

  function openRelationshipMenu(relationshipId, relativeId, group) {
    const relationship = findRelationship(relationshipId);
    const person = findPerson(relativeId);
    if (!relationship || !person) return;
    state.relationshipMenu = { relationshipId: relationshipId, relativeId: relativeId, group: group, baseId: state.selectedPersonId };
    elements.relationshipMenuTitle.textContent = fullName(person) + "との関係";
    const orderable = group === "children" || group === "partners";
    const items = getRelativeGroups(state.selectedPersonId)[group] || [];
    const index = items.findIndex(function (item) { return item.relationship.id === relationshipId; });
    elements.moveRelationUpButton.hidden = !orderable;
    elements.moveRelationDownButton.hidden = !orderable;
    elements.resetRelationOrderButton.hidden = !orderable;
    elements.moveRelationUpButton.disabled = index <= 0;
    elements.moveRelationDownButton.disabled = index < 0 || index >= items.length - 1;
    elements.resetRelationOrderButton.textContent = group === "children" ? "生年月日順へ戻す" : "基本の順番へ戻す";
    elements.relationshipMenuDialog.showModal();
  }

  async function changeRelationOrder(direction) {
    const menu = state.relationshipMenu;
    if (!menu) return;
    const items = getRelativeGroups(menu.baseId)[menu.group] || [];
    const index = items.findIndex(function (item) { return item.relationship.id === menu.relationshipId; });
    if (direction === "reset") {
      await DB.saveRelationshipOrders(items.map(function (item) { return { id: item.relationship.id, sortOrder: null }; }));
    } else {
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return;
      const moved = items.splice(index, 1)[0];
      items.splice(targetIndex, 0, moved);
      await DB.saveRelationshipOrders(items.map(function (item, itemIndex) { return { id: item.relationship.id, sortOrder: (itemIndex + 1) * 10 }; }));
    }
    elements.relationshipMenuDialog.close();
    await refreshData();
    showToast(direction === "reset" ? "基本の表示順に戻しました。" : "表示順を変更しました。");
  }

  function showTreeError(error) {
    elements.treeLoading.hidden = true;
    elements.treeEmpty.hidden = true;
    elements.treeError.hidden = false;
    elements.treeErrorMessage.textContent = readableError(error, "ページを再読み込みしてください。");
  }

  function bindDialogs() {
    document.addEventListener("click", function (event) {
      const closeButton = event.target.closest("[data-close-dialog]");
      if (!closeButton) return;
      const dialog = closeButton.closest("dialog");
      if (dialog) dialog.close();
    });
    document.querySelectorAll("dialog").forEach(function (dialog) {
      dialog.addEventListener("click", function (event) { if (event.target === dialog) dialog.close(); });
    });
    elements.personDialog.addEventListener("close", function () {
      if (!state.personSaving) state.personFormContext = null;
    });
  }

  function bindTreeGestures() {
    elements.treeSvg.addEventListener("click", function (event) {
      const node = event.target.closest(".tree-node");
      if (node && Date.now() >= state.suppressClickUntil) { openDetail(node.dataset.personId); return; }
      const partnerLine = event.target.closest("[data-relation-role='partner-interaction-hit-area'], [data-relation-role='partner-double-line']");
      if (partnerLine && Date.now() >= state.suppressClickUntil) {
        const relationship = state.relationships.find(function (item) { return item.id === partnerLine.dataset.relationshipId; });
        const partnerIds = (partnerLine.dataset.partnerPersonIds || "").split(/\s+/).filter(Boolean);
        const personById = new Map(state.persons.map(function (person) { return [person.id, person]; }));
        const names = partnerIds.map(function (id) { return fullName(personById.get(id) || { familyName: "", givenName: id }); }).join("・");
        const type = relationship && relationship.relationshipType || partnerLine.dataset.relationshipType;
        const status = relationship && relationship.status || partnerLine.dataset.status || "current";
        const dates = relationship && (relationship.startDate || relationship.endDate) ? "・" + formatDate(relationship.startDate) + "〜" + formatDate(relationship.endDate) : "";
        showToast(names + "・" + relationLabel(type) + "・" + statusLabel(status, type) + dates);
        return;
      }
      const relationLine = event.target.closest("[data-relation-role='interaction-hit-area'], [data-relation-role='children-bus'], [data-relation-role='child-stem'], [data-relation-role='adoptive-route'], [data-relation-role='step-route']");
      if (relationLine && Date.now() >= state.suppressClickUntil) {
        const parentIds = (relationLine.dataset.parentIds || "").split(/\s+/).filter(Boolean);
        const childIds = (relationLine.dataset.targetChildId || relationLine.dataset.childIds || "").split(/\s+/).filter(Boolean);
        const personById = new Map(state.persons.map(function (person) { return [person.id, person]; }));
        const parentNames = parentIds.map(function (id) { return fullName(personById.get(id) || { familyName: "", givenName: id }); }).join("・");
        const childNames = childIds.map(function (id) { return fullName(personById.get(id) || { familyName: "", givenName: id }); }).join("・");
        const typeLabel = { biological: "実親子", adoptive: "養親子", step: "継親子" }[relationLine.dataset.relationshipType] || "親子";
        showToast("親: " + parentNames + " ／ 子: " + childNames + "（" + typeLabel + "・家族単位: " + parentNames + "）");
      }
      const family = event.target.closest(".tree-family-unit");
      if (family && Date.now() >= state.suppressClickUntil) {
        state.selectedFamilyKey = state.selectedFamilyKey === family.dataset.familyKey ? "" : family.dataset.familyKey;
        updateTreeSelectionHighlight();
      } else if (!state.dragMoved && Date.now() >= state.suppressClickUntil) {
        state.selectedFamilyKey = "";
        updateTreeSelectionHighlight();
      }
    });
    elements.treeSvg.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      const node = event.target.closest(".tree-node");
      if (node) { event.preventDefault(); openDetail(node.dataset.personId); return; }
      const family = event.target.closest(".tree-family-unit");
      if (family) { event.preventDefault(); state.selectedFamilyKey = family.dataset.familyKey; updateTreeSelectionHighlight(); }
    });
    elements.treeSvg.addEventListener("pointerdown", function (event) {
      elements.treeSvg.setPointerCapture(event.pointerId);
      state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
      state.dragMoved = false;
      if (state.pointers.size === 2) {
        const points = Array.from(state.pointers.values());
        state.pinch = {
          distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
          scale: state.transform.scale, x: state.transform.x, y: state.transform.y,
          centerX: (points[0].x + points[1].x) / 2, centerY: (points[0].y + points[1].y) / 2
        };
      }
    });
    elements.treeSvg.addEventListener("pointermove", function (event) {
      if (!state.pointers.has(event.pointerId)) return;
      const previous = state.pointers.get(event.pointerId);
      const next = { x: event.clientX, y: event.clientY, startX: previous.startX, startY: previous.startY };
      state.pointers.set(event.pointerId, next);
      if (state.pointers.size >= 2 && state.pinch) {
        const rect = elements.treeSvg.getBoundingClientRect();
        const points = Array.from(state.pointers.values()).slice(0, 2);
        const distance = Math.max(1, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y));
        const scale = Math.max(0.25, Math.min(2.5, state.pinch.scale * distance / Math.max(1, state.pinch.distance)));
        const startX = state.pinch.centerX - rect.left;
        const startY = state.pinch.centerY - rect.top;
        const currentX = (points[0].x + points[1].x) / 2 - rect.left;
        const currentY = (points[0].y + points[1].y) / 2 - rect.top;
        state.transform.scale = scale;
        state.transform.x = currentX - ((startX - state.pinch.x) / state.pinch.scale) * scale;
        state.transform.y = currentY - ((startY - state.pinch.y) / state.pinch.scale) * scale;
        state.dragMoved = true;
        elements.treeSvg.classList.add("is-dragging");
        applyTransform();
        scheduleScaleSave();
      } else if (state.pointers.size === 1) {
        const total = Math.hypot(event.clientX - previous.startX, event.clientY - previous.startY);
        if (!state.dragMoved && total < 7) return;
        state.dragMoved = true;
        elements.treeSvg.classList.add("is-dragging");
        state.transform.x += event.clientX - previous.x;
        state.transform.y += event.clientY - previous.y;
        applyTransform();
      }
    });
    function finishPointer(event) {
      state.pointers.delete(event.pointerId);
      state.pinch = null;
      if (state.dragMoved) state.suppressClickUntil = Date.now() + 180;
      if (state.pointers.size === 0) elements.treeSvg.classList.remove("is-dragging");
    }
    elements.treeSvg.addEventListener("pointerup", finishPointer);
    elements.treeSvg.addEventListener("pointercancel", finishPointer);
    elements.treeSvg.addEventListener("wheel", function (event) {
      event.preventDefault();
      zoomAt(state.transform.scale * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX, event.clientY);
    }, { passive: false });
  }

  function switchAppView(view) {
    state.currentView = view === "people" ? "people" : "tree";
    elements.treeSection.hidden = state.currentView !== "tree";
    elements.peopleSection.hidden = state.currentView !== "people";
    document.querySelectorAll("[data-app-view]").forEach(function (button) { button.classList.toggle("is-active", button.dataset.appView === state.currentView); });
    if (state.currentView === "people") renderPersonList();
    else requestAnimationFrame(function () { if (state.layout) applyTransform(); });
  }

  function updateKinshipField() {
    elements.kinshipDepth.disabled = elements.treeViewMode.value !== "kinship";
  }

  function openViewRangeDialog() {
    elements.treeViewMode.value = state.settings.treeViewMode;
    elements.kinshipDepth.value = state.settings.kinshipDepth;
    elements.includePartners.checked = state.settings.includePartners;
    elements.showGenerationLabels.checked = state.settings.showGenerationLabels;
    elements.kinshipDisplayMode.value = state.settings.kinshipDisplayMode || "both";
    updateKinshipField();
    elements.viewRangeDialog.showModal();
  }

  async function handleViewRangeSubmit(event) {
    event.preventDefault();
    try {
      state.settings = await DB.saveSettings({
        treeViewMode: elements.treeViewMode.value,
        kinshipDepth: elements.kinshipDepth.value,
        includePartners: elements.includePartners.checked,
        showGenerationLabels: elements.showGenerationLabels.checked,
        kinshipDisplayMode: elements.kinshipDisplayMode.value
      });
      elements.viewRangeDialog.close();
      renderTree();
      requestAnimationFrame(centerTree);
      showToast("家系図の表示範囲を更新しました。");
    } catch (error) { showToast(readableError(error, "表示範囲を保存できませんでした。"), true); }
  }

  function openIssuesDialog() {
    if (elements.settingsDialog.open) elements.settingsDialog.close();
    renderIssues();
    elements.issuesDialog.showModal();
  }

  function openDuplicateDialog() {
    if (elements.settingsDialog.open) elements.settingsDialog.close();
    renderDuplicateCandidates();
    elements.duplicateDialog.showModal();
  }

  async function handleDuplicateAction(event) {
    const exclude = event.target.closest("[data-exclude-duplicate]");
    const merge = event.target.closest("[data-merge-duplicate]");
    const target = exclude || merge;
    if (!target) return;
    const ids = (exclude ? exclude.dataset.excludeDuplicate : merge.dataset.mergeDuplicate).split("|");
    if (exclude) {
      try {
        await DB.saveDuplicateExclusion(ids[0], ids[1]);
        const data = await DB.readAll();
        state.duplicateExclusions = data.duplicateExclusions;
        renderDuplicateCandidates();
        showToast("この2人を別人として除外しました。");
      } catch (error) { showToast(readableError(error, "候補を除外できませんでした。"), true); }
    } else {
      elements.duplicateDialog.close();
      openMergeDialog(ids[0], ids[1]);
    }
  }

  async function handleMergeSubmit(event) {
    event.preventDefault();
    elements.mergeError.hidden = true;
    if (!state.mergePair) return;
    const keep = elements.mergeKeepChoices.querySelector("input[name=mergeKeep]:checked");
    if (!keep) return;
    const keepId = keep.value;
    const mergeId = state.mergePair.find(function (id) { return id !== keepId; });
    const selections = {};
    MERGE_FIELD_SPECS.forEach(function (spec) {
      const checked = elements.mergeFields.querySelector("input[name=merge-field-" + spec[0] + "]:checked");
      selections[spec[0]] = checked ? checked.value : "keep";
    });
    const keepPerson = findPerson(keepId); const mergePerson = findPerson(mergeId);
    if (!globalThis.confirm(fullName(mergePerson) + "を" + fullName(keepPerson) + "へ統合しますか？\n関係を付け替え、重複を整理した後、統合元の人物を削除します。元に戻せません。")) return;
    setBusy(elements.mergeSubmitButton, true, "統合中…");
    try {
      const result = await DB.mergePersons(keepId, mergeId, selections);
      elements.mergeDialog.close();
      state.mergePair = null;
      await refreshData({ revealPersonId: result.person.id });
      openDetail(result.person.id);
      showToast("人物を統合し、関係を安全に整理しました。");
    } catch (error) {
      elements.mergeError.textContent = readableError(error, "人物を統合できませんでした。");
      elements.mergeError.hidden = false;
    } finally { setBusy(elements.mergeSubmitButton, false); }
  }

  function bindEvents() {
    bindDialogs();
    bindTreeGestures();
    document.querySelectorAll("[data-app-view]").forEach(function (button) { button.addEventListener("click", function () { switchAppView(button.dataset.appView); }); });
    document.querySelectorAll("[data-add-person]").forEach(function (button) {
      button.addEventListener("click", function () { state.personFormContext = null; openPersonDialog(null); });
    });
    elements.menuButton.addEventListener("click", function () { elements.settingsDialog.showModal(); });
    elements.mobileMenuButton.addEventListener("click", function () { elements.settingsDialog.showModal(); });
    elements.detailBackdrop.addEventListener("click", closeDetail);
    elements.zoomInButton.addEventListener("click", function () { zoomAt(state.transform.scale * 1.18); });
    elements.zoomOutButton.addEventListener("click", function () { zoomAt(state.transform.scale / 1.18); });
    elements.centerButton.addEventListener("click", centerTree);
    elements.fitAllButton.addEventListener("click", fitWholeTree);
    elements.resetScaleButton.addEventListener("click", resetTreeScale);
    elements.focusButton.addEventListener("click", function () { renderFocusList(); elements.focusDialog.showModal(); });
    elements.viewRangeButton.addEventListener("click", openViewRangeDialog);
    elements.viewSummary.addEventListener("click", openViewRangeDialog);
    elements.treeViewMode.addEventListener("change", updateKinshipField);
    elements.kinshipFilter.addEventListener("change", function () {
      state.kinshipFilter = elements.kinshipFilter.value || "all";
      applyKinshipHighlight();
    });
    elements.retryButton.addEventListener("click", bootData);
    elements.privacyNotice.querySelector("[data-dismiss-notice]").addEventListener("click", function () { elements.privacyNotice.hidden = true; });
    elements.personSearch.addEventListener("input", function () { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(function () { renderSearchResults(); renderPersonList(); }, 140); });
    elements.searchResults.addEventListener("click", function (event) {
      const result = event.target.closest("[data-search-person]");
      if (!result) return;
      openDetail(result.dataset.searchPerson);
      elements.personSearch.value = "";
      renderSearchResults();
    });
    document.addEventListener("click", function (event) { if (!event.target.closest(".search-wrap")) elements.searchResults.hidden = true; });
    elements.isDeceased.addEventListener("change", updateDeathDateState);
    elements.givenName.addEventListener("input", function () { if (!state.photoValue) updatePhotoPreview(); });
    elements.photoInput.addEventListener("change", async function () {
      const file = elements.photoInput.files && elements.photoInput.files[0];
      if (!file) return;
      try {
        const result = await readPhoto(file);
        state.photoValue = result.dataUrl;
        state.photoInfo = result;
        elements.photoCompressionNotice.textContent = result.compressed
          ? "写真を " + result.width + "×" + result.height + "px・約" + Math.max(1, Math.round(result.compressedBytes / 1024)) + "KBへ圧縮しました。"
          : "写真を保存用に調整しました（約" + Math.max(1, Math.round(result.compressedBytes / 1024)) + "KB）。";
        updatePhotoPreview();
      }
      catch (error) { showToast(readableError(error, "写真を読み込めませんでした。"), true); }
      finally { elements.photoInput.value = ""; }
    });
    elements.removePhotoButton.addEventListener("click", function () { state.photoValue = ""; updatePhotoPreview(); });
    ["birth", "death"].forEach(function (kind) {
      ["DatePrecision", "DateYear", "DateMonth", "DateDay", "DateApproximate"].forEach(function (suffix) {
        elements[kind + suffix].addEventListener("change", function () { updateDateEditor(kind); });
        if (suffix === "DateYear") elements[kind + suffix].addEventListener("input", function () { updateDateEditor(kind); });
      });
    });
    elements.personForm.addEventListener("submit", handlePersonSubmit);
    elements.relationKind.addEventListener("change", function () {
      updateRelationshipKind();
      if (!elements.relationshipId.value) renderRelationshipTargetOptions(elements.relationshipBaseId.value, elements.relationTarget.value, null);
    });
    elements.relationshipForm.querySelectorAll("input[name=parentDirection]").forEach(function (input) {
      input.addEventListener("change", function () {
        if (!elements.relationshipId.value) renderRelationshipTargetOptions(elements.relationshipBaseId.value, elements.relationTarget.value, null);
      });
    });
    elements.relationshipForm.addEventListener("submit", handleRelationshipSubmit);
    elements.detailContent.addEventListener("click", handleDetailClick);
    elements.relativeRole.addEventListener("change", updateRelativeRole);
    document.querySelectorAll("[data-relative-source]").forEach(function (button) {
      button.addEventListener("click", function () { setRelativeSource(button.dataset.relativeSource); });
    });
    elements.relativePersonSearch.addEventListener("input", renderRelativePersonResults);
    elements.relativePersonResults.addEventListener("click", function (event) {
      const button = event.target.closest("[data-existing-relative]");
      if (!button) return;
      state.selectedExistingRelativeId = button.dataset.existingRelative;
      renderRelativePersonResults();
    });
    elements.relativeForm.addEventListener("submit", handleRelativeSubmit);
    elements.relationshipMenuDialog.addEventListener("click", handleRelationshipMenuAction);
    elements.focusPersonList.addEventListener("click", handleFocusSelection);
    elements.viewRangeForm.addEventListener("submit", handleViewRangeSubmit);
    elements.peopleSort.addEventListener("change", renderPersonList);
    elements.peopleFilter.addEventListener("change", renderPersonList);
    elements.personList.addEventListener("click", function (event) { const button = event.target.closest("[data-list-person]"); if (button) openDetail(button.dataset.listPerson); });
    elements.issuesButton.addEventListener("click", openIssuesDialog);
    elements.openIssuesButton.addEventListener("click", openIssuesDialog);
    elements.openPeopleButton.addEventListener("click", function () { elements.settingsDialog.close(); switchAppView("people"); });
    elements.issuesContent.addEventListener("click", function (event) { const button = event.target.closest("[data-edit-issue]"); if (!button) return; elements.issuesDialog.close(); state.personFormContext = null; openPersonDialog(findPerson(button.dataset.editIssue)); });
    elements.duplicateButton.addEventListener("click", openDuplicateDialog);
    elements.duplicateContent.addEventListener("click", handleDuplicateAction);
    elements.mergeKeepChoices.addEventListener("change", renderMergeForm);
    elements.mergeForm.addEventListener("submit", handleMergeSubmit);
    elements.mergeBackupButton.addEventListener("click", exportBackup);
    elements.exportButton.addEventListener("click", exportBackup);
    elements.importInput.addEventListener("change", importBackup);
    elements.openPngButton.addEventListener("click", openPngDialog);
    elements.pngForm.addEventListener("submit", handlePngSubmit);
    elements.openPrintButton.addEventListener("click", openPrintDialog);
    elements.printForm.addEventListener("input", renderPrintPreview);
    elements.printForm.addEventListener("submit", handlePrintSubmit);
    elements.resetSampleButton.addEventListener("click", resetSamples);
    elements.deleteAllButton.addEventListener("click", deleteAllData);
    globalThis.addEventListener("resize", function () { if (matchMedia("(min-width: 841px)").matches) elements.detailBackdrop.hidden = true; });
  }

  function personFromForm() {
    const birth = readDateEditor("birth");
    const death = elements.isDeceased.checked ? readDateEditor("death") : { value: "", precision: "unknown", approximate: false };
    return {
      id: elements.personId.value, familyName: elements.familyName.value, givenName: elements.givenName.value,
      formerFamilyName: elements.formerFamilyName.value, familyNameKana: elements.familyNameKana.value,
      givenNameKana: elements.givenNameKana.value, nickname: elements.nickname.value, otherNames: elements.otherNames.value,
      honorific: elements.honorific.value, nameMemo: elements.nameMemo.value, gender: elements.gender.value,
      birthDate: birth.value, birthDatePrecision: birth.precision, birthDateApproximate: birth.approximate,
      deathDate: death.value, deathDatePrecision: death.precision, deathDateApproximate: death.approximate,
      isDeceased: elements.isDeceased.checked, birthplace: elements.birthplace.value,
      photo: state.photoValue, memo: elements.memo.value, verificationStatus: elements.personVerificationStatus.value
    };
  }

  async function handlePersonSubmit(event) {
    event.preventDefault();
    elements.personFormError.hidden = true;
    let person;
    try { person = personFromForm(); }
    catch (error) { elements.personFormError.textContent = readableError(error, "年月日を確認してください。"); elements.personFormError.hidden = false; return; }
    const wasEdit = Boolean(person.id);
    const context = state.personFormContext;
    setBusy(elements.savePersonButton, true, "保存中…");
    state.personSaving = true;
    try {
      if (context && context.mode === "relative") {
        const result = await DB.saveRelativePerson(context.baseId, person, context.spec);
        state.personFormContext = null;
        elements.personDialog.close();
        closeDetail();
        await refreshData({ revealPersonId: result.person.id });
        showToast(context.label + "を人物情報と同時に追加しました。");
      } else {
        const saved = await DB.savePerson(person);
        if (!state.settings.focusPersonId) state.settings = await DB.saveSettings({ focusPersonId: saved.id });
        elements.personDialog.close();
        await refreshData({ revealPersonId: wasEdit ? "" : saved.id });
        openDetail(saved.id);
        showToast(wasEdit ? "人物情報を更新しました。" : "人物を追加しました。");
      }
    } catch (error) {
      elements.personFormError.textContent = readableError(error, "人物を保存できませんでした。");
      elements.personFormError.hidden = false;
    } finally {
      state.personSaving = false;
      setBusy(elements.savePersonButton, false);
    }
  }

  async function handleRelationshipSubmit(event) {
    event.preventDefault();
    elements.relationshipFormError.hidden = true;
    const baseId = elements.relationshipBaseId.value;
    const targetId = elements.relationTarget.value;
    const kind = elements.relationKind.value;
    let fromPersonId = baseId;
    let toPersonId = targetId;
    if (kind === "parent-child") {
      const checked = elements.relationshipForm.querySelector("input[name=parentDirection]:checked");
      if (checked && checked.value === "base-child") { fromPersonId = targetId; toPersonId = baseId; }
    }
    setBusy(elements.saveRelationshipButton, true, "保存中…");
    try {
      await DB.saveRelationship({
        id: elements.relationshipId.value, type: kind, fromPersonId: fromPersonId, toPersonId: toPersonId,
        relationshipType: elements.relationType.value, status: kind === "partner" ? elements.relationStatus.value : "",
        startDate: elements.relationStartDate.value, endDate: elements.relationEndDate.value, memo: elements.relationMemo.value,
        verificationStatus: elements.relationshipVerificationStatus.value
      });
      elements.relationshipDialog.close();
      elements.relationKind.disabled = false;
      elements.relationTarget.disabled = false;
      await refreshData();
      showToast(elements.relationshipId.value ? "関係を更新しました。" : "関係を追加しました。");
    } catch (error) {
      elements.relationshipFormError.textContent = readableError(error, "関係を保存できませんでした。");
      elements.relationshipFormError.hidden = false;
    } finally { setBusy(elements.saveRelationshipButton, false); }
  }

  async function handleRelativeSubmit(event) {
    event.preventDefault();
    elements.relativeFormError.hidden = true;
    const baseId = elements.relativeBaseId.value;
    const info = relativeRoleInfo();
    const spec = quickRelationSpec();
    if (state.relativeSource === "new") {
      state.personFormContext = { mode: "relative", baseId: baseId, spec: spec, label: info.label };
      elements.relativeDialog.close();
      openPersonDialog(null, { title: info.label + "を追加", suggestedGender: info.suggestedGender });
      return;
    }
    if (!state.selectedExistingRelativeId) {
      elements.relativeFormError.textContent = "登録済み人物を1人選んでください。";
      elements.relativeFormError.hidden = false;
      return;
    }
    setBusy(elements.relativeContinueButton, true, "保存中…");
    try {
      await DB.saveRelationship(relationshipFromRelative(baseId, state.selectedExistingRelativeId, spec));
      const revealId = state.selectedExistingRelativeId;
      elements.relativeDialog.close();
      closeDetail();
      await refreshData({ revealPersonId: revealId });
      showToast("登録済み人物との関係を追加しました。");
    } catch (error) {
      elements.relativeFormError.textContent = readableError(error, "関係を保存できませんでした。");
      elements.relativeFormError.hidden = false;
    } finally { setBusy(elements.relativeContinueButton, false); }
  }

  async function handleDetailClick(event) {
    if (event.target.closest("[data-close-detail]")) { closeDetail(); return; }
    const relativeButton = event.target.closest("[data-open-person]");
    if (relativeButton) { openDetail(relativeButton.dataset.openPerson); return; }
    const menuButton = event.target.closest("[data-relationship-menu]");
    if (menuButton) { openRelationshipMenu(menuButton.dataset.relationshipMenu, menuButton.dataset.relativeId, menuButton.dataset.group); return; }
    if (event.target.closest("[data-edit-person]")) { state.personFormContext = null; openPersonDialog(findPerson(state.selectedPersonId)); return; }
    if (event.target.closest("[data-add-relative]")) { openRelativeDialog(state.selectedPersonId); return; }
    if (event.target.closest("[data-add-relation]")) { openRelationshipDialog(state.selectedPersonId, null); return; }
    if (event.target.closest("[data-set-focus]")) {
      try {
        state.settings = await DB.saveSettings({ focusPersonId: state.selectedPersonId });
        renderTree(); renderDetail(); requestAnimationFrame(function () { revealPerson(state.selectedPersonId); });
        showToast("基準人物に設定しました。");
      } catch (error) { showToast(readableError(error, "基準人物を保存できませんでした。"), true); }
      return;
    }
    if (event.target.closest("[data-delete-person]")) {
      const person = findPerson(state.selectedPersonId);
      if (!person || !globalThis.confirm(fullName(person) + "を削除しますか？\nこの人物に関連する親子・パートナー関係も削除されます。この操作は元に戻せません。")) return;
      try { await DB.deletePerson(person.id); closeDetail(); await refreshData(); showToast("人物と関連する関係を削除しました。"); }
      catch (error) { showToast(readableError(error, "人物を削除できませんでした。"), true); }
    }
  }

  async function handleRelationshipMenuAction(event) {
    const button = event.target.closest("[data-menu-action]");
    if (!button || !state.relationshipMenu) return;
    const action = button.dataset.menuAction;
    const menu = state.relationshipMenu;
    if (action === "open") {
      elements.relationshipMenuDialog.close();
      openDetail(menu.relativeId);
    } else if (action === "edit") {
      const relationship = findRelationship(menu.relationshipId);
      elements.relationshipMenuDialog.close();
      openRelationshipDialog(menu.baseId, relationship);
    } else if (action === "unlink") {
      const person = findPerson(menu.relativeId);
      if (!globalThis.confirm(fullName(person) + "との関係を解除しますか？\n人物情報そのものは削除されません。")) return;
      try {
        await DB.deleteRelationship(menu.relationshipId);
        elements.relationshipMenuDialog.close();
        await refreshData();
        showToast("関係を解除しました。人物情報は残っています。");
      } catch (error) { showToast(readableError(error, "関係を解除できませんでした。"), true); }
    } else if (action === "up" || action === "down" || action === "reset") {
      try { await changeRelationOrder(action); }
      catch (error) { showToast(readableError(error, "表示順を変更できませんでした。"), true); }
    }
  }

  async function handleFocusSelection(event) {
    const button = event.target.closest("[data-focus-person]");
    if (!button) return;
    try {
      state.settings = await DB.saveSettings({ focusPersonId: button.dataset.focusPerson });
      elements.focusDialog.close();
      renderTree();
      if (state.selectedPersonId) renderDetail();
      requestAnimationFrame(function () { revealPerson(button.dataset.focusPerson); });
      showToast("基準人物を変更しました。");
    } catch (error) { showToast(readableError(error, "基準人物を保存できませんでした。"), true); }
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  async function exportBackup() {
    if (!globalThis.confirm("JSONバックアップには存命人物の個人情報と写真・添付ファイルが含まれる可能性があります。\n保管場所に注意し、SNSや公開サイトへ直接アップロードしないでください。書き出しますか？")) return;
    setBusy(elements.exportButton, true, "作成中…");
    try {
      const backup = await DB.createBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
      downloadBlob(blob, "family-tree-note-backup-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + ".json");
      showToast("試作4の全体バックアップを書き出しました。");
    } catch (error) { showToast(readableError(error, "バックアップを作成できませんでした。"), true); }
    finally { setBusy(elements.exportButton, false); }
  }

  async function importBackup() {
    const file = elements.importInput.files && elements.importInput.files[0];
    elements.importInput.value = "";
    if (!file) return;
    if (file.size > 60 * 1024 * 1024) { showToast("バックアップファイルが大きすぎます。", true); return; }
    const mode = elements.importMode ? elements.importMode.value : "new";
    const modeLabel = mode === "replace" ? "現在の家系図を置き換え" : mode === "append" ? "IDが重複しないデータだけを追加し" : "新しい家系図として復元し";
    if (!globalThis.confirm("バックアップを" + modeLabel + "ます。\n復元前に自動スナップショットを作成します。続けますか？")) return;
    try {
      const text = await file.text();
      let value;
      try { value = JSON.parse(text); } catch (error) { throw new Error("JSONファイルを読み取れません。ファイルが壊れていないか確認してください。"); }
      await DB.restoreBackup(value, { mode: mode });
      closeDetail();
      await refreshData({ center: true });
      elements.settingsDialog.close();
      showToast("バックアップを復元しました。");
    } catch (error) { showToast(readableError(error, "バックアップを復元できませんでした。"), true); }
  }

  function exportSvgStyles() {
    return "text{font-family:'Yu Gothic UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif}" +
      ".tree-link{fill:none;stroke:#9aab9e;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.tree-partner-link{stroke:#718c79;stroke-width:1.8}.tree-partner-link.is-separated{stroke-dasharray:11 8}.tree-partner-link.is-unknown{stroke:#aeb7b0;stroke-width:1.5;opacity:.82}.tree-partner-marker{stroke:#61776a;stroke-width:2.4}.tree-partner-marker.is-ended{stroke-width:2}.tree-parent-adoptive{stroke-dasharray:10 7}.tree-parent-step{stroke-width:1.6;stroke-dasharray:2 7}.tree-disconnected-divider{stroke:#c8c9bf;stroke-width:1.5;stroke-dasharray:5 7}.tree-disconnected-label{fill:#68756d;font-size:13px;font-weight:700}" +
      ".tree-crossing-gap{fill:#f7f3e8;stroke:none}.tree-crossing-overpass{pointer-events:none}.tree-interaction-hit{display:none}.tree-union-anchor{fill:#f7f3e8;stroke:#557c64;stroke-width:1.8}.tree-family-unit.is-generation-conflict .tree-link{stroke:#8b7041}" +
      ".tree-generation-label{fill:#557c64;font-size:13px;font-weight:700}.tree-link.is-unverified{stroke-dasharray:4 5}.tree-node-card{fill:#fffef9;stroke:#d6d5c9;stroke-width:1.5}.tree-node.person-card--deceased .tree-node-card{fill:#eeeeee}.tree-node.person-card--kinship-1 .tree-node-card{fill:#f6a8bd}.tree-node.person-card--kinship-2 .tree-node-card{fill:#f8b8c9}.tree-node.person-card--kinship-3 .tree-node-card{fill:#fac7d5}.tree-node.person-card--kinship-4 .tree-node-card{fill:#fbd4df}.tree-node.person-card--kinship-5 .tree-node-card{fill:#fde1e8}.tree-node.person-card--kinship-6 .tree-node-card{fill:#feecf1}.tree-node.is-focus .tree-node-card{stroke:#557c64;stroke-width:3}.tree-node.has-generation-conflict .tree-node-card{stroke:#8b7041;stroke-dasharray:5 4}.tree-node-photo-bg{fill:#e3eee5}.tree-node-initial{fill:#3f6250;font-size:23px;font-weight:700;text-anchor:middle;dominant-baseline:central}.tree-node-name{fill:#2c3a32;font-size:16.5px;font-weight:800;text-anchor:middle}.tree-node-kana{fill:#68756d;font-size:9.5px;text-anchor:middle}.tree-node-kinship-label{fill:#3f6250;font-size:11px;font-weight:700;text-anchor:middle}.tree-node-years{fill:#68756d;font-size:11px;text-anchor:middle}.tree-node-status{fill:#68756d;font-size:9.5px;text-anchor:middle}.tree-node-deceased{fill:#ecebe4;stroke:#d6d5c9}.tree-node-deceased-text{fill:#68756d;font-size:10px;text-anchor:middle}.tree-node-kinship-badge{fill:#edf3ed;stroke:#b7c7ba}.tree-node-kinship-badge.is-self{fill:#557c64;stroke:#3f6250}.tree-node-kinship-badge.is-spouse{fill:#f1eee5;stroke:#b8aa88}.tree-node-kinship-badge.is-affinity{fill:#edf0f5;stroke:#aab5c4}.tree-node-kinship-badge.is-outside{fill:#f1efeb;stroke:#c5c0b6}.tree-node-kinship-badge-text{fill:#3f6250;font-size:9px;font-weight:800;text-anchor:middle}.tree-node-kinship-badge-text.is-self{fill:white}.tree-node-kinship-badge-text.is-spouse{fill:#6c5b37}.tree-node-kinship-badge-text.is-affinity{fill:#4d6077}.tree-node-kinship-badge-text.is-outside{fill:#6d6961}.tree-node-verification{fill:#fff4d8;stroke:#8b7041}.tree-node-verification-text{fill:#6c5328;font-size:10px;font-weight:700;text-anchor:middle}";
  }

  function privacyInitial(person) {
    const family = Array.from(person.familyName || "")[0] || "";
    const given = Array.from(person.givenName || "")[0] || "";
    return (family + given) || "非公開";
  }

  function applyPrivacyToSvg(svg, persons, mode) {
    if (mode === "all") return;
    const personMap = new Map(persons.map(function (person) { return [person.id, person]; }));
    svg.querySelectorAll(".tree-node").forEach(function (node) {
      const person = personMap.get(node.getAttribute("data-person-id"));
      if (!person || person.isDeceased) return;
      const title = node.querySelector("title");
      if (title) title.textContent = mode === "initials" ? privacyInitial(person) : fullName(person);
      node.setAttribute("aria-label", mode === "initials" ? privacyInitial(person) : fullName(person));
      const years = node.querySelector(".tree-node-years");
      if (years) years.textContent = "";
      if (mode === "hide-photo-dates" || mode === "initials") {
        node.querySelectorAll("image").forEach(function (image) { image.remove(); });
        if (!node.querySelector(".tree-node-initial")) {
          const initial = svgElement("text", { class: "tree-node-initial", x: 31, y: 57 });
          initial.textContent = privacyInitial(person);
          node.appendChild(initial);
        }
      }
      if (mode === "initials") {
        const name = node.querySelector(".tree-node-name");
        if (name) name.textContent = privacyInitial(person);
        const nameNotes = node.querySelector(".tree-node-kana");
        if (nameNotes) nameNotes.textContent = "";
      }
    });
  }

  function createStandaloneSvg(view, showGenerationLabels, privacyMode, pixelScale) {
    const scene = createTreeScene(view.persons, view.relationships, showGenerationLabels);
    const bounds = scene.layout.bounds;
    const scale = pixelScale || 1;
    const svg = svgElement("svg", {
      xmlns: SVG_NS,
      width: Math.max(1, Math.round(bounds.width * scale)),
      height: Math.max(1, Math.round(bounds.height * scale)),
      viewBox: bounds.x + " " + bounds.y + " " + bounds.width + " " + bounds.height,
      preserveAspectRatio: "xMidYMid meet"
    });
    svg.setAttribute("data-routing-issue-count", String(scene.layout.routingDiagnostics.issues.length));
    svg.setAttribute("data-routing-crossing-count", String(scene.layout.routingDiagnostics.crossingCount));
    const style = svgElement("style", {}); style.textContent = exportSvgStyles(); svg.appendChild(style);
    svg.appendChild(svgElement("rect", { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, fill: "#f7f3e8" }));
    svg.appendChild(scene.fragment);
    applyPrivacyToSvg(svg, view.persons, privacyMode);
    svg.querySelectorAll(".tree-interaction-hit").forEach(function (element) { element.remove(); });
    return { svg: svg, layout: scene.layout };
  }

  function imageFromUrl(url) {
    return new Promise(function (resolve, reject) {
      const image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error("SVGを画像へ変換できませんでした。")); };
      image.src = url;
    });
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("PNGを作成できませんでした。")); }, "image/png");
      } else {
        try {
          const parts = canvas.toDataURL("image/png").split(",");
          const bytes = atob(parts[1]);
          const data = new Uint8Array(bytes.length);
          for (let i = 0; i < bytes.length; i += 1) data[i] = bytes.charCodeAt(i);
          resolve(new Blob([data], { type: "image/png" }));
        } catch (error) { reject(error); }
      }
    });
  }

  function openPngDialog() {
    if (elements.settingsDialog.open) elements.settingsDialog.close();
    elements.pngPrivacyMode.value = state.settings.outputPrivacyMode || "hide-dates";
    elements.pngError.hidden = true;
    elements.pngDialog.showModal();
  }

  async function handlePngSubmit(event) {
    event.preventDefault();
    await saveTreeAsPng(elements.pngPrivacyMode.value);
  }

  async function saveTreeAsPng(privacyMode) {
    if (!state.layout || !state.layout.nodes.length) { showToast("画像にする人物が登録されていません。", true); return; }
    setBusy(elements.savePngButton, true, "画像を作成中…");
    let svgUrl = "";
    try {
      state.settings = await DB.saveSettings({ outputPrivacyMode: privacyMode });
      const view = { persons: state.visiblePersons, relationships: state.visibleRelationships };
      const bounds = state.layout.bounds;
      const baseArea = Math.max(1, bounds.width * bounds.height);
      // Large canvases can exhaust memory on mobile Safari and headless Chromium.
      // Keep the full SVG in frame while capping raster output to about 16 MP.
      const exportScale = Math.max(1, Math.min(2, 6000 / Math.max(bounds.width, bounds.height), Math.sqrt(16000000 / baseArea)));
      const result = createStandaloneSvg(view, state.settings.showGenerationLabels, privacyMode, exportScale);
      const svg = result.svg;
      const width = Number(svg.getAttribute("width"));
      const height = Number(svg.getAttribute("height"));
      const serialized = new XMLSerializer().serializeToString(svg);
      svgUrl = URL.createObjectURL(new Blob([serialized], { type: "image/svg+xml;charset=utf-8" }));
      const image = await imageFromUrl(svgUrl);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("画像を作成できないブラウザです。");
      context.fillStyle = "#f7f3e8";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const blob = await canvasToBlob(canvas);
      downloadBlob(blob, "家系図ノート_" + new Date().toISOString().slice(0, 10) + ".png");
      elements.pngDialog.close();
      showToast("家系図全体をPNG画像に保存しました。");
    } catch (error) { elements.pngError.textContent = readableError(error, "家系図の画像保存に失敗しました。"); elements.pngError.hidden = false; showToast(elements.pngError.textContent, true); }
    finally {
      if (svgUrl) URL.revokeObjectURL(svgUrl);
      setBusy(elements.savePngButton, false);
    }
  }

  function openPrintDialog() {
    if (elements.settingsDialog.open) elements.settingsDialog.close();
    const settings = state.settings.printSettings || {};
    elements.printTitle.value = settings.title || "家系図ノート";
    elements.printNote.value = settings.note || "";
    elements.printPaperSize.value = settings.paperSize || "auto";
    elements.printScope.value = settings.scope || "current";
    elements.printPrivacyMode.value = settings.privacyMode || "hide-dates";
    elements.printShowDate.checked = settings.showDate !== false;
    elements.printShowGenerationLabels.checked = Boolean(settings.showGenerationLabels);
    renderPrintPreview();
    elements.printDialog.showModal();
  }

  function renderPrintPreview() {
    if (!elements.printPreview) return;
    const scopeText = elements.printScope.value === "all" ? "登録人物全員" : viewModeLabel();
    const paper = elements.printPaperSize.options[elements.printPaperSize.selectedIndex];
    elements.printPreview.innerHTML = "<strong>印刷プレビュー</strong><p>「" + escapeHtml(elements.printTitle.value || "無題") + "」を、" + escapeHtml(paper ? paper.textContent : "自動") + "・" + escapeHtml(scopeText) + "で印刷します。</p>";
  }

  function paperPageRule(value) {
    return { "a4-portrait": "A4 portrait", "a4-landscape": "A4 landscape", "a3-portrait": "A3 portrait", "a3-landscape": "A3 landscape" }[value] || "auto";
  }

  async function handlePrintSubmit(event) {
    event.preventDefault();
    setBusy(elements.printButton, true, "準備中…");
    try {
      const printSettings = {
        title: elements.printTitle.value,
        note: elements.printNote.value,
        paperSize: elements.printPaperSize.value,
        scope: elements.printScope.value,
        privacyMode: elements.printPrivacyMode.value,
        showDate: elements.printShowDate.checked,
        showGenerationLabels: elements.printShowGenerationLabels.checked
      };
      state.settings = await DB.saveSettings({ printSettings: printSettings });
      const view = printSettings.scope === "all" ? getTreeViewData(true) : { persons: state.visiblePersons, relationships: state.visibleRelationships };
      if (!view.persons.length) throw new Error("印刷する人物がいません。");
      const result = createStandaloneSvg(view, printSettings.showGenerationLabels, printSettings.privacyMode, 1);
      result.svg.removeAttribute("width"); result.svg.removeAttribute("height"); result.svg.classList.add("print-tree-svg");
      elements.printArea.replaceChildren();
      const header = document.createElement("header");
      header.innerHTML = "<h1>" + escapeHtml(printSettings.title || "家系図ノート") + "</h1>" + (printSettings.note ? "<p>" + escapeHtml(printSettings.note) + "</p>" : "") + (printSettings.showDate ? "<small>作成日：" + new Date().toLocaleDateString("ja-JP") + "</small>" : "");
      const tree = document.createElement("div"); tree.className = "print-tree"; tree.appendChild(result.svg);
      elements.printArea.append(header, tree);
      elements.printPageStyle.textContent = "@page{size:" + paperPageRule(printSettings.paperSize) + ";margin:10mm}";
      elements.printArea.setAttribute("aria-hidden", "false");
      document.body.classList.add("is-printing");
      elements.printDialog.close();
      const cleanup = function () { document.body.classList.remove("is-printing"); elements.printArea.setAttribute("aria-hidden", "true"); };
      globalThis.addEventListener("afterprint", cleanup, { once: true });
      setTimeout(function () { globalThis.print(); setTimeout(cleanup, 5000); }, 80);
    } catch (error) { showToast(readableError(error, "印刷の準備に失敗しました。"), true); }
    finally { setBusy(elements.printButton, false); }
  }

  async function resetSamples() {
    if (!globalThis.confirm("現在の家系図を試作4のサンプル家族に置き換えますか？\n置き換え前に自動スナップショットを作成します。")) return;
    setBusy(elements.resetSampleButton, true, "登録中…");
    try { await DB.resetSampleData(); closeDetail(); await refreshData({ center: true }); elements.settingsDialog.close(); showToast("試作4のサンプルデータを再登録しました。"); }
    catch (error) { showToast(readableError(error, "サンプルデータを登録できませんでした。"), true); }
    finally { setBusy(elements.resetSampleButton, false); }
  }

  async function deleteAllData() {
    if (!globalThis.confirm("人物・関係・写真をすべて削除します。\nこの操作は元に戻せません。実行しますか？")) return;
    setBusy(elements.deleteAllButton, true, "削除中…");
    try { await DB.clearAll(); closeDetail(); await refreshData({ center: true }); elements.settingsDialog.close(); showToast("この端末の全データを削除しました。"); }
    catch (error) { showToast(readableError(error, "全データを削除できませんでした。"), true); }
    finally { setBusy(elements.deleteAllButton, false); }
  }

  async function bootData() {
    elements.treeLoading.hidden = false;
    elements.treeError.hidden = true;
    elements.treeEmpty.hidden = true;
    try {
      const data = await DB.initialize();
      state.persons = data.persons;
      state.relationships = data.relationships;
      state.settings = data.settings;
      state.currentTree = data.currentTree || null;
      state.duplicateExclusions = data.duplicateExclusions || [];
      state.transform.scale = Number(data.settings.scale) || 1;
      renderTree();
      renderPersonList();
      requestAnimationFrame(function () { centerTree({ preserveScale: true }); });
    } catch (error) { showTreeError(error); }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register("./sw.js").catch(function () { /* 通常機能は継続する */ });
  }

  globalThis.FamilyTreeAppTest = Object.freeze({
    compressPhoto: readPhoto,
    informationIssues: informationIssues,
    getTreeViewData: function (forceAll) { return getTreeViewData(Boolean(forceAll)); },
    formatPersonDate: formatPersonDate,
    routingDiagnostics: function () { return state.layout ? state.layout.routingDiagnostics : null; },
    generationDiagnostics: function () { return state.layout ? state.layout.generationDiagnostics : null; },
    layoutState: function () { return globalThis.__familyTreeLayoutState || null; },
    centerOnFocus: function () { centerTree({ preserveScale: true }); return Object.assign({}, state.transform); },
    fitWholeTree: function () { fitWholeTree(); return Object.assign({}, state.transform); },
    resetTreeScale: function () { resetTreeScale(); return Object.assign({}, state.transform); },
    privacySnapshot: function (mode, forceAll) {
      const view = forceAll ? getTreeViewData(true) : { persons: state.visiblePersons, relationships: state.visibleRelationships };
      return createStandaloneSvg(view, state.settings.showGenerationLabels, mode, 1).svg.outerHTML;
    }
  });

  function boot() {
    try {
      cacheElements();
      if (!DB || !Layout) throw new Error("必要なプログラムを読み込めませんでした。");
      populateDateSelects();
      bindEvents();
      bootData();
      registerServiceWorker();
    } catch (error) {
      const app = document.getElementById("app");
      const template = document.getElementById("fatalTemplate");
      if (app && template) app.replaceWith(template.content.cloneNode(true));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}());
