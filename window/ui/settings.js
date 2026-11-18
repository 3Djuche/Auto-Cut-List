const invoke = window.__TAURI__.core.invoke;
const $ = selector => document.querySelector(selector);

// ---------- Elements and state ----------
const description = $("#description");
const length = $("#length");
const decimals = $("#decimals");
const templateCategory = $("#template-category");
const caseChoices = [...document.querySelectorAll('input[name="case"]')];
const unitChoices = [...document.querySelectorAll('input[name="units"]')];
const zeroChoices = [...document.querySelectorAll('input[name="leading-zero"]')];
const fractionChoices = [...document.querySelectorAll('input[name="fractions"]')];
const fractionDenominator = $("#fraction-denominator");
const keepCaps = $("#keep-caps");
const gauge = $("#use-gauge");
const entries = $("#entries");
const apply = $("#apply");
const status = $("#status");
const save = $("#save");
const thumbnail = $("#thumbnail");
const panel = $("#settings-panel");
const labelPage = $("#label-page");
const selectAll = $("#select-all");
const searchBox = $("#search");
const changedOnlyBox = $("#changed-only");
const lockDescription = $("#lock-description");
const lockLength = $("#lock-length");
const itemCustom = $("#item-custom");
const names = {sheet: "Sheet Metal", weldment: "Weldment", part: "Regular Part"};
const tagNames = {sheet: "Sheet", weldment: "Weldment", part: "Part", custom: "Custom"};
const tokens = ["type", "thickness", "width", "length", "quantity", "gauge", "default", "shape", "material", "angle1", "angle2"];
let canUndo = false;

let input;
let busy = false;
let saveNoticeTimer;
let focused = -1;
let filter = "all";            // category shown in the table: all, sheet, weldment, part or custom
let templateKey = "sheet";     // category whose templates the Templates bar edits
let states = [];               // proposed labels and change state for every item
let templatesInvalid = null;   // category name whose templates don't render, if any
let customInvalid = false;
const customEntries = {};      // items labeled by hand: index -> {Description, Length}
const locksByEntry = {};       // unapplied lock changes: index -> {Description, Length}
const selection = new Set();   // items checked for Apply

function fieldLocks(index) {
    return locksByEntry[index] ?? input.entries[index]?.locks ?? {};
}
function categoryOf(index) {
    return customEntries[index] ? "custom" : input.entries[index].category;
}

// ---------- Shared label settings ----------
const shapeLabels = {BoxLabel: $("#box-label"), CylinderLabel: $("#cylinder-label")};
for (const [key, control] of Object.entries(shapeLabels)) {
    control.addEventListener("input", () => {
        input.settings.part[key] = control.value;
        refresh();
    });
}
const thumbnailOptions = {
    DisplayStyle: $("#display-style"),
    Shadows: $("#shadows"),
    Gloss: $("#gloss"),
    Cartoon: $("#cartoon"),
    Perspective: $("#perspective"),
    PartColors: $("#part-colors")
};
for (const [key, control] of Object.entries(thumbnailOptions)) {
    control.addEventListener("change", () => {
        const value = key === "DisplayStyle" ? control.value : control.checked;
        Object.values(input.settings).forEach(profile => { profile[key] = value; });
        drawThumbnail(input.entries[focused]);
    });
}
// Window themes: two light (White, Off-white) and two dark (Gray, Black). Both dark ones carry the
// "dark" class, which the preview and the dark-only styles key off; Gray adds "gray" to lighten it.
const themes = ["white", "offwhite", "gray", "black"];
const themeChoices = [...document.querySelectorAll('input[name="theme"]')];
function themeOf(profile) {
    return themes.includes(profile?.Theme) ? profile.Theme : profile?.DarkMode ? "black" : "white";
}
function applyTheme(theme) {
    const root = document.documentElement.classList;
    root.toggle("dark", theme === "gray" || theme === "black");
    root.toggle("gray", theme === "gray");
    root.toggle("offwhite", theme === "offwhite");
    for (const choice of themeChoices) choice.checked = choice.value === theme;
}
// Window font. Template boxes keep their monospace font so fields line up.
const fontChoice = $("#font-family");
const fonts = [...fontChoice.options].map(option => option.value);
for (const option of fontChoice.options) option.style.fontFamily = `"${option.value}"`;
function applyFont(font) {
    const name = fonts.includes(font) ? font : "Segoe UI";
    fontChoice.value = name;
    document.documentElement.style.setProperty("--font", `"${name}", "Segoe UI", system-ui, sans-serif`);
}
fontChoice.addEventListener("change", () => {
    applyFont(fontChoice.value);
    Object.values(input.settings).forEach(profile => { profile.Font = fontChoice.value; });
});

for (const choice of themeChoices) {
    choice.addEventListener("change", () => {
        if (!choice.checked) return;
        applyTheme(choice.value);
        Object.values(input.settings).forEach(profile => {
            profile.Theme = choice.value;
            profile.DarkMode = choice.value === "gray" || choice.value === "black";
        });
        drawThumbnail(input.entries[focused]);
    });
}
// "Use gauge" applies to sheet metal and regular parts alike.
gauge.addEventListener("change", () => {
    input.settings.sheet.UseGauge = input.settings.part.UseGauge = gauge.checked;
    refresh();
});

$("#open-settings").addEventListener("click", () => {
    if (!input) return;
    renderPresets();
    renderShapeSettings();
    labelPage.hidden = true;
    panel.hidden = false;
    $("#close-settings").focus();
});
$("#close-settings").addEventListener("click", () => {
    panel.hidden = true;
    labelPage.hidden = false;
    refresh();
    $("#open-settings").focus();
});

// Capitalization, units and leading zeros apply to every category, so keep each stored profile in step.
const caseModes = ["upper", "lower", "title"];
const unitModes = ["imperial", "metric"];
function setShared(key, value) {
    for (const profile of Object.values(input.settings)) profile[key] = value;
    if (key === "LeadingZero") for (const choice of zeroChoices) choice.checked = (choice.value === "yes") === value;
    else if (key === "Fractions") for (const choice of fractionChoices) choice.checked = (choice.value === "yes") === value;
    else if (key === "KeepCaps") keepCaps.checked = value;
    else if (key === "FractionDenominator") fractionDenominator.value = String(value);
    else for (const choice of key === "Case" ? caseChoices : unitChoices) choice.checked = choice.value === value;
    if (key === "Case") keepCaps.disabled = value !== "title";
    if (key === "Units" || key === "Fractions") {
        const metric = (input.settings.sheet.Units ?? "imperial") === "metric";
        for (const choice of fractionChoices) choice.disabled = metric;
        fractionDenominator.disabled = metric || !input.settings.sheet.Fractions;
        $("#fraction-note").hidden = !metric;
    }
}
// 0.500 or .500, per the shared setting.
function formatNumber(text, profile) {
    return profile.LeadingZero === false && text.startsWith("0.") ? text.slice(1) : text;
}
function sharedCase(profile) {
    if (caseModes.includes(profile.Case)) return profile.Case;
    return profile.Uppercase === false ? "title" : "upper";
}
// Only Latin letters change case, matching the add-in, so symbols such as µ, Ø, ° and ⌀ stay as typed.
function applyCase(text, mode, keepCaps) {
    if (mode === "upper") return text.replace(/[a-z\u00E0-\u00F6\u00F9-\u00FE]/g, letter => letter.toUpperCase());
    if (mode !== "title") return text.replace(/[A-Z\u00C0-\u00D6\u00D9-\u00DE]/g, letter => letter.toLowerCase());
    // Title case: capitalize each word. A word typed entirely in capitals (GA, TS, 2X2) can be left as it is.
    return text.replace(/[A-Za-z0-9\u00B5\u00C0-\u00FF']+/g, word => {
        if (keepCaps && /[A-Z\u00C0-\u00D6\u00D9-\u00DE]/.test(word) && !/[a-z\u00E0-\u00F6\u00F9-\u00FE]/.test(word)) return word;
        return word.replace(/[A-Z\u00C0-\u00D6\u00D9-\u00DE]/g, letter => letter.toLowerCase())
            .replace(/^[a-z\u00E0-\u00F6\u00F9-\u00FE]/, letter => letter.toUpperCase());
    });
}
for (const choice of caseChoices) choice.addEventListener("change", () => { if (choice.checked) { setShared("Case", choice.value); refresh(); } });
keepCaps.addEventListener("change", () => { setShared("KeepCaps", keepCaps.checked); refresh(); });
for (const choice of unitChoices) choice.addEventListener("change", () => { if (choice.checked) { setShared("Units", choice.value); refresh(); } });
for (const choice of zeroChoices) choice.addEventListener("change", () => { if (choice.checked) { setShared("LeadingZero", choice.value === "yes"); refresh(); } });
for (const choice of fractionChoices) choice.addEventListener("change", () => { if (choice.checked) { setShared("Fractions", choice.value === "yes"); refresh(); } });
fractionDenominator.addEventListener("change", () => { setShared("FractionDenominator", Number(fractionDenominator.value)); refresh(); });

// ---------- Gauge from thickness ----------
// Standard sheet gauges, in inches. A part whose thickness matches one is given that gauge when "Use gauge" is on and
// SolidWorks hasn't assigned one. Steel, galvanized and stainless are the Manufacturers' Standard Gauge tables;
// stainless stops at 7 GA (3/16 in) so thicker plate isn't called a gauge. Aluminum uses Brown & Sharpe gauge.
const gaugeTables = {
    steel: {3: 0.2391, 4: 0.2242, 5: 0.2092, 6: 0.1943, 7: 0.1793, 8: 0.1644, 9: 0.1495, 10: 0.1345, 11: 0.1196,
        12: 0.1046, 13: 0.0897, 14: 0.0747, 15: 0.0673, 16: 0.0598, 17: 0.0538, 18: 0.0478, 19: 0.0418, 20: 0.0359,
        21: 0.0329, 22: 0.0299, 23: 0.0269, 24: 0.0239, 25: 0.0209, 26: 0.0179, 27: 0.0164, 28: 0.0149, 29: 0.0135,
        30: 0.0120, 31: 0.0105, 32: 0.0097, 33: 0.0090, 34: 0.0082, 35: 0.0075, 36: 0.0067, 37: 0.0064, 38: 0.0060},
    galvanized: {8: 0.1681, 9: 0.1532, 10: 0.1382, 11: 0.1233, 12: 0.1084, 13: 0.0934, 14: 0.0785, 15: 0.0710,
        16: 0.0635, 17: 0.0575, 18: 0.0516, 19: 0.0456, 20: 0.0396, 21: 0.0366, 22: 0.0336, 23: 0.0306, 24: 0.0276,
        25: 0.0247, 26: 0.0217, 27: 0.0202, 28: 0.0187, 29: 0.0172, 30: 0.0157, 31: 0.0142, 32: 0.0134},
    stainless: {7: 0.1875, 8: 0.1719, 9: 0.1562, 10: 0.1406, 11: 0.1250, 12: 0.1094, 13: 0.0937, 14: 0.0781,
        15: 0.0703, 16: 0.0625, 17: 0.0562, 18: 0.0500, 19: 0.0437, 20: 0.0375, 21: 0.0344, 22: 0.0312, 23: 0.0281,
        24: 0.0250, 25: 0.0219, 26: 0.0187, 27: 0.0172, 28: 0.0156, 29: 0.0141, 30: 0.0125, 31: 0.0109, 32: 0.0102,
        33: 0.0094, 34: 0.0086, 35: 0.0078, 36: 0.0070, 37: 0.0066, 38: 0.0062},
    aluminum: {6: 0.1620, 7: 0.1443, 8: 0.1285, 9: 0.1144, 10: 0.1019, 11: 0.0907, 12: 0.0808, 13: 0.0720, 14: 0.0641, 15: 0.0571, 16: 0.0508, 17: 0.0453, 18: 0.0403, 19: 0.0359, 20: 0.0320, 21: 0.0285, 22: 0.0253, 23: 0.0226, 24: 0.0201, 25: 0.0179, 26: 0.0159, 27: 0.0142, 28: 0.0126, 29: 0.0113, 30: 0.0100}
};

// Which gauge table a material uses. Steel is the default, including parts with no material; materials that aren't
// sold by gauge in these tables (copper, brass, plastics...) get none.
function gaugeTableFor(material) {
    const text = (material ?? "").toLowerCase();
    // Aluminum first: SolidWorks' material names end in "(SS)" for many materials, which isn't stainless.
    if (/alumin|\b(?:1100|2024|3003|5052|5083|6061|6063|7075)\b/.test(text)) return "aluminum";
    if (/stainless|\b(?:30[1-9]|31[0-9]|321|347|410|420|430|440)\b|\b17-4\b/.test(text)) return "stainless";
    if (/galv|\bg[69]0\b|galvanneal|zinc[- ]coated/.test(text)) return "galvanized";
    if (/copper|brass|bronze|titanium|nickel|inconel|monel|plastic|nylon|acrylic|abs\b|pvc|delrin|acetal|uhmw|polycarbonate|rubber|wood|glass|foam/.test(text)) return null;
    return "steel";
}

