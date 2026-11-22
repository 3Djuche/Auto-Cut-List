import { $, categoryOf, formatNumber, shared } from "./state.js";
import { buildRows, categoryIcon } from "./table.js";
import { setTemplateCategory, syncTemplateBar } from "./templates.js";
import { finish, setHostStatus } from "./host.js";

// ---------- Weldment shapes ----------
// Each weldment member is sorted into a shape family from its profile (library folder and file or
// configuration), its SolidWorks callout and its cut-list name. A family can have its own templates and
// adds size fields such as {side1} and {wall}, parsed from the profile size.
const builtInShapes = [
    {key: "square-tube", name: "Square tube", short: "Sq tube", fields: ["side1", "side2", "wall"]},
    {key: "rect-tube", name: "Rectangular tube", short: "Rect tube", fields: ["side1", "side2", "wall"]},
    {key: "round-tube", name: "Round tube", short: "Rnd tube", fields: ["od", "wall"]},
    {key: "pipe", name: "Pipe", short: "Pipe", fields: ["nps", "schedule", "od", "wall"]},
    {key: "w-beam", name: "W beam", short: "W beam", fields: ["depth", "weight"]},
    {key: "s-beam", name: "S beam", short: "S beam", fields: ["depth", "weight"]},
    {key: "channel", name: "C channel", short: "Channel", fields: ["depth", "weight"]},
    {key: "angle", name: "Angle", short: "Angle", fields: ["side1", "side2", "wall"]},
    {key: "tee", name: "Tee", short: "Tee", fields: ["depth", "weight"]},
    {key: "flat-bar", name: "Flat bar", short: "Flat bar", fields: ["side1", "wall"]},
    {key: "square-bar", name: "Square bar", short: "Sq bar", fields: ["side1"]},
    {key: "round-bar", name: "Round bar", short: "Round bar", fields: ["diameter"]}
];
const otherShape = {key: "other", name: "Other weldments", short: "Weldment", fields: []};
// An icon for each shape; custom shapes and Other weldments use the weldment icon.
const shapeIcons = {"square-tube": "square-tube.svg", "rect-tube": "rectangular-tube.svg", "round-tube": "round-tube.svg",
    "pipe": "pipe.svg", "w-beam": "i-beam.svg", "s-beam": "i-beam.svg", "channel": "c-channel.svg", "angle": "angle.svg",
    "tee": "tee-bar.svg", "flat-bar": "flat-bar.svg", "square-bar": "square-bar.svg", "round-bar": "round-bar.svg"};
function shapeIcon(key) {
    const image = document.createElement("img");
    image.className = "category-icon colored";
    image.src = "icons/" + (shapeIcons[key] ?? "weldment.svg");
    image.alt = "";
    return image;
}
const shapeTokens = ["profile", "standard", "size", "size1", "size2", "size3", "side1", "side2", "wall",
    "nps", "schedule", "od", "depth", "weight", "diameter"];
const genericShapeFields = ["profile", "standard", "size", "size1", "size2", "size3"];

// Names used by SolidWorks' default profile library and common shop terms, checked in order.
const defaultShapeRules = [
    [/\bsquare\s*(?:tube|tubing|hss)\b|\bsq\.?\s*tub(?:e|ing)\b|\bshs\b/, "square-tube"],
    [/\brect(?:angular|\.)?\s*(?:tube|tubing|hss)\b|\brhs\b/, "rect-tube"],
    [/\bround\s*(?:tube|tubing|hss)\b|\btub(?:e|ing)\s*round\b|\bchs\b/, "round-tube"],
    [/\bpipe\b/, "pipe"],
    [/\bw[\s-]*(?:section|shape|beam)s?\b|\bwide[\s-]*flange\b|\bhp[\s-]*(?:section|shape)s?\b/, "w-beam"],
    [/\bs[\s-]*(?:section|shape|beam)s?\b|\bsb[\s-]*beams?\b|\bi[\s-]*beams?\b|\bstandard\s*beams?\b/, "s-beam"],
    [/\bc[\s-]*(?:channel|section|shape)s?\b|\bchannels?\b|\bmc[\s-]*(?:section|shape)s?\b/, "channel"],
    [/\bangles?\b/, "angle"],
    [/\btees?\b|\b(?:w|s|m)?t[\s-]*(?:section|shape)s?\b/, "tee"],
    [/\bflat[\s-]*bars?\b|\bbar[\s-]*flat\b|\bflats?\b/, "flat-bar"],
    [/\bsquare[\s-]*bars?\b|\bsq\.?[\s-]*bars?\b|\bbar[\s-]*square\b/, "square-bar"],
    [/\bround[\s-]*bars?\b|\brods?\b|\bround[\s-]*stock\b/, "round-bar"]
];