// The standard gauge whose thickness matches this item's, within half a thousandth (plus any rounding SolidWorks
// applied to the size), such as "11 GA" for 0.1196 in steel. Blank when none matches.
function gaugeFromThickness(entry) {
    if ((entry.category !== "sheet" && entry.category !== "part") || entry.problem) return "";
    const material = gaugeTableFor(entry.material);
    // Stainless sheet is commonly sold at the steel gauge thicknesses (11 GA = 0.120 in) as well as the older
    // stainless table's (11 GA = 0.125 in), so stainless matches either.
    const tables = material === "stainless" ? [gaugeTables.stainless, gaugeTables.steel] : material ? [gaugeTables[material]] : [];
    const inches = parseFloat(entry.thickness?.imperial?.[8] ?? "");
    if (!tables.length || !(inches > 0)) return "";
    const tolerance = 0.0005 + (entry.rounding?.[0] ?? 0) / 0.0254 / 2;
    let best = null;
    for (const table of tables) for (const [gauge, size] of Object.entries(table)) {
        const off = Math.abs(size - inches);
        if (off <= tolerance && (!best || off < best.off)) best = {gauge, off};
    }
    return best ? best.gauge + " GA" : "";
}

// The gauge a label uses: the one SolidWorks assigned, or (with "Use gauge" on) the one matching the thickness.
function gaugeOf(entry, profile) {
    return entry.gauge || (profile.UseGauge ? gaugeFromThickness(entry) : "");
}

// ---------- Rendering labels ----------
function render(template, entry, profile) {
    if (!template.trim()) throw new Error("Enter a template for both properties.");
    const text = template.replace(/\{([^{}]+)\}|[{}]/g, (token, field) => {
        const key = field?.toLowerCase();
        if (!tokens.includes(key) && !shapeTokens.includes(key)) throw new Error("Unknown field: " + token);
        // Round regular parts have a diameter, measured across the cylinder (blank for other parts).
        if (key === "diameter" && entry.category !== "weldment") return entry.diameter ? measuredText(entry, "diameter", profile) : "";
        if (shapeTokens.includes(key)) return shapeField(entry, key, profile);
        if (key === "thickness" && profile.UseGauge && gaugeOf(entry, profile)) return gaugeOf(entry, profile);
        if (key === "gauge") return gaugeOf(entry, profile);
        if (key === "default") return entry.callout;
        if (key === "material") return entry.material ?? "";
        if (key === "angle1" || key === "angle2") return formatAngle(entry[key]);
        if (key === "shape" && entry.shape === "Box") return profile.BoxLabel ?? "Box";
        if (key === "shape" && entry.shape === "Cylinder") return profile.CylinderLabel ?? "Cylinder";
        if (["thickness", "width", "length"].includes(key)) {
            if (entry.problem) throw new Error("Can't measure this item: " + entry.problem.replace(/\.$/, "") + ". " + token +
                " isn't available, so label it by hand.");
            checkRounding(entry, key, profile);
            return measuredText(entry, key, profile);
        }
        return entry[key];
    });
    const formatted = (entry.category === "sheet" || entry.category === "part") && (profile.UseGauge || /\{gauge\}/i.test(template))
        ? text.replace(/(?<=\d)\s*(?:GA(?:UGE)?\s*)*GA(?:UGE)?\b/gi, " GA") : text;
    return applyCase(formatted, profile.Case, profile.KeepCaps !== false);
}

// An end-cut angle as SolidWorks reports it ("45.00\u00B0"), without trailing zeros or a unit: 45, 22.5.
function formatAngle(text) {
    const value = parseFloat(text ?? "");
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "";
}

// Proposed labels for one item and whether applying it would change anything.
function itemState(index) {
    return computeState(input.entries[index], customEntries[index], fieldLocks(index), index);
}

// The same, for any part's item: `custom` is its hand-typed labels (if any), `locks` its kept fields.
function computeState(entry, custom, locks, index) {
    const profile = input.settings[entry.category];
    const shape = shapeInfo(entry);
    const partShape = entry.category === "part" && partShapes.some(item => item.key === entry.shape) ? entry.shape : "";
    const template = custom ?? (shape && shapeTemplates()[shape.family]) ?? (partShape ? shapeTemplates("part")[partShape] : null) ?? profile;
    let description, length, error = "";
    try {
        description = locks.Description ? entry.currentDescription ?? "" : render(template.Description, entry, profile);
        length = locks.Length ? entry.currentLength ?? "" : render(template.Length, entry, profile);
    } catch (problem) {
        error = problem.message;
        description = entry.currentDescription ?? "";
        length = entry.currentLength ?? "";
    }
    const locksChanged = Boolean(locks.Description) !== Boolean(entry.locks?.Description) ||
        Boolean(locks.Length) !== Boolean(entry.locks?.Length);
    const customChanged = Boolean(custom) !== Boolean(entry.custom) ||
        Boolean(custom && (custom.Description !== entry.custom?.Description || custom.Length !== entry.custom?.Length));
    const labelsChanged = description !== (entry.currentDescription ?? "") || length !== (entry.currentLength ?? "");
    return {index, entry, description, length, locks, locksChanged, customChanged, error,
        changed: !error && (labelsChanged || customChanged || locksChanged)};
}

function measuredLength(entry) {
    if (entry.problem) return "—";
    const profile = input.settings[entry.category] ?? input.settings.part;
    return measuredText(entry, "length", profile) || "\u2014";
}

function unitLabel() {
    return (input.settings.sheet.Units ?? "imperial") === "metric" ? "mm" : "in";
}

// ---------- Table ----------
function visibleIndices() {
    const query = searchBox.value.trim().toLowerCase();
    return input.entries.map((entry, index) => index).filter(index => {
        if (filter !== "all" && categoryOf(index) !== filter) return false;
        if (filter === "weldment" && shapeFilter !== "all" && shapeInfo(input.entries[index])?.family !== shapeFilter) return false;
        const state = states[index];
        if (changedOnlyBox.checked && !(state.changed || state.error)) return false;
        if (!query) return true;
        const entry = input.entries[index];
        return [entry.name, state.description, state.length, entry.currentDescription, entry.currentLength]
            .some(value => (value ?? "").toLowerCase().includes(query));
    });
}

// Rebuild the rows (after loading, filtering or moving items between Custom and templates).
function buildRows() {
    if (!input) return;
    states = input.entries.map((entry, index) => itemState(index));
    const visible = visibleIndices();
    entries.replaceChildren(...visible.map(createRow));
    const note = $("#empty-note");
    note.hidden = visible.length > 0;
    note.textContent = !input.entries.length ? emptyListText() : "No items match the current filter.";
    if (!visible.includes(focused)) focusEntry(visible.length ? visible[0] : -1);
    refresh();
}

function createRow(index) {
    const entry = input.entries[index];
    const row = document.createElement("tr");
    row.dataset.index = index;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.setAttribute("aria-label", "Select " + entry.name);
    box.addEventListener("click", event => event.stopPropagation());
    box.addEventListener("change", () => {
        if (box.checked) selection.add(index);
        else selection.delete(index);
        updateSelection();
    });
    row.insertCell().append(box);
    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = entry.name;
    name.title = entry.name;
    row.insertCell().append(name);
    if (entry.problem) {
        const note = document.createElement("span");
        note.className = "unmeasured";
        note.textContent = "Can't measure";
        note.title = entry.problem;
        row.cells[1].append(note);
    }
    row.insertCell();                                                   // category
    const quantity = row.insertCell();
    quantity.className = "numeric";
    quantity.textContent = entry.quantity;
    row.insertCell().className = "numeric";                             // measured length
    row.insertCell();                                                   // Description
    row.insertCell();                                                   // Length label
    row.insertCell();                                                   // notes
    row.addEventListener("click", () => focusEntry(index));
    return row;
}

function fillLabelCell(cell, index, field) {
    const entry = input.entries[index];
    const state = states[index];
    const current = (field === "Description" ? entry.currentDescription : entry.currentLength) ?? "";
    const custom = customEntries[index];
    if (custom && !state.locks[field]) {
        // Items labeled by hand are edited right in the table.
        let editor = cell.querySelector("input");
        if (!editor) {
            editor = document.createElement("input");
            editor.className = "cell-editor";
            editor.spellcheck = false;
            editor.setAttribute("aria-label", field + " for " + entry.name);
            editor.addEventListener("click", event => event.stopPropagation());
            editor.addEventListener("focus", () => { if (focused !== index) focusEntry(index); });
            editor.addEventListener("input", () => {
                customEntries[index] = {...customEntries[index], [field]: editor.value};
                refresh();
            });
            cell.replaceChildren(editor);
        }
        if (document.activeElement !== editor) editor.value = custom[field];
        editor.classList.toggle("invalid", Boolean(state.error));
        editor.title = state.error || "Currently: " + (current || "(blank)");
        return;
    }
    const proposed = field === "Description" ? state.description : state.length;
    const parts = [];
    if (state.error && !state.locks[field]) {
        const error = document.createElement("span");
        error.className = "cell-error";
        error.textContent = entry.problem ? "Label by hand" : "Template error";
        error.title = state.error;
        parts.push(error);
    } else {
        const value = document.createElement("span");
        value.className = "label-value";
        value.textContent = proposed || "—";
        if (state.locks[field]) {
            value.classList.add("kept");
            value.title = "Kept: this field won't be changed";
        } else if (proposed !== current) {
            value.classList.add("changed");
            const was = document.createElement("span");
            was.className = "was";
            was.textContent = current || "was blank";
            if (!current) was.classList.add("blank");
            was.title = "Current value";
            parts.push(value, was);
        }
        if (!parts.length) parts.push(value);
    }
    cell.replaceChildren(...parts);
}

// Update every visible row in place, so a text box being typed in keeps its focus.
function updateRows() {
    for (const row of entries.rows) {
        const index = Number(row.dataset.index);
        const state = states[index];
        const entry = input.entries[index];
        const box = row.cells[0].firstChild;
        box.disabled = Boolean(state.error);
        if (state.error) selection.delete(index);
        box.checked = selection.has(index);
        const category = categoryOf(index);
        const tag = document.createElement("span");
        tag.className = "tag" + (category === "custom" ? " custom" : "");
        const family = category === "weldment" ? shapeByKey(shapeInfo(entry).family) : null;
        tag.replaceChildren(...(family ? [shapeIcon(family.key)] : categoryIcon(category === "custom" ? entry.category : category)),
            family ? family.short : tagNames[category]);
        tag.title = category === "custom" ? "Labeled by hand (" + names[entry.category] + ")" : family ? "Weldment: " + family.name : names[category];
        row.cells[2].replaceChildren(tag);
        row.cells[4].textContent = measuredLength(entry);
        fillLabelCell(row.cells[5], index, "Description");
        fillLabelCell(row.cells[6], index, "Length");
        const flags = [];
        if (entry.lengthLinked && !state.locks.Length) flags.push([{icon: "warning.svg", name: "Warning"}, "warning", "Length is linked to SolidWorks' cut length; applying replaces it with fixed text."]);
        if (entry.stale) flags.push(["\u21BB", "warning", "The model changed since this item was labeled."]);
        if (state.locks.Description || state.locks.Length) flags.push([{icon: "padlock.svg", name: "Locked"}, "", "Keeps its current " +
            [state.locks.Description && "Description", state.locks.Length && "Length"].filter(Boolean).join(" and ")]);
        row.cells[7].replaceChildren(...flags.map(([symbol, kind, title]) => {
            const flag = document.createElement("span");
            flag.className = "flag " + kind;
            // A flag is either a text symbol or an icon from ui/icons.
            if (typeof symbol === "string") flag.textContent = symbol;
            else {
                const image = document.createElement("img");
                image.src = "icons/" + symbol.icon;
                image.alt = symbol.name;
                flag.append(image);
            }
            flag.title = title;
            return flag;
        }));
        row.classList.toggle("focused", index === focused);
    }
    $("#length-heading").textContent = "Length (" + unitLabel() + ")";
}

function selectableShown() {
    return [...entries.rows].map(row => Number(row.dataset.index)).filter(index => states[index].changed);
}

function updateSelection() {
    const shown = selectableShown();
    const picked = shown.filter(index => selection.has(index)).length;
    selectAll.disabled = !shown.length;
    selectAll.checked = shown.length > 0 && picked === shown.length;
    selectAll.indeterminate = picked > 0 && picked < shown.length;
    const count = selection.size;
    $("#selection-count").textContent = count ? count + (count === 1 ? " item selected" : " items selected") :
        "Check the items to apply";
    $("#make-custom").disabled = busy || ![...selection].some(index => !customEntries[index]);
    $("#make-automatic").disabled = busy || ![...selection].some(index => customEntries[index]);
    apply.textContent = count ? "Apply " + count + (count === 1 ? " item" : " items") : "Apply";
    const brokenCustom = [...selection].some(index => customEntries[index] && states[index]?.error);
    apply.disabled = busy || !count || Boolean(templatesInvalid) || brokenCustom;
    // Say why Apply can't be used yet.
    apply.title = busy ? "Waiting for SolidWorks to finish the last request."
        : !count ? (shown.length ? "Check the items to apply in the table (or use the box in its header to check every changed item)."
            : "Nothing to apply: every item's labels already match the templates.")
        : templatesInvalid ? "Fix the " + (names[templatesInvalid] ?? templatesInvalid) + " templates first."
        : brokenCustom ? "A checked item labeled by hand has a problem. Fix its labels or uncheck it."
        : "";
}