let shapeRules = {rules: [], custom: [], labels: {}, libraries: {}};
let shapeVersion = 0;
shared.shapeFilter = "all";
shared.templateShape = "";
const dismissedLibraries = new Set();

function allShapes() {
    return [...builtInShapes, ...shapeRules.custom.map(item => ({key: item.key, name: item.name, short: item.name, fields: [], custom: true})), otherShape];
}
function shapeByKey(key) {
    return allShapes().find(shape => shape.key === key) ?? otherShape;
}
function shapeLabel(key) {
    const text = shapeRules.labels?.[key];
    return typeof text === "string" ? text : shapeByKey(key).name;
}

function loadShapeRules(text) {
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
    shapeRules = {
        rules: Array.isArray(parsed.rules) ? parsed.rules.filter(rule => typeof rule?.match === "string" && typeof rule?.family === "string") : [],
        custom: Array.isArray(parsed.custom) ? parsed.custom.filter(item => typeof item?.key === "string" && typeof item?.name === "string") : [],
        labels: parsed.labels && typeof parsed.labels === "object" ? parsed.labels : {},
        libraries: parsed.libraries && typeof parsed.libraries === "object" ? parsed.libraries : {}
    };
    shapeVersion++;
}

// Shape rules, custom shapes and the text {profile} inserts are settings like any other: they change the window
// straight away and are kept when settings are saved (Save settings, Apply, or a preset), not before.
function saveShapeRules(message) {
    shared.input.settings.weldment.ShapeRules = JSON.stringify(shapeRules);
    shapeVersion++;
    buildRows();
    renderShapeSettings();
    if (message) $("#shape-status").textContent = message + " Click Save settings to keep it.";
    return Promise.resolve(null);
}

// The shape rules as last saved. Answers to the custom-library prompt are kept straight away (they answer a
// question rather than try out a setting), so they're written into the saved rules without the unsaved changes.
shared.savedShapeRules = "";
async function saveLibraryChoice(path, choice) {
    if (choice) shapeRules.libraries[path] = choice;
    else delete shapeRules.libraries[path];
    shared.input.settings.weldment.ShapeRules = JSON.stringify(shapeRules);
    shapeVersion++;
    buildRows();
    renderShapeSettings();
    let saved = {};
    try { saved = shared.savedShapeRules ? JSON.parse(shared.savedShapeRules) : {}; } catch { saved = {}; }
    saved.libraries = {...(saved.libraries ?? {})};
    if (choice) saved.libraries[path] = choice;
    else delete saved.libraries[path];
    const json = JSON.stringify(saved);
    const reply = await finish("shapes", undefined, undefined, {ShapeRules: json, Settings: null});
    if (reply?.type === "shapes") shared.savedShapeRules = json;
    return reply;
}