selectAll.addEventListener("change", () => {
    for (const index of selectableShown()) {
        if (selectAll.checked) selection.add(index);
        else selection.delete(index);
    }
    updateRows();
    updateSelection();
});
searchBox.addEventListener("input", buildRows);
changedOnlyBox.addEventListener("change", buildRows);

// ---------- Category filter ----------
const filterKeys = ["all", "sheet", "weldment", "part", "custom"];
const filterLabels = {all: "All", sheet: "Sheet Metal", weldment: "Weldment", part: "Regular Part", custom: "Custom"};
// A small icon for each cut-list category (and All; none for Custom), shown on the filter buttons and the Type tags.
const categoryIcons = {all: "all.svg", sheet: "sheet-metal.svg", weldment: "weldment.svg", part: "folder.svg"};
// Full-color icons keep their colors on the dark themes; the one-color ones are lightened.
const coloredIcons = new Set(["all.svg", "folder.svg", "sheet-metal.svg", "weldment.svg"]);
function categoryIcon(key) {
    if (!categoryIcons[key]) return [];
    const image = document.createElement("img");
    image.className = "category-icon icon-" + key + (coloredIcons.has(categoryIcons[key]) ? " colored" : "");
    image.src = "icons/" + categoryIcons[key];
    image.alt = "";
    return [image];
}
const filterButtons = Object.fromEntries(filterKeys.map(key => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.filter = key;
    button.addEventListener("click", () => {
        filter = key;
        shapeFilter = "all";
        if (key !== "all" && key !== "custom") { setTemplateCategory(key); templateShape = ""; syncTemplateBar(); }
        buildRows();
    });
    return [key, button];
}));
$("#category-filters").replaceChildren(...Object.values(filterButtons));

function renderFilters() {
    const counts = {all: input.entries.length, sheet: 0, weldment: 0, part: 0, custom: 0};
    input.entries.forEach((entry, index) => counts[categoryOf(index)]++);
    for (const key of filterKeys) {
        const button = filterButtons[key];
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = counts[key];
        button.replaceChildren(...categoryIcon(key), filterLabels[key], count);
        button.setAttribute("aria-pressed", String(filter === key));
        button.hidden = key !== "all" && key !== filter && counts[key] === 0;
    }
}

// ---------- Details pane ----------
function renderDetails(redraw = true) {
    const entry = input?.entries[focused];
    $("#details-title").textContent = entry ? entry.name : "No item selected";
    $("#details-title").title = entry?.name ?? "";
    $("#details-options").hidden = !entry;
    $("#no-preview").hidden = Boolean(entry?.mesh?.length);
    if (redraw) drawThumbnail(entry);
    const facts = $("#details-facts");
    const problem = $("#details-problem");
    const linked = $("#details-linked");
    if (!entry) {
        facts.replaceChildren();
        problem.hidden = linked.hidden = $("#details-stale").hidden = true;
        return;
    }
    const profile = input.settings[entry.category];
    const units = unitLabel();
    const size = entry.problem ? "" : ["thickness", "width", "length"]
        .map(key => measuredText(entry, key, profile)).join(" \u00D7 ") + " " + units;
    const shape = shapeInfo(entry);
    const source = entry.profile ?? {};
    const rows = [
        ["Category", customEntries[focused] ? "Labeled by hand (" + names[entry.category] + ")" : names[entry.category]],
        ["Quantity", entry.quantity],
        ["Size", size],
        ["Shape", entry.category === "part" ? (entry.endCap ? "Plate (end cap)" : entry.shape) : shape ? shapeByKey(shape.family).name : ""],
        ["Diameter", entry.diameter ? measuredText(entry, "diameter", input.settings.part) + " " + unitLabel() : ""],
        ["Profile", shape ? [source.standard, source.type, shape.sizeText].filter(Boolean).join(" \u00B7 ") : ""],
        ["Library", source.library ? (isDefaultLibrary(source.library) ? "SolidWorks default" : source.library) : ""],
        ["Gauge", entry.gauge || (input.settings[entry.category]?.UseGauge && gaugeFromThickness(entry)
            ? gaugeFromThickness(entry) + " (matched from thickness, " + gaugeTableFor(entry.material) + " table)" : "")],
        ["Material", entry.material],
        ["End angles", [formatAngle(entry.angle1), formatAngle(entry.angle2)].filter(Boolean).map(angle => angle + "\u00B0").join(" and ")],
        ["Length from", entry.lengthSource]
    ].filter(([, value]) => value);
    facts.replaceChildren(...rows.flatMap(([label, value]) => {
        const term = document.createElement("dt");
        term.textContent = label;
        const detail = document.createElement("dd");
        detail.textContent = value;
        return [term, detail];
    }));
    problem.hidden = !entry.problem;
    problem.textContent = entry.problem ? "Can't measure: " + entry.problem.replace(/\.$/, "") + ". Label it by hand to type its Description and Length." : "";
    const locks = fieldLocks(focused);
    itemCustom.checked = Boolean(customEntries[focused]);
    lockDescription.checked = Boolean(locks.Description);
    lockLength.checked = Boolean(locks.Length);
    const stale = $("#details-stale");
    stale.hidden = !entry.stale;
    stale.textContent = entry.stale ? "The model changed since this item was labeled, so its labels may be out of date." +
        (states[focused]?.changed ? "" : " The templates still give the same labels; if it's labeled by hand or kept, check it.") : "";
    linked.hidden = !entry.lengthLinked;
    linked.textContent = entry.lengthLinked ? (locks.Length
        ? "Length stays linked to SolidWorks' cut length."
        : "Length is linked to SolidWorks' cut length. Applying replaces it with fixed text that won't update if the member changes. Check Keep current Length to keep the link.") : "";
}

itemCustom.addEventListener("change", () => { if (focused >= 0) setCustom([focused], itemCustom.checked); });
for (const control of [lockDescription, lockLength]) {
    control.addEventListener("change", () => {
        if (focused < 0) return;
        locksByEntry[focused] = {Description: lockDescription.checked, Length: lockLength.checked};
        refresh();
    });
}

// Label items by hand (Custom) or go back to the category templates.
function setCustom(indices, on) {
    for (const index of indices) {
        const entry = input.entries[index];
        if (on && !customEntries[index]) {
            // Unmeasured items start from their stored labels; others from what the template produces now.
            const state = states[index];
            customEntries[index] = entry.problem || state?.error
                ? {Description: entry.currentDescription ?? "", Length: entry.currentLength ?? ""}
                : {Description: state.description, Length: state.length};
        } else if (!on) delete customEntries[index];
    }
    buildRows();
    syncTemplateBar();
}
$("#make-custom").addEventListener("click", () => setCustom([...selection], true));
$("#make-automatic").addEventListener("click", () => setCustom([...selection], false));

function focusEntry(index) {
    if (focused !== index) view = defaultView();
    focused = index;
    const entry = input?.entries[index];
    if (entry && !customEntries[index]) {
        setTemplateCategory(entry.category);
        templateShape = entry.category === "weldment" ? shapeInfo(entry).family
            : entry.category === "part" && partShapes.some(item => item.key === entry.shape) ? entry.shape : "";
    }
    for (const row of entries.rows) row.classList.toggle("focused", Number(row.dataset.index) === index);
    renderDetails(true);
    syncTemplateBar();
}

// ---------- Templates bar ----------
// Edits the category templates, or, when the selected item is labeled by hand, that item's own labels.
function setTemplateCategory(key) {
    templateKey = key;
    templateCategory.value = key;
}

function customMode() {
    return focused >= 0 && Boolean(customEntries[focused]);
}

function syncTemplateBar() {
    if (!input) return;
    const own = customMode();
    $("#templates-title").textContent = own ? "Labels for " + input.entries[focused].name + " (by hand)" : "Templates";
    templateCategory.hidden = own;
    $("#reset").hidden = own;
    decimals.hidden = $(".decimals-label").hidden = own;
    const shapeSelect = $("#template-shape");
    const shapes = !own && (templateKey === "weldment" || templateKey === "part");
    const everything = templateKey === "part" ? "All regular parts" : "All weldments";
    shapeSelect.hidden = !shapes;
    if (shapes) {
        const general = document.createElement("option");
        general.value = "";
        general.textContent = everything;
        shapeSelect.replaceChildren(general, ...(templateKey === "part" ? partShapeOptions(templateShape) : shapeOptions(templateShape)));
        shapeSelect.value = templateShape;
    }
    const ownShape = shapes && templateShape ? shapeTemplates(templateKey)[templateShape] : null;
    $("#shape-hint").hidden = !(shapes && templateShape && !ownShape);
    $("#shape-hint").textContent = "Uses the " + everything + " template until you edit it";
    $("#shape-reset").textContent = "Use " + everything + " template";
    $("#shape-reset").hidden = !ownShape;
    const source = own ? customEntries[focused] : ownShape ?? input.settings[templateKey];
    if (document.activeElement !== description) description.value = source.Description;
    if (document.activeElement !== length) length.value = source.Length;
    if (!own) decimals.value = String(input.settings[templateKey].Decimals);
}

templateCategory.addEventListener("change", () => {
    setTemplateCategory(templateCategory.value);
    templateShape = "";
    syncTemplateBar();
});
$("#template-shape").addEventListener("change", () => {
    templateShape = $("#template-shape").value;
    syncTemplateBar();
});
$("#shape-reset").addEventListener("click", () => {
    setShapeTemplate(templateShape, null, templateKey);
    description.blur();
    length.blur();
    syncTemplateBar();
    refresh();
});
for (const control of [description, length, decimals]) {
    control.addEventListener("input", () => {
        if (!input) return;
        if (customMode()) {
            customEntries[focused] = {Description: description.value, Length: length.value};
        } else if ((templateKey === "weldment" || templateKey === "part") && templateShape) {
            // Editing a shape's templates gives it its own; decimal places stay shared by the whole category.
            if (control !== decimals) setShapeTemplate(templateShape, {Description: description.value, Length: length.value}, templateKey);
            input.settings[templateKey].Decimals = Number(decimals.value);
            $("#shape-hint").hidden = true;
            $("#shape-reset").hidden = !shapeTemplates(templateKey)[templateShape];
        } else {
            input.settings[templateKey] = {...input.settings[templateKey],
                Description: description.value, Length: length.value, Decimals: Number(decimals.value)};
        }
        refresh();
    });
}
$("#reset").addEventListener("click", () => {
    if (!input) return;
    const defaults = input.defaults[templateKey];
    input.settings[templateKey] = {...input.settings[templateKey],
        Description: defaults.Description, Length: defaults.Length, Decimals: defaults.Decimals};
    if (templateKey === "part") {
        Object.assign(input.settings.part, {BoxLabel: defaults.BoxLabel, CylinderLabel: defaults.CylinderLabel});
        for (const [key, control] of Object.entries(shapeLabels)) control.value = input.settings.part[key];
    }
    description.blur();
    length.blur();
    syncTemplateBar();
    refresh();
});

// Recompute proposed labels after any edit and update the table, details and buttons in place.
function refresh() {
    if (!input || busy) return;
    states = input.entries.map((entry, index) => itemState(index));
    const sample = {type: "", thickness: [], width: [], length: [], quantity: "", gauge: "", callout: "", shape: ""};
    templatesInvalid = Object.keys(names).find(key => {
        const settings = input.settings[key];
        try {
            render(settings.Description, sample, settings);
            render(settings.Length, sample, settings);
            return false;
        } catch {
            return true;
        }
    }) ?? null;
    if (!templatesInvalid) {
        const sampleWeld = {...sample, category: "weldment"};
        const broken = Object.values(shapeTemplates()).some(template => {
            try { render(template.Description, sampleWeld, input.settings.weldment); render(template.Length, sampleWeld, input.settings.weldment); return false; }
            catch { return true; }
        });
        if (broken) templatesInvalid = "weldment";
    }
    if (!templatesInvalid) {
        const samplePart = {...sample, category: "part"};
        const broken = Object.values(shapeTemplates("part")).some(template => {
            try { render(template.Description, samplePart, input.settings.part); render(template.Length, samplePart, input.settings.part); return false; }
            catch { return true; }
        });
        if (broken) templatesInvalid = "part";
    }
    customInvalid = Object.keys(customEntries).some(index => states[index]?.error && !input.entries[index].problem);
    updateRows();
    updateSelection();
    renderFilters();
    renderShapeFilters();
    renderLibraryBanner();
    renderDetails(false);
    syncTemplateBar();
    updatePresetIndicator();
    save.disabled = Boolean(templatesInvalid);
    $("#undo").hidden = !canUndo;
    const own = customMode() ? states[focused]?.error : "";
    status.textContent = templatesInvalid ? "Check the " + names[templatesInvalid] + " templates: " + templateError(templatesInvalid)
        : own ? own
        : customInvalid ? "Check the labels of items labeled by hand." : "";
}

function templateError(key) {
    const sample = {type: "", thickness: [], width: [], length: [], quantity: "", gauge: "", callout: "", shape: ""};
    try { render(input.settings[key].Description, sample, input.settings[key]); render(input.settings[key].Length, sample, input.settings[key]); return ""; }
    catch (error) { return error.message; }
}

apply.addEventListener("click", () => {
    if (apply.disabled) return;
    const chosen = [...selection].sort((a, b) => a - b);
    const Labels = Object.fromEntries(chosen.map(index => [index, {Description: states[index].description, Length: states[index].length}]));
    finish("apply", chosen, undefined, {Labels});
});

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
let shapeFilter = "all";
let templateShape = "";
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
    input.settings.weldment.ShapeRules = JSON.stringify(shapeRules);
    shapeVersion++;
    buildRows();
    renderShapeSettings();
    if (message) $("#shape-status").textContent = message + " Click Save settings to keep it.";
    return Promise.resolve(null);
}

// The shape rules as last saved. Answers to the custom-library prompt are kept straight away (they answer a
// question rather than try out a setting), so they're written into the saved rules without the unsaved changes.
let savedShapeRules = "";
async function saveLibraryChoice(path, choice) {
    if (choice) shapeRules.libraries[path] = choice;
    else delete shapeRules.libraries[path];
    input.settings.weldment.ShapeRules = JSON.stringify(shapeRules);
    shapeVersion++;
    buildRows();
    renderShapeSettings();
    let saved = {};
    try { saved = savedShapeRules ? JSON.parse(savedShapeRules) : {}; } catch { saved = {}; }
    saved.libraries = {...(saved.libraries ?? {})};
    if (choice) saved.libraries[path] = choice;
    else delete saved.libraries[path];
    const json = JSON.stringify(saved);
    const reply = await finish("shapes", undefined, undefined, {ShapeRules: json, Settings: null});
    if (reply?.type === "shapes") savedShapeRules = json;
    return reply;
}

// Templates of their own for weldment shapes, and for regular parts' Box and Cylinder shapes.
function shapeTemplates(category = "weldment") {
    try { return JSON.parse(input.settings[category].ShapeTemplates || "{}") ?? {}; } catch { return {}; }
}
function setShapeTemplate(key, template, category = "weldment") {
    const templates = shapeTemplates(category);
    if (template) templates[key] = {Description: template.Description, Length: template.Length};
    else delete templates[key];
    input.settings[category].ShapeTemplates = JSON.stringify(templates);
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
    const text = number.toFixed(profile.Decimals ?? 3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
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
        : ((profile.Units ?? "imperial") === "metric" ? 0.001 : 0.0254) * Math.pow(10, -(profile.Decimals ?? 3));
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
    return formatNumber(entry[key]?.[units]?.[profile.Decimals] ?? "", profile);
}

// ---------- Custom profile libraries ----------
function isDefaultLibrary(path) {
    return /[\\/]lang[\\/][^\\/]+[\\/]weldment profiles[\\/]?$/i.test(path ?? "");
}
function pendingLibrary() {
    const counts = new Map();
    for (const entry of input?.entries ?? []) {
        const library = entry.profile?.library;
        if (!library || isDefaultLibrary(library) || shapeRules.libraries[library] || dismissedLibraries.has(library)) continue;
        counts.set(library, (counts.get(library) ?? 0) + 1);
    }
    const [first] = counts;
    return first ? {path: first[0], members: first[1]} : null;
}
function renderLibraryBanner() {
    const banner = $("#library-banner");
    const pending = input ? pendingLibrary() : null;
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
    if (!input || !$("#shapes-table")) return;
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
    for (const entry of input.entries) {
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
    bar.hidden = filter !== "weldment";
    if (bar.hidden) return;
    const counts = new Map();
    input.entries.forEach((entry, index) => {
        if (categoryOf(index) !== "weldment") return;
        const key = shapeInfo(entry).family;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    if (shapeFilter !== "all" && !counts.has(shapeFilter)) shapeFilter = "all";
    const make = (key, text, count) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-pressed", String(shapeFilter === key));
        button.append(...(key === "all" ? categoryIcon("all") : [shapeIcon(key)]));
        button.append(text, Object.assign(document.createElement("span"), {className: "count", textContent: count}));
        button.addEventListener("click", () => {
            shapeFilter = key;
            if (key !== "all") setTemplateShape(key);
            buildRows();
        });
        return button;
    };
    bar.replaceChildren(make("all", "All shapes", [...counts.values()].reduce((a, b) => a + b, 0)),
        ...allShapes().filter(shape => counts.has(shape.key)).map(shape => make(shape.key, shape.name, counts.get(shape.key))));
}

function setTemplateShape(key) {
    templateShape = key;
    setTemplateCategory("weldment");
    syncTemplateBar();
}

// ---------- Insert symbol ----------
// Puts a symbol at the cursor in the last Description or Length box used (the Templates bar or a table cell).
const symbols = [
    ["⌀", "Diameter"], ["Ø", "Diameter (O with stroke)"], ["°", "Degree"], ["±", "Plus or minus"],
    ["×", "Times"], ["″", "Inch (double prime)"], ["′", "Foot (prime)"], ["²", "Squared"],
    ["³", "Cubed"], ["≤", "Less than or equal to"], ["≥", "Greater than or equal to"],
    ["≈", "Approximately"], ["µ", "Micro"], ["½", "One half"], ["¼", "One quarter"], ["¾", "Three quarters"]
];
let lastTextField = null;
document.addEventListener("focusin", event => {
    const field = event.target;
    if (field === description || field === length || field.classList?.contains("cell-editor")) lastTextField = field;
});
function insertSymbol(symbol) {
    let field = lastTextField;
    if (!field || !field.isConnected || field.disabled || field.closest("[hidden]")) field = description;
    const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
    field.value = field.value.slice(0, start) + symbol + field.value.slice(end);
    field.focus();
    field.setSelectionRange(start + symbol.length, start + symbol.length);
    field.dispatchEvent(new Event("input", {bubbles: true}));
}
$("#symbol-buttons").replaceChildren(...symbols.map(([symbol, name]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = symbol;
    button.title = name;
    button.setAttribute("aria-label", "Insert " + name);
    // Keep the cursor in the text box.
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => insertSymbol(symbol));
    return button;
}));
$("#symbols-toggle").addEventListener("mousedown", event => event.preventDefault());
$("#symbols-toggle").addEventListener("click", () => {
    const bar = $("#symbol-buttons");
    bar.hidden = !bar.hidden;
    $("#symbols-toggle").setAttribute("aria-expanded", String(!bar.hidden));
});

// ---------- Body preview ----------
// WebGL renderer: depth-buffered, smooth-shaded within each SolidWorks face, real model edges from face
// boundaries plus silhouettes of curved faces. Falls back to a simple 2D painter if WebGL is unavailable.

const geometryCache = new WeakMap();
function geometry(entry) {
    if (geometryCache.has(entry)) return geometryCache.get(entry);
    const values = entry.mesh;
    const triangleCount = Math.floor(values.length / 9);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < triangleCount * 9; i++) {
        const axis = i % 3;
        if (values[i] < min[axis]) min[axis] = values[i];
        if (values[i] > max[axis]) max[axis] = values[i];
    }
    const center = min.map((value, axis) => (value + max[axis]) / 2);
    const radius = Math.hypot(...min.map((value, axis) => (max[axis] - value) / 2)) || 1;

    // Which SolidWorks face each triangle came from (older data: every triangle its own face).
    const faceOf = new Int32Array(triangleCount);
    const hasFaces = Array.isArray(entry.meshFaces) && entry.meshFaces.length > 0;
    let t = 0;
    if (hasFaces) entry.meshFaces.forEach((count, face) => { for (let i = 0; i < count && t < triangleCount; i++) faceOf[t++] = face; });
    for (; t < triangleCount; t++) faceOf[t] = -1 - t;

    const points = new Float32Array(triangleCount * 9);
    for (let i = 0; i < triangleCount * 9; i++) points[i] = (values[i] - center[i % 3]) / radius;

    const ids = new Map(), vertexId = new Int32Array(triangleCount * 3), triangleNormal = new Float32Array(triangleCount * 3);
    const smooth = new Map();
    for (let tri = 0; tri < triangleCount; tri++) {
        for (let k = 0; k < 3; k++) {
            const o = tri * 9 + k * 3;
            const key = Math.round(points[o] * 1e5) + "," + Math.round(points[o + 1] * 1e5) + "," + Math.round(points[o + 2] * 1e5);
            if (!ids.has(key)) ids.set(key, ids.size);
            vertexId[tri * 3 + k] = ids.get(key);
        }
        const o = tri * 9;
        const ux = points[o + 3] - points[o], uy = points[o + 4] - points[o + 1], uz = points[o + 5] - points[o + 2];
        const vx = points[o + 6] - points[o], vy = points[o + 7] - points[o + 1], vz = points[o + 8] - points[o + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        triangleNormal.set([nx, ny, nz], tri * 3);
        for (let k = 0; k < 3; k++) {
            const key = vertexId[tri * 3 + k] + ":" + faceOf[tri];
            const sum = smooth.get(key) ?? [0, 0, 0];
            sum[0] += nx; sum[1] += ny; sum[2] += nz;
            smooth.set(key, sum);
        }
    }

    // The part's SolidWorks colors: one per face (faces painted on their own), else the body's or part's.
    const faceColors = hasFaces && Array.isArray(entry.meshColors) && entry.meshColors.length >= entry.meshFaces.length * 3
        ? entry.meshColors : null;
    const bodyColor = Array.isArray(entry.color) && entry.color.length >= 3 ? entry.color : null;
    const hasColor = Boolean(faceColors || bodyColor);
    const colorOf = tri => {
        const face = faceOf[tri];
        if (faceColors && face >= 0) return [faceColors[face * 3], faceColors[face * 3 + 1], faceColors[face * 3 + 2]];
        return bodyColor ?? [0.7, 0.76, 0.83];
    };

    // Interleaved position + normal + color for drawArrays.
    const vertices = new Float32Array(triangleCount * 27);
    for (let tri = 0; tri < triangleCount; tri++) {
        const color = colorOf(tri);
        for (let k = 0; k < 3; k++) {
            const n = smooth.get(vertexId[tri * 3 + k] + ":" + faceOf[tri]);
            const length = Math.hypot(n[0], n[1], n[2]) || 1;
            const o = (tri * 3 + k) * 9, p = tri * 9 + k * 3;
            vertices.set([points[p], points[p + 1], points[p + 2], n[0] / length, n[1] / length, n[2] / length,
                color[0], color[1], color[2]], o);
        }
    }

    // Edges: model edges (face boundaries, open edges) are always drawn; edges inside one curved face
    // are silhouette candidates, drawn when the surface turns away from the viewer.
    const edges = new Map();
    for (let tri = 0; tri < triangleCount; tri++) {
        for (let k = 0; k < 3; k++) {
            const a = vertexId[tri * 3 + k], b = vertexId[tri * 3 + (k + 1) % 3];
            if (a === b) continue;
            const key = a < b ? a + "," + b : b + "," + a;
            let edge = edges.get(key);
            if (!edge) {
                edge = {from: tri * 9 + k * 3, to: tri * 9 + ((k + 1) % 3) * 3, triangles: []};
                edges.set(key, edge);
            }
            edge.triangles.push(tri);
        }
    }
    const feature = [], candidates = [];
    const angleOf = (a, b) => {
        const na = triangleNormal.subarray(a * 3, a * 3 + 3), nb = triangleNormal.subarray(b * 3, b * 3 + 3);
        return (na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]) / ((Math.hypot(...na) * Math.hypot(...nb)) || 1);
    };
    for (const edge of edges.values()) {
        const [a, b] = edge.triangles;
        if (edge.triangles.length !== 2) feature.push(edge);
        else if (faceOf[a] !== faceOf[b]) { if (hasFaces || angleOf(a, b) < 0.9) feature.push(edge); }
        else if (angleOf(a, b) < 0.99999) candidates.push(edge);
    }
    const result = {points, vertices, triangleCount, triangleNormal, feature, candidates, hasColor, buffers: null};
    geometryCache.set(entry, result);
    return result;
}

const shaderSource = {
    project: `
        uniform mat3 rotation; uniform vec2 pan; uniform vec2 scale; uniform float perspective;
        vec4 project(vec3 position) {
            vec3 v = rotation * position;
            v.xy += pan;
            float w = perspective > 0.5 ? (3.0 - v.z) / 3.0 : 1.0;
            return vec4(v.x * scale.x, v.y * scale.y, -v.z * 0.3 * w, w);
        }`,
    meshVertex: `
        attribute vec3 position; attribute vec3 normal; attribute vec3 color;
        varying vec3 viewNormal; varying vec3 surface;
        void main() { viewNormal = rotation * normal; surface = color; gl_Position = project(position); }`,
    meshFragment: `
        precision mediump float;
        varying vec3 viewNormal; varying vec3 surface;
        uniform vec3 baseColor; uniform float useColor;
        uniform vec3 sky; uniform vec3 ground; uniform float gloss; uniform float toon;
        void main() {
            vec3 n = normalize(viewNormal);
            if (n.z < 0.0) n = -n;
            // A key light just above-left of the viewer gives top, left and right faces three distinct tones.
            vec3 key = normalize(vec3(-0.25, 0.2, 0.95));
            vec3 fill = normalize(vec3(0.6, 0.3, 0.4));
            float diffuse = max(dot(n, key), 0.0);
            float fillLight = max(dot(n, fill), 0.0) * 0.06;
            float rim = pow(1.0 - n.z, 3.0) * 0.18;
            if (toon > 0.5) { diffuse = floor(diffuse * 3.0 + 0.4) / 3.0; fillLight = 0.0; rim = 0.0; }
            vec3 ambient = mix(ground, sky, n.y * 0.5 + 0.5);
            vec3 halfway = normalize(key + vec3(0.0, 0.0, 1.0));
            float specular = pow(max(dot(n, halfway), 0.0), gloss > 0.5 ? 70.0 : 22.0) * (gloss > 0.5 ? 0.6 : 0.1);
            if (toon > 0.5) specular = specular > 0.3 ? 0.35 : 0.0;
            // SolidWorks appearance colors are display colors; shade them so their hue stays recognizable.
            vec3 albedo = mix(baseColor, surface, useColor);
            vec3 color = albedo * (ambient + diffuse * 0.6 + fillLight) + vec3(specular + rim);
            gl_FragColor = vec4(min(color, vec3(1.0)), 1.0);
        }`,
    lineVertex: `
        attribute vec3 from; attribute vec3 to; attribute vec2 corner;
        uniform vec2 viewport; uniform float width; uniform float lift;
        void main() {
            vec4 a = project(from), b = project(to);
            vec2 sa = a.xy / a.w * viewport * 0.5, sb = b.xy / b.w * viewport * 0.5;
            vec2 direction = sb - sa;
            float length = length(direction);
            direction = length > 0.0001 ? direction / length : vec2(1.0, 0.0);
            vec2 side = vec2(-direction.y, direction.x);
            vec4 p = corner.x < 0.5 ? a : b;
            vec2 offset = side * corner.y * width * 0.5 + direction * (corner.x < 0.5 ? -0.5 : 0.5) * width * 0.5;
            p.xy += offset / (viewport * 0.5) * p.w;
            p.z -= lift * p.w;
            gl_Position = p;
        }`,
    lineFragment: `precision mediump float; uniform vec4 color; void main() { gl_FragColor = color; }`
};

const renderer = (() => {
    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl", {antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true});
        if (!gl) return null;
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
            return shader;
        };
        const program = (vertex, fragment) => {
            const result = gl.createProgram();
            gl.attachShader(result, compile(gl.VERTEX_SHADER, shaderSource.project + vertex));
            gl.attachShader(result, compile(gl.FRAGMENT_SHADER, fragment));
            gl.linkProgram(result);
            if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
            return result;
        };
        return {canvas, gl, mesh: program(shaderSource.meshVertex, shaderSource.meshFragment),
            line: program(shaderSource.lineVertex, shaderSource.lineFragment), lines: gl.createBuffer()};
    } catch {
        return null;
    }
})();