// Templates of their own for weldment shapes, and for regular parts' Box and Cylinder shapes.
function shapeTemplates(category = "weldment") {
    try { return JSON.parse(shared.input.settings[category].ShapeTemplates || "{}") ?? {}; } catch { return {}; }
}
function setShapeTemplate(key, template, category = "weldment") {
    const templates = shapeTemplates(category);
    if (template) templates[key] = {Description: template.Description, Length: template.Length};
    else delete templates[key];
    shared.input.settings[category].ShapeTemplates = JSON.stringify(templates);
}
// A regular part is a Box (measured across its rectangular envelope) or a Cylinder (measured across and along its axis).
const partShapes = [{key: "Box", name: "Box (rectangular)"}, {key: "Cylinder", name: "Cylinder (round)"}];
function partShapeOptions(selected) {
    return partShapes.map(shape => Object.assign(document.createElement("option"),
        {value: shape.key, textContent: shape.name, selected: shape.key === selected}));
}

// Numbers in a profile size: decimals, fractions (1/4) and mixed numbers (1-1/2 or 1 1/2).
function sizeNumbers(text) {
    const numbers = [];
    for (const match of text.matchAll(/(\d+)\s*[- ]\s*(\d+)\/(\d+)|(\d+)\/(\d+)|(\d*\.\d+|\d+)/g)) {
        const value = match[1] ? Number(match[1]) + match[2] / match[3] : match[4] ? match[4] / match[5] : parseFloat(match[6]);
        numbers.push({value, text: match[0].trim()});
    }
    return numbers;
}

function metricStandard(standard) {
    return /\b(?:iso|din|en|jis|gb|bs|as|csa|metric|mm)\b/i.test(standard ?? "") && !/\binch\b/i.test(standard ?? "");
}

// Designations such as W8x31, C3 x 4.1, L2x2x1/4, HSS 4x2x1/4 or TS 2X2X.25.
function shapeFromDesignation(text) {
    const value = (text ?? "").trim().toLowerCase();
    if (!value) return null;
    if (/^(?:hss|ts)\b/.test(value)) {
        const numbers = sizeNumbers(value);
        // HSS with two numbers is round (OD x wall); TS (tube steel) is always square or rectangular.
        if (numbers.length === 2) return value.startsWith("hss") ? "round-tube" : "square-tube";
        if (numbers.length >= 3) return Math.abs(numbers[0].value - numbers[1].value) < 1e-9 ? "square-tube" : "rect-tube";
        return null;
    }
    if (/^(?:w|hp)\s*\d/.test(value)) return "w-beam";
    if (/^s\s*\d/.test(value)) return "s-beam";
    if (/^(?:c|mc)\s*\d/.test(value)) return "channel";
    if (/^l\s*\d/.test(value)) return "angle";
    if (/^(?:wt|st|mt)\s*\d/.test(value)) return "tee";
    if (/^(?:pipe|sch)\b/.test(value)) return "pipe";
    if (/^(?:fb|flat)\b/.test(value)) return "flat-bar";
    if (/^(?:sb|sq|square)\s*\d/.test(value)) return "square-bar";
    if (/^(?:rb|rd|round)\s*\d/.test(value)) return "round-bar";
    return null;
}

function classifyText(texts, primary) {
    const haystack = texts.filter(Boolean).join(" | ").toLowerCase();
    for (const rule of shapeRules.rules) {
        if (rule.match.trim() && haystack.includes(rule.match.trim().toLowerCase()) && allShapes().some(shape => shape.key === rule.family))
            return rule.family;
    }
    const type = (primary ?? "").toLowerCase();
    for (const [pattern, key] of defaultShapeRules) if (pattern.test(type)) return key;
    for (const text of texts) { const key = shapeFromDesignation(text); if (key) return key; }
    for (const [pattern, key] of defaultShapeRules) if (pattern.test(haystack)) return key;
    return "other";
}

const shapeCache = new WeakMap();
function shapeInfo(entry) {
    if (!entry || entry.category !== "weldment") return null;
    const cached = shapeCache.get(entry);
    if (cached && cached.version === shapeVersion) return cached;
    const profile = entry.profile ?? {};
    const sizeText = profile.size || entry.callout || "";
    const family = classifyText([profile.type, profile.size, profile.path, entry.callout, entry.name], profile.type);
    const schedule = sizeText.match(/\bsch(?:edule)?\.?\s*([a-z0-9]+)/i)?.[1] ?? sizeText.match(/\b(xxs|xs|std)\b/i)?.[1] ?? "";
    const numbers = sizeNumbers(sizeText.replace(/\bsch(?:edule)?\.?\s*[a-z0-9]+/ig, " ").replace(/\b(?:xxs|xs|std)\b/ig, " "));
    const metric = metricStandard(profile.standard);
    const dimension = number => number ? {value: number.value, metric} : null;
    const raw = number => number ? number.text : "";
    const fields = {standard: profile.standard ?? "", size: sizeText,
        size1: dimension(numbers[0]), size2: dimension(numbers[1]), size3: dimension(numbers[2])};
    if (["square-tube", "rect-tube", "angle"].includes(family)) {
        const square = numbers.length === 2;
        fields.side1 = dimension(numbers[0]);
        fields.side2 = dimension(square ? numbers[0] : numbers[1]);
        fields.wall = dimension(square ? numbers[1] : numbers[2]);
    } else if (family === "flat-bar") {
        const [a, b] = numbers;
        const wide = a && b && b.value > a.value ? b : a, thin = wide === a ? b : a;
        fields.side1 = dimension(wide);
        fields.wall = dimension(thin);
    } else if (family === "round-bar") {
        fields.diameter = dimension(numbers[0]);
    } else if (family === "square-bar") {
        fields.side1 = dimension(numbers[0]);
    } else if (family === "round-tube") {
        fields.od = dimension(numbers[0]);
        fields.wall = dimension(numbers[1]);
    } else if (family === "pipe") {
        if (schedule || numbers.length === 1) {
            fields.nps = raw(numbers[0]);
            fields.schedule = schedule;
        } else {
            fields.od = dimension(numbers[0]);
            fields.wall = dimension(numbers[1]);
        }
    } else if (["w-beam", "s-beam", "channel", "tee"].includes(family)) {
        fields.depth = raw(numbers[0]);
        fields.weight = raw(numbers[1]);
    }
    const info = {version: shapeVersion, family, fields, sizeText};
    shapeCache.set(entry, info);
    return info;
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function toFraction(value, denominator) {
    const sign = value < 0 ? "-" : "";
    let whole = Math.floor(Math.abs(value));
    let numerator = Math.round((Math.abs(value) - whole) * denominator);
    if (numerator === denominator) { whole++; numerator = 0; }
    if (!numerator) return sign + whole;
    const divisor = gcd(numerator, denominator);
    return sign + (whole ? whole + "-" : "") + numerator / divisor + "/" + denominator / divisor;
}
// Inches and millimeters each keep their own decimal places, so switching units shows that unit's setting.
function decimalsKey(profile) {
    return (profile.Units ?? "imperial") === "metric" ? "MetricDecimals" : "Decimals";
}
function decimalsFor(profile) {
    return decimalsKey(profile) === "MetricDecimals" ? (profile.MetricDecimals ?? 1) : (profile.Decimals ?? 3);
}
function useFractions(profile) {
    return (profile.Units ?? "imperial") !== "metric" && profile.Fractions === true;
}

// A profile dimension (wall, side, leg...): converted to the output units, then a fraction or a decimal
// with trailing zeros dropped (2, 0.25), following the leading-zero setting.
function formatDimension(value, metricSource, profile) {
    const metric = (profile.Units ?? "imperial") === "metric";
    let number = value;
    if (metricSource && !metric) number = value / 25.4;
    if (!metricSource && metric) number = value * 25.4;
    if (useFractions(profile)) return toFraction(number, profile.FractionDenominator || 16);
    const text = number.toFixed(decimalsFor(profile)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    return formatNumber(text, profile);
}

function shapeField(entry, key, profile) {
    const info = shapeInfo(entry);
    if (!info) return "";
    if (key === "profile") return shapeLabel(info.family);
    const value = info.fields[key];
    if (value == null) return "";
    return typeof value === "string" ? value : formatDimension(value.value, value.metric, profile);
}

// Measured {thickness}, {width} and {length}: decimals per the category, or inch fractions.
// Refuses to show a size more finely than SolidWorks reported it. When the add-in can't read a size exactly, it
// has SolidWorks' text, rounded to the part's decimal places; `entry.rounding` says by how much, in meters.
function checkRounding(entry, key, profile) {
    const rounded = entry.rounding?.[["thickness", "width", "length"].indexOf(key)] ?? 0;
    if (!(rounded > 0)) return;
    const wanted = useFractions(profile) ? 0.0254 / (profile.FractionDenominator || 16)
        : ((profile.Units ?? "imperial") === "metric" ? 0.001 : 0.0254) * Math.pow(10, -decimalsFor(profile));
    if (rounded > wanted * 1.000001)
        throw new Error("SolidWorks reports this item's {" + key + "} with fewer decimal places than this label uses. " +
            "Use fewer decimal places, or raise the part's decimal places for length in SolidWorks (Document Properties > Units).");
}

function measuredText(entry, key, profile) {
    const units = profile.Units ?? "imperial";
    if (useFractions(profile)) {
        const value = parseFloat(entry[key]?.imperial?.[8] ?? "");
        return Number.isFinite(value) ? toFraction(value, profile.FractionDenominator || 16) : "";
    }
    return formatNumber(entry[key]?.[units]?.[decimalsFor(profile)] ?? "", profile);
}

// ---------- Custom profile libraries ----------
function isDefaultLibrary(path) {
    return /[\\/]lang[\\/][^\\/]+[\\/]weldment profiles[\\/]?$/i.test(path ?? "");
}
function pendingLibrary() {
    const counts = new Map();
    for (const entry of shared.input?.entries ?? []) {
        const library = entry.profile?.library;
        if (!library || isDefaultLibrary(library) || shapeRules.libraries[library] || dismissedLibraries.has(library)) continue;
        counts.set(library, (counts.get(library) ?? 0) + 1);
    }
    const [first] = counts;
    return first ? {path: first[0], members: first[1]} : null;
}
function renderLibraryBanner() {
    const banner = $("#library-banner");
    const pending = shared.input ? pendingLibrary() : null;
    banner.hidden = !pending;
    if (!pending) return;
    banner.dataset.path = pending.path;
    $("#library-text").textContent = (pending.members === 1 ? "A weldment member uses" : pending.members + " weldment members use") +
        " profiles from a custom library (" + pending.path + "). Read its folder names so its shapes can be recognized?";
}
$("#library-read").addEventListener("click", async () => {
    const path = $("#library-banner").dataset.path;
    const reply = await finish("readLibrary", undefined, undefined, {LibraryPath: path, Settings: null});
    if (reply?.type !== "library") return;
    await saveLibraryChoice(path, {status: "read", shapes: reply.shapes.slice(0, 1000).map(shape => ({standard: shape.standard, type: shape.type}))});
    const unmatched = shapeRules.libraries[path].shapes.filter(shape => classifyText([shape.type], shape.type) === "other").length;
    renderLibraryBanner();
    setHostStatus("Read " + reply.shapes.length + " shapes from " + path + "." +
        (unmatched ? " " + unmatched + " weren't recognized; assign them in Settings > Weldment shapes." : ""), false);
});
$("#library-later").addEventListener("click", () => {
    dismissedLibraries.add($("#library-banner").dataset.path);
    renderLibraryBanner();
});
$("#library-never").addEventListener("click", async () => {
    await saveLibraryChoice($("#library-banner").dataset.path, {status: "declined"});
    renderLibraryBanner();
});

// ---------- Weldment shapes settings ----------
function shapeOptions(selected, includeOther = true) {
    return allShapes().filter(shape => includeOther || shape.key !== "other").map(shape => {
        const option = document.createElement("option");
        option.value = shape.key;
        option.textContent = shape.name;
        option.selected = shape.key === selected;
        return option;
    });
}
function cellWith(...children) {
    const cell = document.createElement("td");
    cell.append(...children);
    return cell;
}
function smallButton(text, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", action);
    return button;
}
// Assign a profile name to a shape: replaces any rule with the same text.
function assignShape(match, family) {
    const text = match.trim();
    if (!text) return;
    shapeRules.rules = shapeRules.rules.filter(rule => rule.match.trim().toLowerCase() !== text.toLowerCase());
    shapeRules.rules.unshift({match: text, family});
    saveShapeRules("Profiles containing “" + text + "” are now " + shapeByKey(family).name + ".");
}

function renderShapeSettings() {
    if (!shared.input || !$("#shapes-table")) return;
    // Shapes and the text {profile} inserts
    $("#shapes-table").replaceChildren(...allShapes().map(shape => {
        const row = document.createElement("tr");
        const label = document.createElement("input");
        label.value = shapeLabel(shape.key);
        label.setAttribute("aria-label", "Text {profile} inserts for " + shape.name);
        label.addEventListener("change", () => {
            shapeRules.labels[shape.key] = label.value;
            saveShapeRules("Updated the text for " + shape.name + ".");
        });
        const fields = shape.fields.length ? shape.fields.map(field => "{" + field + "}").join(" ") : "\u2014";
        const name = document.createElement("span");
        name.append(shapeIcon(shape.key), shape.name);
        row.append(cellWith(name), cellWith(label), cellWith(Object.assign(document.createElement("code"), {textContent: fields})),
            cellWith(shape.custom ? smallButton("Remove", () => {
                shapeRules.custom = shapeRules.custom.filter(item => item.key !== shape.key);
                shapeRules.rules = shapeRules.rules.filter(rule => rule.family !== shape.key);
                setShapeTemplate(shape.key, null);
                saveShapeRules("Removed " + shape.name + ".");
            }) : ""));
        return row;
    }));
    // Rules
    $("#rules-table").replaceChildren(...shapeRules.rules.map((rule, index) => {
        const row = document.createElement("tr");
        const family = document.createElement("select");
        family.append(...shapeOptions(rule.family));
        family.addEventListener("change", () => { rule.family = family.value; saveShapeRules("Updated the rule for “" + rule.match + "”."); });
        row.append(cellWith(Object.assign(document.createElement("code"), {textContent: rule.match})), cellWith(family),
            cellWith(smallButton("Remove", () => { shapeRules.rules.splice(index, 1); saveShapeRules("Removed the rule for “" + rule.match + "”."); })));
        return row;
    }));
    $("#rules-empty").hidden = shapeRules.rules.length > 0;
    $("#rule-family").replaceChildren(...shapeOptions("square-tube"));
    // Profiles used in this part
    const seen = new Map();
    for (const entry of shared.input.entries) {
        const info = shapeInfo(entry);
        if (!info) continue;
        const name = entry.profile?.type ? entry.profile.type + (entry.profile.size ? " — " + entry.profile.size : "") : (entry.callout || entry.name);
        if (!seen.has(name)) seen.set(name, {name, match: entry.profile?.type || entry.callout || entry.name, family: info.family, standard: entry.profile?.standard ?? ""});
    }
    const used = [...seen.values()].sort((a, b) => (a.family === "other" ? 0 : 1) - (b.family === "other" ? 0 : 1) || a.name.localeCompare(b.name));
    $("#part-profiles").replaceChildren(...used.map(item => {
        const row = document.createElement("tr");
        const family = document.createElement("select");
        family.append(...shapeOptions(item.family));
        family.addEventListener("change", () => assignShape(item.match, family.value));
        row.append(cellWith(item.name), cellWith(item.standard), cellWith(family));
        if (item.family === "other") row.className = "unassigned";
        return row;
    }));
    $("#part-profiles-empty").hidden = used.length > 0;
    // Libraries
    const libraries = Object.entries(shapeRules.libraries);
    $("#libraries").replaceChildren(...libraries.map(([path, library]) => {
        const block = document.createElement("div");
        block.className = "library";
        const head = document.createElement("div");
        head.className = "library-head";
        head.append(Object.assign(document.createElement("code"), {textContent: path}),
            Object.assign(document.createElement("span"), {className: "hint", textContent: library.status === "read" ? (library.shapes?.length ?? 0) + " shapes read" : "Not read"}),
            smallButton("Forget", async () => {
                dismissedLibraries.delete(path);
                const reply = await saveLibraryChoice(path, null);
                if (reply?.type === "shapes") $("#shape-status").textContent = "Forgot " + path + ". You'll be asked about it again.";
                renderLibraryBanner();
            }));
        block.append(head);
        if (library.status === "read" && library.shapes?.length) {
            const table = document.createElement("table");
            table.className = "grid compact";
            const body = table.createTBody();
            for (const shape of library.shapes) {
                const row = body.insertRow();
                const family = document.createElement("select");
                const detected = classifyText([shape.type], shape.type);
                family.append(...shapeOptions(detected));
                family.addEventListener("change", () => assignShape(shape.type, family.value));
                row.append(cellWith(shape.type), cellWith(shape.standard), cellWith(family));
                if (detected === "other") row.className = "unassigned";
            }
            block.append(table);
        }
        return block;
    }));
    $("#libraries-empty").hidden = libraries.length > 0;
}

$("#rule-add").addEventListener("click", () => {
    const text = $("#rule-match").value.trim();
    if (!text) { $("#shape-status").textContent = "Type the text a profile name contains."; return; }
    $("#rule-match").value = "";
    assignShape(text, $("#rule-family").value);
});
$("#shape-add").addEventListener("click", () => {
    const name = $("#shape-name").value.trim();
    if (!name) { $("#shape-status").textContent = "Type a name for the new shape."; return; }
    if (allShapes().some(shape => shape.name.toLowerCase() === name.toLowerCase())) { $("#shape-status").textContent = name + " already exists."; return; }
    const key = "custom-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Date.now().toString(36);
    shapeRules.custom.push({key, name});
    $("#shape-name").value = "";
    saveShapeRules("Added " + name + ". Add a rule so profiles are sorted into it.");
});

// ---------- Shape filter and templates ----------
function renderShapeFilters() {
    const bar = $("#shape-filters");
    bar.hidden = shared.filter !== "weldment";
    if (bar.hidden) return;
    const counts = new Map();
    shared.input.entries.forEach((entry, index) => {
        if (categoryOf(index) !== "weldment") return;
        const key = shapeInfo(entry).family;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    if (shared.shapeFilter !== "all" && !counts.has(shared.shapeFilter)) shared.shapeFilter = "all";
    const make = (key, text, count) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-pressed", String(shared.shapeFilter === key));
        button.append(...(key === "all" ? categoryIcon("all") : [shapeIcon(key)]));
        button.append(text, Object.assign(document.createElement("span"), {className: "count", textContent: count}));
        button.addEventListener("click", () => {
            shared.shapeFilter = key;
            if (key !== "all") setTemplateShape(key);
            buildRows();
        });
        return button;
    };
    bar.replaceChildren(make("all", "All shapes", [...counts.values()].reduce((a, b) => a + b, 0)),
        ...allShapes().filter(shape => counts.has(shape.key)).map(shape => make(shape.key, shape.name, counts.get(shape.key))));
}

function setTemplateShape(key) {
    shared.templateShape = key;
    setTemplateCategory("weldment");
    syncTemplateBar();
}

export { cellWith, checkRounding, decimalsFor, decimalsKey, isDefaultLibrary, loadShapeRules, measuredText, partShapeOptions, partShapes, renderLibraryBanner, renderShapeFilters, renderShapeSettings, setShapeTemplate, shapeByKey, shapeField, shapeIcon, shapeInfo, shapeOptions, shapeRules, shapeTemplates, shapeTokens };