const lineCorners = [[0, -1], [0, 1], [1, -1], [0, 1], [1, 1], [1, -1]];
function lineData(points, edges) {
    const data = new Float32Array(edges.length * 48);
    let o = 0;
    for (const edge of edges) {
        for (const [end, side] of lineCorners) {
            data[o++] = points[edge.from]; data[o++] = points[edge.from + 1]; data[o++] = points[edge.from + 2];
            data[o++] = points[edge.to]; data[o++] = points[edge.to + 1]; data[o++] = points[edge.to + 2];
            data[o++] = end; data[o++] = side;
        }
    }
    return data;
}

const defaultView = () => ({yaw: -Math.PI / 4, pitch: 0.6155, zoom: 1, panX: 0, panY: 0});
let view = defaultView();

// Rows of Rx(pitch) * Ry(yaw): Y is up, as in SolidWorks.
function rotationRows(currentView) {
    const cy = Math.cos(currentView.yaw), sy = Math.sin(currentView.yaw);
    const cp = Math.cos(currentView.pitch), sp = Math.sin(currentView.pitch);
    return [[cy, 0, sy], [-sp * -sy, cp, -sp * cy], [cp * -sy, sp, cp * cy]];
}

function renderWebGL(entry, width, height, currentView, options) {
    const {gl, canvas, mesh: meshProgram, line: lineProgram} = renderer;
    const shape = geometry(entry);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    if (!shape.buffers) {
        const vertices = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
        gl.bufferData(gl.ARRAY_BUFFER, shape.vertices, gl.STATIC_DRAW);
        const feature = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, feature);
        gl.bufferData(gl.ARRAY_BUFFER, lineData(shape.points, shape.feature), gl.STATIC_DRAW);
        shape.buffers = {vertices, feature};
    }

    const rows = rotationRows(currentView);
    const matrix = new Float32Array([rows[0][0], rows[1][0], rows[2][0], rows[0][1], rows[1][1], rows[2][1], rows[0][2], rows[1][2], rows[2][2]]);
    const fit = currentView.zoom * (options.Perspective ? 0.88 : 0.97);
    const small = Math.min(width, height);
    const setCommon = program => {
        gl.useProgram(program);
        gl.uniformMatrix3fv(gl.getUniformLocation(program, "rotation"), false, matrix);
        gl.uniform2f(gl.getUniformLocation(program, "pan"), currentView.panX, currentView.panY);
        gl.uniform2f(gl.getUniformLocation(program, "scale"), fit * small / width, fit * small / height);
        gl.uniform1f(gl.getUniformLocation(program, "perspective"), options.Perspective ? 1 : 0);
    };
    const dark = document.documentElement.classList.contains("dark");
    const style = options.DisplayStyle ?? "edges";

    if (style !== "wireframe") {
        setCommon(meshProgram);
        gl.uniform3fv(gl.getUniformLocation(meshProgram, "baseColor"), dark ? [0.6, 0.67, 0.75] : [0.7, 0.76, 0.83]);
        gl.uniform1f(gl.getUniformLocation(meshProgram, "useColor"), shape.hasColor && options.PartColors !== false ? 1 : 0);
        gl.uniform3fv(gl.getUniformLocation(meshProgram, "sky"), [0.56, 0.56, 0.58]);
        gl.uniform3fv(gl.getUniformLocation(meshProgram, "ground"), [0.34, 0.34, 0.36]);
        gl.uniform1f(gl.getUniformLocation(meshProgram, "gloss"), options.Gloss ? 1 : 0);
        gl.uniform1f(gl.getUniformLocation(meshProgram, "toon"), options.Cartoon ? 1 : 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, shape.buffers.vertices);
        const position = gl.getAttribLocation(meshProgram, "position"), normal = gl.getAttribLocation(meshProgram, "normal");
        const color = gl.getAttribLocation(meshProgram, "color");
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 36, 0);
        gl.enableVertexAttribArray(normal);
        gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, 36, 12);
        gl.enableVertexAttribArray(color);
        gl.vertexAttribPointer(color, 3, gl.FLOAT, false, 36, 24);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1, 1);
        gl.drawArrays(gl.TRIANGLES, 0, shape.triangleCount * 3);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.disableVertexAttribArray(position);
        gl.disableVertexAttribArray(normal);
        gl.disableVertexAttribArray(color);
    }

    const drawEdges = style !== "shaded" || options.Cartoon;
    if (!drawEdges) return;
    // Silhouettes of curved faces for the current view.
    const z = rows[2];
    const silhouette = shape.candidates.filter(edge => {
        const [a, b] = edge.triangles, n = shape.triangleNormal;
        const za = z[0] * n[a * 3] + z[1] * n[a * 3 + 1] + z[2] * n[a * 3 + 2];
        const zb = z[0] * n[b * 3] + z[1] * n[b * 3 + 1] + z[2] * n[b * 3 + 2];
        return za * zb <= 0;
    });
    setCommon(lineProgram);
    const scale = width / 448;
    gl.uniform2f(gl.getUniformLocation(lineProgram, "viewport"), width, height);
    gl.uniform1f(gl.getUniformLocation(lineProgram, "width"), (options.Cartoon ? 2.6 : 1.3) * Math.max(1, scale));
    gl.uniform1f(gl.getUniformLocation(lineProgram, "lift"), style === "wireframe" ? 0 : 0.0015);
    gl.uniform4fv(gl.getUniformLocation(lineProgram, "color"), dark && style === "wireframe" ? [0.78, 0.86, 0.94, 1] : [0.13, 0.2, 0.29, 1]);
    if (style === "wireframe") gl.disable(gl.DEPTH_TEST);
    const from = gl.getAttribLocation(lineProgram, "from"), to = gl.getAttribLocation(lineProgram, "to"), corner = gl.getAttribLocation(lineProgram, "corner");
    const bind = buffer => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(from); gl.vertexAttribPointer(from, 3, gl.FLOAT, false, 32, 0);
        gl.enableVertexAttribArray(to); gl.vertexAttribPointer(to, 3, gl.FLOAT, false, 32, 12);
        gl.enableVertexAttribArray(corner); gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 32, 24);
    };
    bind(shape.buffers.feature);
    gl.drawArrays(gl.TRIANGLES, 0, shape.feature.length * 6);
    if (silhouette.length) {
        gl.bindBuffer(gl.ARRAY_BUFFER, renderer.lines);
        gl.bufferData(gl.ARRAY_BUFFER, lineData(shape.points, silhouette), gl.STREAM_DRAW);
        bind(renderer.lines);
        gl.drawArrays(gl.TRIANGLES, 0, silhouette.length * 6);
    }
    gl.disableVertexAttribArray(from); gl.disableVertexAttribArray(to); gl.disableVertexAttribArray(corner);
    gl.enable(gl.DEPTH_TEST);
}

function drawThumbnail(entry, canvas = thumbnail, currentView = view) {
    const missing = !entry?.mesh?.length;
    if (canvas === thumbnail) {
        thumbnail.hidden = missing;
        document.querySelector("#rotate-hint").hidden = missing;
    }
    if (missing) return;
    const options = input.settings.sheet;
    if (canvas === thumbnail && canvas.clientWidth) {
        // Match the screen's pixel density so lines and edges stay sharp.
        const ratio = window.devicePixelRatio || 1;
        const width = Math.round(canvas.clientWidth * ratio), height = Math.round(canvas.clientWidth * ratio * 280 / 448);
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    }
    const context = canvas.getContext("2d");
    const {width, height} = canvas;
    context.clearRect(0, 0, width, height);
    if (options.Shadows && (options.DisplayStyle ?? "edges") !== "wireframe") {
        context.save();
        context.translate(width / 2 + currentView.panX * width * 0.3, height * (0.84 - currentView.panY * 0.3));
        context.scale(currentView.zoom, currentView.zoom * 0.19);
        const shadow = context.createRadialGradient(0, 0, 0, 0, 0, width * .3);
        shadow.addColorStop(0, "rgba(0, 0, 0, .34)");
        shadow.addColorStop(1, "transparent");
        context.fillStyle = shadow;
        context.fillRect(-width / 2, -width / 2, width, width);
        context.restore();
    }
    if (renderer) {
        try {
            renderWebGL(entry, width, height, currentView, options);
            context.drawImage(renderer.canvas, 0, 0);
            return;
        } catch { /* fall through to the 2D painter */ }
    }
    drawThumbnail2D(entry, canvas, currentView, options);
}

// Simple fallback when WebGL is unavailable.
function drawThumbnail2D(entry, canvas, currentView, options) {
    const shape = geometry(entry);
    const context = canvas.getContext("2d");
    const {width, height} = canvas;
    const rows = rotationRows(currentView);
    const scale = Math.min(width, height) * 0.45 * currentView.zoom;
    const project = p => {
        const x = rows[0][0] * p[0] + rows[0][1] * p[1] + rows[0][2] * p[2] + currentView.panX;
        const y = rows[1][0] * p[0] + rows[1][1] * p[1] + rows[1][2] * p[2] + currentView.panY;
        const z = rows[2][0] * p[0] + rows[2][1] * p[1] + rows[2][2] * p[2];
        return [width / 2 + x * scale, height / 2 - y * scale, z];
    };
    const triangles = [];
    for (let tri = 0; tri < shape.triangleCount; tri++) {
        const corners = [0, 1, 2].map(k => project(shape.points.subarray(tri * 9 + k * 3, tri * 9 + k * 3 + 3)));
        const n = shape.triangleNormal.subarray(tri * 3, tri * 3 + 3);
        const length = Math.hypot(n[0], n[1], n[2]) || 1;
        const nz = Math.abs(rows[2][0] * n[0] + rows[2][1] * n[1] + rows[2][2] * n[2]) / length;
        triangles.push({corners, depth: corners[0][2] + corners[1][2] + corners[2][2], light: 0.35 + 0.65 * nz});
    }
    triangles.sort((a, b) => a.depth - b.depth);
    for (const {corners, light} of triangles) {
        const tone = Math.round(90 + light * 120);
        context.fillStyle = context.strokeStyle = `rgb(${tone - 8}, ${tone + 4}, ${tone + 18})`;
        context.beginPath();
        corners.forEach(([x, y]) => context.lineTo(x, y));
        context.closePath();
        context.fill();
        context.stroke();
    }
    if ((options.DisplayStyle ?? "edges") === "shaded") return;
    context.strokeStyle = "#223349";
    context.lineWidth = 1.2;
    for (const edge of shape.feature) {
        const a = project(shape.points.subarray(edge.from, edge.from + 3)), b = project(shape.points.subarray(edge.to, edge.to + 3));
        context.beginPath(); context.moveTo(a[0], a[1]); context.lineTo(b[0], b[1]); context.stroke();
    }
}

// Rotate: drag. Pan: right-drag or Shift-drag. Zoom: scroll wheel or +/-. Reset: double-click or 0.
let drag = null;
thumbnail.addEventListener("contextmenu", event => event.preventDefault());
thumbnail.addEventListener("pointerdown", event => {
    drag = {x: event.clientX, y: event.clientY, pan: event.button === 2 || event.button === 1 || event.shiftKey};
    thumbnail.setPointerCapture(event.pointerId);
});
thumbnail.addEventListener("pointermove", event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.pan) {
        const unit = 2 / (Math.min(thumbnail.clientWidth, thumbnail.clientHeight) * 0.9 * view.zoom);
        view.panX += dx * unit;
        view.panY -= dy * unit;
    } else {
        view.yaw += dx * Math.PI / Math.max(160, thumbnail.clientWidth);
        view.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, view.pitch + dy * Math.PI / Math.max(160, thumbnail.clientHeight)));
    }
    drawThumbnail(input.entries[focused]);
});
thumbnail.addEventListener("lostpointercapture", () => { drag = null; });
thumbnail.addEventListener("wheel", event => {
    event.preventDefault();
    view.zoom = Math.max(0.4, Math.min(12, view.zoom * Math.exp(-event.deltaY * 0.0015)));
    drawThumbnail(input.entries[focused]);
}, {passive: false});
thumbnail.addEventListener("dblclick", () => {
    view = defaultView();
    drawThumbnail(input.entries[focused]);
});
thumbnail.addEventListener("keydown", event => {
    const step = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
    if (step) {
        view.yaw += step[0] * 0.18;
        view.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, view.pitch + step[1] * 0.18));
    } else if (event.key === "+" || event.key === "=") view.zoom = Math.min(12, view.zoom * 1.2);
    else if (event.key === "-" || event.key === "_") view.zoom = Math.max(0.4, view.zoom / 1.2);
    else if (event.key === "0") view = defaultView();
    else return;
    event.preventDefault();
    drawThumbnail(input.entries[focused]);
});
window.addEventListener("resize", () => { if (input && focused >= 0) drawThumbnail(input.entries[focused]); });

// ---------- Talking to the add-in ----------
// The add-in answers every request on its own line. `next_message` hands each answer to the
// request that is waiting for it.
// The request waiting for an answer: {id, resolve}. Every request is numbered and the add-in echoes the number, so
// a late answer to a request the user stopped waiting for is never taken for the answer to a newer one.
let hostReply = null;
let lastRequestId = 0;
const hostStatus = $("#host-status");
const stopWaiting = $("#stop-waiting");
const stopWaitingAfter = 20000;

function setHostStatus(text, isError = false) {
    hostStatus.textContent = text ?? "";
    hostStatus.classList.toggle("error", isError);
}

async function listenToHost() {
    for (;;) {
        let message = null;
        try { message = await invoke("next_message"); } catch { message = null; }
        if (message == null) {
            // SolidWorks closed or unloaded the add-in.
            invoke("cancel");
            return;
        }
        // Messages the add-in sends on its own (for example, the command was run on another part) are
        // never mistaken for the answer to a request.
        if (message.push) { handlePush(message); continue; }
        const waiting = hostReply;
        if (!waiting || (message.requestId && message.requestId !== waiting.id)) continue;
        hostReply = null;
        waiting.resolve(message);
    }
}

function showLabelPage() {
    reorderPage.hidden = true;
    batchPage.hidden = true;
    panel.hidden = true;
    labelPage.hidden = false;
}

// Replace the cut list with fresh data from SolidWorks. Unapplied Custom edits and locks are kept
// (matched by item name) for every item except the ones that were just applied.
function loadEntries(entries, applied, keepPending = true) {
    const appliedNames = new Set((applied ?? []).map(index => input.entries[index]?.name));
    const focusedName = input.entries[focused]?.name;
    const pending = new Map();
    if (keepPending) input.entries.forEach((entry, index) => {
        if (!appliedNames.has(entry.name)) pending.set(entry.name, {custom: customEntries[index], locks: locksByEntry[index]});
    });
    input.entries = entries;
    for (const key of Object.keys(customEntries)) delete customEntries[key];
    for (const key of Object.keys(locksByEntry)) delete locksByEntry[key];
    entries.forEach((entry, index) => {
        const kept = pending.get(entry.name);
        if (kept) {
            if (kept.custom) customEntries[index] = kept.custom;
            if (kept.locks) locksByEntry[index] = kept.locks;
        } else if (entry.custom) customEntries[index] = {...entry.custom};
    });
    selection.clear();
    const again = keepPending ? entries.findIndex(entry => entry.name === focusedName) : -1;
    focused = -2;
    buildRows();
    if (again >= 0 && [...document.querySelectorAll("#entries tr")].some(row => Number(row.dataset.index) === again)) focusEntry(again);
}

const quietActions = ["save", "presets", "presetExport", "presetImport", "shapes", "readLibrary"];
async function finish(Action, Selection, Thumbnails, extra = {}) {
    if (busy || !input) return null;
    busy = true;
    document.documentElement.classList.add("busy");
    apply.disabled = save.disabled = reorderApply.disabled = true;
    partSelect.disabled = configSelect.disabled = true;
    if (!quietActions.includes(Action)) setHostStatus(Action === "export" ? "Exporting to Excel..." : Action === "exportPdf" ? "Exporting to PDF..." : "Working in SolidWorks...");
    const statusFor = {reorder: reorderStatus, batchApply: batchStatus, save: $("#save-status"),
        presets: presetStatus, presetExport: presetStatus, presetImport: presetStatus, shapes: $("#shape-status")};
    let message = null;
    const RequestId = ++lastRequestId;
    // A request SolidWorks never answers mustn't lock the window: after a while it can be abandoned.
    const offerStop = setTimeout(() => { stopWaiting.hidden = false; }, stopWaitingAfter);
    try {
        const reply = new Promise(resolve => { hostReply = {id: RequestId, resolve}; });
        await invoke("send_to_host", {message: {Action, RequestId, Settings: input.settings, Custom: customEntries, Locks: locksByEntry,
            Selection, Thumbnails, Names: input.entries.map(entry => entry.name),
            Descriptions: input.entries.map(entry => entry.currentDescription ?? ""),
            Lengths: input.entries.map(entry => entry.currentLength ?? ""), ...extra}});
        message = await reply;
        busy = false;
        if (message.type === "saved") {
            const notice = $("#save-status");
            clearTimeout(saveNoticeTimer);
            notice.textContent = "Settings saved.";
            saveNoticeTimer = setTimeout(() => { notice.textContent = ""; }, 2000);
        } else if (message.type === "refresh") {
            // A different part's list never inherits edits from the previous part.
            loadEntries(message.entries, message.ok && Action === "apply" ? Selection : [],
                Action !== "selectPart" && Action !== "selectConfiguration");
            if (message.parts) renderParts(message.parts, message.part, message.partTitle);
            showConfiguration(message);
            canUndo = Boolean(message.canUndo);
            if (Action !== "refresh" || !message.ok) showLabelPage();
            setHostStatus(message.message, !message.ok);
        } else if (message.type === "parts") {
            renderParts(message.parts, message.part);
            showLabelPage();
            setHostStatus(message.message, true);
        } else if (message.type === "done") {
            if (!quietActions.includes(Action)) setHostStatus(message.message);
        } else if (["presets", "presetFile", "shapes", "library", "batch"].includes(message.type)) {
            // Handled by the caller.
        } else {
            const target = statusFor[Action];
            if (target && !target.closest("[hidden]")) { target.textContent = message.message; setHostStatus(""); }
            else setHostStatus(message.message, true);
        }
        if (["save", "apply", "batchApply", "presets"].includes(Action) && extra.Settings !== null && message && message.type !== "error")
            savedShapeRules = input.settings.weldment.ShapeRules ?? "";
        // Anything SolidWorks couldn't put back, such as a part left on another configuration.
        if (message?.warning) setHostStatus([message.message, message.warning].filter(Boolean).join(" "), true);
    } catch (error) {
        hostReply = null;
        setHostStatus(String(error), true);
    } finally {
        clearTimeout(offerStop);
        stopWaiting.hidden = true;
        busy = false;
        document.documentElement.classList.remove("busy");
        refresh();
        reorderApply.disabled = pendingOrder.every((index, position) => index === position);
        if (presets) renderPresets();
        partSelect.disabled = partSelect.options.length === 0 || (partSelect.options.length === 1 && !partSelect.value);
        configSelect.disabled = false;
    }
    return message;
}

stopWaiting.addEventListener("click", () => {
    const waiting = hostReply;
    hostReply = null;
    if (waiting) waiting.resolve({type: "error", message: "Stopped waiting for SolidWorks. If it finishes later, its result is ignored; " +
        "click Refresh to see the cut list as it is now."});
});
save.addEventListener("click", () => finish("save"));
$("#undo").addEventListener("click", () => { if (!busy) finish("undo"); });
const warnOnSave = $("#warn-on-save");
warnOnSave.addEventListener("change", () => {
    Object.values(input.settings).forEach(profile => { profile.WarnOnSave = warnOnSave.checked; });
});
$("#cancel").addEventListener("click", () => invoke("cancel"));

invoke("read_settings").then(data => {
    input = data;
    $("#app-version").textContent = data.version ? "Auto Cut List " + data.version : "Auto Cut List";
    renderParts(data.parts, data.part, data.partTitle);
    showConfiguration(data);
    setShared("Case", sharedCase(data.settings.sheet));
    setShared("Units", unitModes.includes(data.settings.sheet.Units) ? data.settings.sheet.Units : "imperial");
    setShared("LeadingZero", data.settings.sheet.LeadingZero !== false);
    setShared("Fractions", data.settings.sheet.Fractions === true);
    setShared("KeepCaps", data.settings.sheet.KeepCaps !== false);
    setShared("FractionDenominator", [2, 4, 8, 16, 32, 64].includes(data.settings.sheet.FractionDenominator) ? data.settings.sheet.FractionDenominator : 16);
    data.settings.weldment.ShapeTemplates = data.settings.weldment.ShapeTemplates || "{}";
    data.settings.part.ShapeTemplates = data.settings.part.ShapeTemplates || "{}";
    loadShapeRules(data.settings.weldment.ShapeRules);
    savedShapeRules = data.settings.weldment.ShapeRules ?? "";
    gauge.checked = Boolean(data.settings.sheet.UseGauge);
    data.settings.part.UseGauge = gauge.checked;
    warnOnSave.checked = data.settings.sheet.WarnOnSave !== false;
    Object.values(data.settings).forEach(profile => { profile.WarnOnSave = warnOnSave.checked; });
    data.entries.forEach((entry, index) => { if (entry.custom) customEntries[index] = {...entry.custom}; });
    for (const [key, control] of Object.entries(shapeLabels)) control.value = data.settings.part[key] ?? data.defaults.part[key];
    for (const [key, control] of Object.entries(thumbnailOptions)) {
        if (key === "DisplayStyle") control.value = data.settings.sheet[key] ?? "edges";
        else if (key === "PartColors") control.checked = data.settings.sheet[key] !== false;
        else control.checked = Boolean(data.settings.sheet[key]);
    }
    applyTheme(themeOf(data.settings.sheet));
    applyFont(data.settings.sheet.Font);
    setTemplateCategory(data.entries[0]?.category ?? "sheet");
    buildRows();
    listenToHost();
    initPresets(data);
    // Opened with no part, or a part with nothing in its cut list: say what to do next.
    if (data.message) setHostStatus(data.message);
}).catch(error => { status.textContent = String(error); });

// ---------- Template presets ----------
// Presets are stored in the registry by the add-in (one value per preset). Names are matched without
// regard to case, as Windows does.
const presetName = document.querySelector("#preset-name");
const presetList = document.querySelector("#preset-list");
const presetStatus = document.querySelector("#preset-status");
const presetActive = document.querySelector("#preset-active");
const presetConfirm = document.querySelector("#preset-confirm");
const legacyPresetKey = "cut-list-template-presets-v1";
let presets = [];
let activePreset = "";
let pendingConfirm = null;

function validatePreset(preset) {
    if (preset?.version !== 1 || typeof preset.name !== "string" ||
        !preset.name.trim() || preset.name.length > 80) throw new Error("Invalid preset name or version.");
    const profiles = {};
    const sample = {type:"", thickness:[], width:[], length:[], quantity:"", gauge:"", callout:"", shape:""};
    for (const category of Object.keys(names)) {
        const profile = preset.profiles?.[category];
        if (!profile || typeof profile.Description !== "string" || typeof profile.Length !== "string" ||
            !Number.isInteger(profile.Decimals) ||
            profile.Decimals < 0 || profile.Decimals > 8)
            throw new Error("Invalid " + names[category] + " template settings.");
        const {Description, Length, Decimals} = profile;
        const Case = sharedCase(profile);
        const Units = unitModes.includes(profile.Units) ? profile.Units : "imperial";
        render(Description, sample, profile);
        render(Length, sample, profile);
        profiles[category] = {Description, Length, Decimals, Case, Units, LeadingZero: profile.LeadingZero !== false,
            Fractions: profile.Fractions === true, KeepCaps: profile.KeepCaps !== false,
            FractionDenominator: [2, 4, 8, 16, 32, 64].includes(profile.FractionDenominator) ? profile.FractionDenominator : 16};
        if (category === "part") {
            let shapes = {};
            // Presets saved before regular parts had shape templates get the default Cylinder template.
            const stored = typeof profile.ShapeTemplates === "string" ? profile.ShapeTemplates : input?.defaults?.part?.ShapeTemplates;
            try { shapes = JSON.parse(stored || "{}") ?? {}; } catch { throw new Error("Invalid regular part shape templates."); }
            for (const [key, template] of Object.entries(shapes)) {
                if (!partShapes.some(shape => shape.key === key) || typeof template?.Description !== "string" || typeof template?.Length !== "string")
                    throw new Error("Invalid regular part shape templates.");
                render(template.Description, {...sample, category: "part"}, profile);
                render(template.Length, {...sample, category: "part"}, profile);
            }
            profiles[category].ShapeTemplates = JSON.stringify(shapes);
        }
        if (category === "weldment") {
            let shapes = {};
            try { shapes = JSON.parse(profile.ShapeTemplates || "{}") ?? {}; } catch { throw new Error("Invalid weldment shape templates."); }
            for (const template of Object.values(shapes)) {
                if (typeof template?.Description !== "string" || typeof template?.Length !== "string") throw new Error("Invalid weldment shape templates.");
                render(template.Description, {...sample, category: "weldment"}, profile);
                render(template.Length, {...sample, category: "weldment"}, profile);
            }
            profiles[category].ShapeTemplates = JSON.stringify(shapes);
            // Shape rules, custom shapes and {profile} text travel with the preset, so its shape templates
            // work on another workstation. Profile-library choices stay with the computer.
            if (typeof profile.ShapeRules === "string") {
                let rules = {};
                try { rules = JSON.parse(profile.ShapeRules || "{}") ?? {}; } catch { throw new Error("Invalid weldment shape rules."); }
                profiles[category].ShapeRules = JSON.stringify({
                    rules: (Array.isArray(rules.rules) ? rules.rules : []).filter(rule => typeof rule?.match === "string" && typeof rule?.family === "string")
                        .map(rule => ({match: rule.match, family: rule.family})),
                    custom: (Array.isArray(rules.custom) ? rules.custom : []).filter(item => typeof item?.key === "string" && typeof item?.name === "string")
                        .map(item => ({key: item.key, name: item.name})),
                    labels: Object.fromEntries(Object.entries(rules.labels && typeof rules.labels === "object" ? rules.labels : {}).filter(([, text]) => typeof text === "string"))
                });
            }
        }
        if (category === "sheet" || category === "part") profiles[category].UseGauge = profile.UseGauge === true;
        if (category === "part") {
            profiles[category].BoxLabel = typeof profile.BoxLabel === "string" ? profile.BoxLabel : "Box";
            profiles[category].CylinderLabel = typeof profile.CylinderLabel === "string" ? profile.CylinderLabel : "Cylinder";
        }
    }
    return {version: 1, name: preset.name.trim(), profiles};
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const findPreset = name => presets.find(preset => sameName(preset.name, name));

// The current settings in preset form, or null if a template is invalid.
function currentAsPreset(name) {
    try { return validatePreset({version: 1, name: name || "Current", profiles: input.settings}); }
    catch { return null; }
}

function updatePresetIndicator() {
    if (!input) return;
    const preset = activePreset && findPreset(activePreset);
    if (!preset) {
        presetActive.textContent = "No preset in use.";
        return;
    }
    const current = currentAsPreset(preset.name);
    const changed = !current || JSON.stringify(current.profiles) !== JSON.stringify(validatePreset(preset).profiles);
    presetActive.textContent = "Active preset: " + preset.name + (changed ? " (changed since it was loaded or saved)" : "");
}

function renderPresets(selection) {
    const selected = selection ?? presetList.value;
    presetList.replaceChildren(...presets.map(preset => {
        const option = document.createElement("option");
        option.value = preset.name;
        option.textContent = preset.name + (activePreset && sameName(preset.name, activePreset) ? "  (active)" : "");
        return option;
    }));
    const match = selected && findPreset(selected);
    if (match) presetList.value = match.name;
    const has = Boolean(findPreset(presetList.value ?? ""));
    for (const id of ["#preset-load", "#preset-rename", "#preset-delete", "#preset-export"])
        document.querySelector(id).disabled = !has || busy;
    updatePresetIndicator();
}

function askPreset(text, action, confirmLabel) {
    pendingConfirm = action;
    document.querySelector("#preset-confirm-text").textContent = text;
    document.querySelector("#preset-confirm-yes").textContent = confirmLabel;
    presetConfirm.hidden = false;
    document.querySelector("#preset-confirm-yes").focus();
}
function clearConfirm() {
    pendingConfirm = null;
    presetConfirm.hidden = true;
}
document.querySelector("#preset-confirm-yes").addEventListener("click", () => {
    const action = pendingConfirm;
    clearConfirm();
    if (action) action();
});
document.querySelector("#preset-confirm-no").addEventListener("click", () => {
    clearConfirm();
    presetStatus.textContent = "";
});

// Save the preset list (and which one is active). Settings are only saved when `withSettings` is set.
async function storePresets(message, withSettings = false) {
    const reply = await finish("presets", undefined, undefined, {
        PresetsJson: JSON.stringify(presets), ActivePreset: activePreset, ...(withSettings ? {} : {Settings: null})});
    if (reply?.type === "presets") presetStatus.textContent = message;
    renderPresets();
}

function putPreset(preset, message, withSettings = false) {
    presets = presets.filter(existing => !sameName(existing.name, preset.name));
    presets.push(preset);
    presets.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: "base"}));
    renderPresets(preset.name);
    return storePresets(message, withSettings);
}

function presetAction(id, action) {
    document.querySelector(id).addEventListener("click", () => {
        if (!input || busy) return;
        clearConfirm();
        presetStatus.textContent = "";
        try { action(); }
        catch (error) { presetStatus.textContent = error.message; }
    });
}

presetList.addEventListener("change", () => {
    clearConfirm();
    presetName.value = presetList.value;
    renderPresets();
});

presetAction("#preset-store", () => {
    const candidate = validatePreset({version: 1, name: presetName.value, profiles: input.settings});
    const existing = findPreset(candidate.name);
    if (existing) candidate.name = existing.name;
    // The preset becomes the active settings, so the settings are saved with it.
    const save = () => {
        activePreset = candidate.name;
        putPreset(candidate, "Saved preset " + candidate.name + ".", true);
    };
    if (existing) askPreset("Replace preset " + existing.name + " with the current settings?", save, "Replace");
    else save();
});

presetAction("#preset-load", () => {
    const preset = findPreset(presetList.value);
    if (!preset) return;
    for (const [category, profile] of Object.entries(validatePreset(preset).profiles)) {
        const {ShapeRules: presetShapes, ...rest} = profile;
        Object.assign(input.settings[category], rest);
        if (category === "weldment" && presetShapes) {
            // The preset's rules, shapes and {profile} text replace the current ones; library choices are kept.
            input.settings.weldment.ShapeRules = JSON.stringify({...JSON.parse(presetShapes), libraries: shapeRules.libraries});
            loadShapeRules(input.settings.weldment.ShapeRules);
        }
    }
    renderShapeSettings();
    setShared("Case", sharedCase(input.settings.sheet));
    setShared("Units", input.settings.sheet.Units ?? "imperial");
    setShared("LeadingZero", input.settings.sheet.LeadingZero !== false);
    setShared("Fractions", input.settings.sheet.Fractions === true);
    setShared("KeepCaps", input.settings.sheet.KeepCaps !== false);
    setShared("FractionDenominator", input.settings.sheet.FractionDenominator || 16);
    gauge.checked = input.settings.sheet.UseGauge;
    input.settings.part.UseGauge = gauge.checked;
    for (const [key, control] of Object.entries(shapeLabels)) control.value = input.settings.part[key];
    syncTemplateBar();
    buildRows();
    activePreset = preset.name;
    // Loading applies the preset straight away: the settings are saved with it.
    storePresets("Loaded " + preset.name + ". It is now your active settings.", true);
});

presetAction("#preset-rename", () => {
    const preset = findPreset(presetList.value);
    if (!preset) return;
    const name = presetName.value.trim();
    if (!name || name.length > 80) throw new Error("Type a new name (up to 80 characters) in the Name box.");
    if (name === preset.name) throw new Error("Type a different name in the Name box to rename " + preset.name + ".");
    const rename = () => {
        const wasActive = activePreset && sameName(activePreset, preset.name);
        presets = presets.filter(existing => existing !== preset && !sameName(existing.name, name));
        if (wasActive) activePreset = name;
        putPreset({...preset, name}, "Renamed " + preset.name + " to " + name + ".");
    };
    const other = findPreset(name);
    if (other && other !== preset) askPreset("A preset named " + other.name + " already exists. Replace it?", rename, "Replace");
    else rename();
});

presetAction("#preset-delete", () => {
    const preset = findPreset(presetList.value);
    if (!preset) return;
    askPreset("Delete preset " + preset.name + "? This can't be undone.", () => {
        presets = presets.filter(existing => existing !== preset);
        if (activePreset && sameName(activePreset, preset.name)) activePreset = "";
        presetName.value = "";
        renderPresets("");
        storePresets("Deleted " + preset.name + ".");
    }, "Delete");
});

presetAction("#preset-export", async () => {
    const preset = findPreset(presetList.value);
    if (!preset) return;
    const reply = await finish("presetExport", undefined, undefined,
        {PresetName: preset.name, PresetJson: JSON.stringify(validatePreset(preset), null, 2), Settings: null});
    if (reply?.type === "done") presetStatus.textContent = reply.message;
});

presetAction("#preset-import", async () => {
    const reply = await finish("presetImport", undefined, undefined, {Settings: null});
    if (reply?.type === "done") { presetStatus.textContent = reply.message; return; }
    if (reply?.type !== "presetFile") return;
    let candidate;
    try { candidate = validatePreset(JSON.parse(reply.text)); }
    catch (error) { presetStatus.textContent = reply.file + " is not a valid cut-list preset (" + error.message + ")."; return; }
    const save = () => putPreset(candidate, "Imported " + candidate.name + " from " + reply.file + ". Load it to use it.");
    if (findPreset(candidate.name)) askPreset("A preset named " + findPreset(candidate.name).name + " already exists. Replace it with the one from " + reply.file + "?", save, "Replace");
    else save();
});

// Called once the window has its data: presets from the registry, plus any made with the earlier
// version, which kept them in the window's own storage.
function initPresets(data) {
    presets = Array.isArray(data.presets) ? data.presets.filter(preset => { try { validatePreset(preset); return true; } catch { return false; } }) : [];
    activePreset = typeof data.activePreset === "string" ? data.activePreset : "";
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(legacyPresetKey) ?? "[]"); } catch { legacy = []; }
    const moved = legacy.filter(preset => { try { validatePreset(preset); return !findPreset(preset.name); } catch { return false; } });
    renderPresets();
    if (moved.length) {
        presets.push(...moved.map(validatePreset));
        presets.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: "base"}));
        storePresets("Moved " + moved.length + " preset(s) from the previous version.").then(() => {
            try { localStorage.removeItem(legacyPresetKey); } catch { /* storage unavailable */ }
        });
    }
}

// The configuration whose cut list is shown, when the part has more than one.
// The configuration whose cut list the table shows. It can differ from the one active in SolidWorks:
// the add-in switches to it for each request and back again, so the model on screen stays as it was.
const configSelect = $("#config-select");
let currentConfiguration = "";
let activeConfiguration = "";
// Configurations the user already agreed to show although SolidWorks has another one active, per part.
const agreedConfigurations = new Set();
function showConfiguration(message) {
    let names = Array.isArray(message.configurationNames) ? message.configurationNames : [];
    currentConfiguration = message.configuration ?? "";
    if (!names.length && message.configurations > 1 && currentConfiguration) names = [currentConfiguration];
    configSelect.hidden = !(message.configurations > 1 && currentConfiguration);
    if (configSelect.hidden) { configSelect.replaceChildren(); return; }
    const active = message.activeConfiguration;
    activeConfiguration = active ?? "";
    configSelect.replaceChildren(...names.map(name => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name + (name === active ? " (active)" : "");
        return option;
    }));
    configSelect.value = currentConfiguration;
    configSelect.title = "Configuration shown: " + currentConfiguration +
        (active && active !== currentConfiguration ? ". SolidWorks has " + active + " active; this window reads and labels "
            + currentConfiguration + " without changing that." : ".") +
        " Use All open parts to label every configuration at once.";
}
configSelect.addEventListener("change", () => {
    const name = configSelect.value;
    configSelect.value = currentConfiguration;
    if (!name || name === currentConfiguration || busy) return;
    const notes = [];
    // SolidWorks can only read a configuration that is active, so showing another one means switching to it and back
    // for every action, and SolidWorks marks the part as changed whenever its configuration switches.
    const key = currentPart + "\n" + name;
    if (name !== activeConfiguration && !agreedConfigurations.has(key))
        notes.push("SolidWorks has " + (activeConfiguration || "another configuration") + " active, so every action here will switch the part to " +
            name + " and back. That rebuilds the part each time and marks it as changed, so SolidWorks will ask you to save it.");
    if (hasPendingEdits()) notes.push("Unapplied Custom edits and lock changes for this configuration will be discarded.");
    if (notes.length)
        askConfirm("Show configuration " + name + "? " + notes.join(" "), () => {
            if (name !== activeConfiguration) agreedConfigurations.add(key);
            switchToConfiguration(name);
        });
    else switchToConfiguration(name);
});
function switchToConfiguration(name) {
    clearPartConfirm();
    finish("selectConfiguration", undefined, undefined, {Configuration: name});
}

// ---------- All open parts ----------
// Applies the current templates to every open part at once. The add-in reads each part's cut list;
// the labels are worked out here, exactly as they are for the part in the main table.
const batchPage = $("#batch-page");
const batchApply = $("#batch-apply");
const batchStatus = $("#batch-status");
const batchSelection = new Set();
let batchParts = [];

function batchSummary(part) {
    const live = part.key === currentPart && part.active;
    const id = part.key + "\n" + (part.configuration ?? "");
    const named = part.configurations > 1 && part.configuration;
    // The part shown in the main table keeps its unapplied hand edits and locks.
    const source = live ? input.entries : part.entries;
    const partStates = source.map((entry, index) => live ? states[index]
        : computeState(entry, entry.custom ?? undefined, entry.locks ?? {}, index));
    const changed = partStates.filter(state => state.changed);
    const custom = live ? customEntries
        : Object.fromEntries(source.map((entry, index) => [index, entry.custom]).filter(([, value]) => value));
    return {
        id, live, key: part.key, title: part.title + (named ? " \u2014 " + part.configuration : ""), error: part.error, items: source.length, changed,
        unlabeled: partStates.filter(state => state.error).length,
        stale: source.filter(entry => entry.stale).length,
        request: {
            PartKey: part.key,
            // Only switch configurations when every configuration was asked for.
            Configuration: batchConfigs.checked ? part.configuration ?? "" : "",
            Names: source.map(entry => entry.name),
            Descriptions: source.map(entry => entry.currentDescription ?? ""),
            Lengths: source.map(entry => entry.currentLength ?? ""),
            Selection: changed.map(state => state.index),
            Labels: Object.fromEntries(changed.map(state => [state.index, {Description: state.description, Length: state.length}])),
            Custom: custom, Locks: live ? locksByEntry : {}
        }
    };
}

function updateBatchButton() {
    const count = batchSelection.size;
    batchApply.disabled = busy || !count || Boolean(templatesInvalid);
    batchApply.textContent = count ? "Apply to " + count + (count === 1 ? " part" : " parts") : "Apply";
}

function renderBatch() {
    $("#batch-rows").replaceChildren(...batchParts.map(part => {
        const row = document.createElement("tr");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.disabled = !part.changed.length;
        box.checked = batchSelection.has(part.id);
        box.setAttribute("aria-label", "Apply to " + part.title);
        box.addEventListener("change", () => {
            if (box.checked) batchSelection.add(part.id);
            else batchSelection.delete(part.id);
            updateBatchButton();
        });
        const notes = [];
        if (part.error) notes.push("Couldn't be read: " + part.error);
        else if (!part.items) notes.push("No cut-list items");
        else if (!part.changed.length) notes.push("Already up to date");
        if (part.unlabeled) notes.push(part.unlabeled + " can't be labeled automatically");
        if (part.stale) notes.push(part.stale + " changed in the model since labeling");
        if (part.live) notes.push("Shown in the main table");
        row.append(cellWith(box), cellWith(part.title));
        for (const value of [part.items, part.changed.length]) {
            const cell = cellWith(String(value));
            cell.className = "numeric";
            row.append(cell);
        }
        row.append(cellWith(notes.join(". ")));
        return row;
    }));
    updateBatchButton();
}

const batchConfigs = $("#batch-configs");
async function loadBatch() {
    if (!input || busy) return;
    if (templatesInvalid) { setHostStatus("Fix the templates before applying to all open parts.", true); return; }
    batchStatus.textContent = batchConfigs.checked ? "Reading every configuration in SolidWorks..." : "";
    const reply = await finish("batchRead", undefined, undefined, {Settings: null, AllConfigurations: batchConfigs.checked});
    if (reply?.type !== "batch") return;
    setHostStatus("");
    batchParts = reply.parts.map(batchSummary);
    batchSelection.clear();
    for (const part of batchParts) if (part.changed.length) batchSelection.add(part.id);
    batchStatus.textContent = batchParts.some(part => part.changed.length) ? "" : "Every open part is already up to date.";
    renderBatch();
    labelPage.hidden = true;
    batchPage.hidden = false;
}
$("#open-batch").addEventListener("click", () => { batchConfigs.checked = false; loadBatch(); });
batchConfigs.addEventListener("change", loadBatch);
$("#batch-back").addEventListener("click", () => {
    if (busy) return;
    batchPage.hidden = true;
    labelPage.hidden = false;
});
batchApply.addEventListener("click", () => {
    if (batchApply.disabled) return;
    const Batch = batchParts.filter(part => batchSelection.has(part.id)).map(part => part.request);
    batchStatus.textContent = "Working in SolidWorks...";
    finish("batchApply", undefined, undefined, {Batch});
});

const reorderPage = document.querySelector("#reorder-page");
const reorderStatus = document.querySelector("#reorder-status");
const reorderApply = document.querySelector("#reorder-apply");
const categoryOrder = ["Sheet Metal", "Weldment", "Regular Part", "Custom"];
let pendingOrder = [];

function storedCategory(entry) {
    return entry.custom ? "Custom" : names[entry.category];
}

function sortedCutList(entriesToSort) {
    return entriesToSort.map((entry, index) => ({entry, index})).sort((a, b) =>
        categoryOrder.indexOf(storedCategory(a.entry)) - categoryOrder.indexOf(storedCategory(b.entry)) ||
        (a.entry.currentDescription ?? "").localeCompare(b.entry.currentDescription ?? "", undefined, {sensitivity:"base"}) ||
        ((a.entry.sortLength ?? Infinity) - (b.entry.sortLength ?? Infinity)) ||
        a.index - b.index);
}

document.querySelector("#open-reorder").addEventListener("click", () => {
    if (!input || busy) return;
    const sorted = sortedCutList(input.entries);
    pendingOrder = sorted.map(item => item.index);
    document.querySelector("#reorder-rows").replaceChildren(...sorted.map(({entry, index}, position) => {
        const row = document.createElement("tr");
        [position + 1, index + 1, entry.name, storedCategory(entry), entry.currentDescription ?? "", entry.currentLength ?? ""].forEach((value, column) => {
            const cell = row.insertCell();
            cell.textContent = String(value);
            if (column < 2) cell.className = "numeric";
        });
        return row;
    }));
    reorderApply.disabled = pendingOrder.every((index, position) => index === position);
    reorderStatus.textContent = reorderApply.disabled ? "The cut list is already in this order." : "";
    labelPage.hidden = true;
    reorderPage.hidden = false;
    document.querySelector("#reorder-back").focus();
    window.scrollTo(0, 0);
});
document.querySelector("#reorder-back").addEventListener("click", () => {
    if (busy) return;
    reorderPage.hidden = true;
    labelPage.hidden = false;
    document.querySelector("#open-reorder").focus();
});
reorderApply.addEventListener("click", () => finish("reorder", pendingOrder));

document.querySelector("#refresh").addEventListener("click", () => {
    clearPartConfirm();
    // With the selected part closed, Refresh loads whichever part is chosen in the list.
    if (!currentPart && partSelect.value) finish("selectPart", undefined, undefined, {PartKey: partSelect.value});
    else finish("refresh");
});

// ---------- Part selector ----------
const partSelect = document.querySelector("#part-select");
const partConfirm = document.querySelector("#part-confirm");
let currentPart = "";
let partConfirmAction = null;

function renderParts(parts, key, title) {
    currentPart = key ?? "";
    const list = Array.isArray(parts) ? parts : [];
    const options = list.map(part => {
        const option = document.createElement("option");
        option.value = part.key;
        option.textContent = part.title;
        return option;
    });
    if (!currentPart) {
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = list.length ? "Choose a part..." : "No parts open";
        options.unshift(placeholder);
    } else if (!list.some(part => part.key === currentPart)) {
        const option = document.createElement("option");
        option.value = currentPart;
        option.textContent = title ?? currentPart;
        options.unshift(option);
    }
    partSelect.replaceChildren(...options);
    partSelect.value = currentPart;
    partSelect.disabled = !list.length;
    // Opening or closing parts changes what an empty table should say.
    if (input && !input.entries.length) $("#empty-note").textContent = emptyListText();
}

// What the empty table says: no part loaded, no parts open, or a part with nothing in its cut list.
function emptyListText() {
    if (currentPart) return "This part has no populated cut-list items. Update its cut list in SolidWorks, then click Refresh.";
    return partSelect.options.length > 1 ? "No part loaded. Choose one from the Part list, or click Refresh to load the active part."
        : "No parts are open. Open a part in SolidWorks, then click Refresh.";
}

// Unapplied Custom edits or lock changes that switching parts would discard.
function hasPendingEdits() {
    return input.entries.some((entry, index) => {
        const custom = customEntries[index], stored = entry.custom;
        if (Boolean(custom) !== Boolean(stored)) return true;
        if (custom && (custom.Description !== stored.Description || custom.Length !== stored.Length)) return true;
        const locks = locksByEntry[index];
        return locks && (Boolean(locks.Description) !== Boolean(entry.locks?.Description) || Boolean(locks.Length) !== Boolean(entry.locks?.Length));
    });
}

function switchToPart(key) {
    clearPartConfirm();
    finish("selectPart", undefined, undefined, {PartKey: key});
}

function askSwitch(key, text) {
    askConfirm(text, () => switchToPart(key));
}
// Asks in the banner under the toolbar before running `action` (switching parts or configurations).
function askConfirm(text, action) {
    partConfirmAction = action;
    document.querySelector("#part-confirm-text").textContent = text;
    partConfirm.hidden = false;
    document.querySelector("#part-confirm-yes").focus();
}

function clearPartConfirm() {
    partConfirmAction = null;
    partConfirm.hidden = true;
}

partSelect.addEventListener("change", () => {
    const key = partSelect.value;
    if (!key || key === currentPart || busy) { partSelect.value = currentPart; return; }
    const title = partSelect.selectedOptions[0]?.textContent ?? "the selected part";
    partSelect.value = currentPart;
    if (currentPart && hasPendingEdits())
        askSwitch(key, "Switch to " + title + "? Unapplied Custom edits and lock changes for this part will be discarded.");
    else switchToPart(key);
});
document.querySelector("#part-confirm-yes").addEventListener("click", () => { const action = partConfirmAction; if (action) action(); });
document.querySelector("#part-confirm-no").addEventListener("click", clearPartConfirm);

function handlePush(message) {
    if (message.type !== "parts") return;
    // Keep keyboard focus on the list if it was being used.
    const wasFocused = document.activeElement === partSelect;
    renderParts(message.parts, message.part, message.partTitle);
    if ("configuration" in message) showConfiguration(message);
    if (wasFocused) partSelect.focus();
    if (message.message) {
        clearPartConfirm();
        setHostStatus(message.message, true);
    }
    if (message.suggest && message.suggest !== currentPart) {
        showLabelPage();
        askSwitch(message.suggest, "Switch this window to " + message.suggestTitle + "?" +
            (hasPendingEdits() ? " Unapplied Custom edits and lock changes for this part will be discarded." : ""));
    }
}

// Excel and PDF exports both carry a thumbnail of each item, drawn here with the default view.
function exportList(Action) {
    if (!input || busy) return;
    try {
        // Drawn at twice the size, then scaled down, for smooth edges in Excel and the PDF.
        const large = document.createElement("canvas");
        large.width = 816;
        large.height = 510;
        const canvas = document.createElement("canvas");
        canvas.width = 408;
        canvas.height = 255;
        const images = input.entries.map(entry => {
            if (!entry.mesh?.length) return "";
            drawThumbnail(entry, large, defaultView());
            const context = canvas.getContext("2d");
            if (context) {
                context.clearRect(0, 0, canvas.width, canvas.height);
                context.imageSmoothingQuality = "high";
                context.drawImage(large, 0, 0, canvas.width, canvas.height);
            }
            return canvas.toDataURL("image/png").split(",")[1];
        });
        finish(Action, undefined, images);
    } catch (error) {
        status.textContent = "Could not prepare the export: " + error.message;
    }
}
document.querySelector("#export-excel").addEventListener("click", () => exportList("export"));
document.querySelector("#export-pdf").addEventListener("click", () => exportList("exportPdf"));

const settingsTabs = document.querySelectorAll("[data-settings-tab]");
for (const tab of settingsTabs) {
    tab.addEventListener("click", () => {
        for (const peer of settingsTabs) peer.setAttribute("aria-pressed", String(peer === tab));
        for (const page of document.querySelectorAll("[data-settings-page]"))
            page.hidden = page.dataset.settingsPage !== tab.dataset.settingsTab;
    });
}
