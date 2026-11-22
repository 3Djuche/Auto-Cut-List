import { $, apply, categoryOf, changedOnlyBox, customEntries, entries, fieldLocks, gaugeFromThickness, gaugeTableFor, itemCustom, lockDescription, lockLength, locksByEntry, names, searchBox, selectAll, selection, shared, tagNames } from "./state.js";
import { formatAngle, itemState, measuredLength, unitLabel } from "./labels.js";
import { refresh, setTemplateCategory, syncTemplateBar } from "./templates.js";
import { isDefaultLibrary, measuredText, partShapes, shapeByKey, shapeIcon, shapeInfo } from "./weldment-shapes.js";
import { defaultView, drawThumbnail } from "./preview.js";
import { emptyListText } from "./parts.js";

// ---------- Table ----------
function visibleIndices() {
    const query = searchBox.value.trim().toLowerCase();
    return shared.input.entries.map((entry, index) => index).filter(index => {
        if (shared.filter !== "all" && categoryOf(index) !== shared.filter) return false;
        if (shared.filter === "weldment" && shared.shapeFilter !== "all" && shapeInfo(shared.input.entries[index])?.family !== shared.shapeFilter) return false;
        const state = shared.states[index];
        if (changedOnlyBox.checked && !(state.changed || state.error)) return false;
        if (!query) return true;
        const entry = shared.input.entries[index];
        return [entry.name, state.description, state.length, entry.currentDescription, entry.currentLength]
            .some(value => (value ?? "").toLowerCase().includes(query));
    });
}

// Rebuild the rows (after loading, filtering or moving items between Custom and templates).
function buildRows() {
    if (!shared.input) return;
    shared.states = shared.input.entries.map((entry, index) => itemState(index));
    const visible = visibleIndices();
    entries.replaceChildren(...visible.map(createRow));
    const note = $("#empty-note");
    note.hidden = visible.length > 0;
    note.textContent = !shared.input.entries.length ? emptyListText() : "No items match the current filter.";
    if (!visible.includes(shared.focused)) focusEntry(visible.length ? visible[0] : -1);
    refresh();
}

function createRow(index) {
    const entry = shared.input.entries[index];
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
    const entry = shared.input.entries[index];
    const state = shared.states[index];
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
            editor.addEventListener("focus", () => { if (shared.focused !== index) focusEntry(index); });
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
        const state = shared.states[index];
        const entry = shared.input.entries[index];
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
        row.classList.toggle("focused", index === shared.focused);
    }
    $("#length-heading").textContent = "Length (" + unitLabel() + ")";
}

function selectableShown() {
    return [...entries.rows].map(row => Number(row.dataset.index)).filter(index => shared.states[index].changed);
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
    $("#make-custom").disabled = shared.busy || ![...selection].some(index => !customEntries[index]);
    $("#make-automatic").disabled = shared.busy || ![...selection].some(index => customEntries[index]);
    apply.textContent = count ? "Apply " + count + (count === 1 ? " item" : " items") : "Apply";
    const brokenCustom = [...selection].some(index => customEntries[index] && shared.states[index]?.error);
    apply.disabled = shared.busy || !count || Boolean(shared.templatesInvalid) || brokenCustom;
    // Say why Apply can't be used yet.
    apply.title = shared.busy ? "Waiting for SolidWorks to finish the last request."
        : !count ? (shown.length ? "Check the items to apply in the table (or use the box in its header to check every changed item)."
            : "Nothing to apply: every item's labels already match the templates.")
        : shared.templatesInvalid ? "Fix the " + (names[shared.templatesInvalid] ?? shared.templatesInvalid) + " templates first."
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
        shared.filter = key;
        shared.shapeFilter = "all";
        if (key !== "all" && key !== "custom") { setTemplateCategory(key); shared.templateShape = ""; syncTemplateBar(); }
        buildRows();
    });
    return [key, button];
}));
$("#category-filters").replaceChildren(...Object.values(filterButtons));

function renderFilters() {
    const counts = {all: shared.input.entries.length, sheet: 0, weldment: 0, part: 0, custom: 0};
    shared.input.entries.forEach((entry, index) => counts[categoryOf(index)]++);
    for (const key of filterKeys) {
        const button = filterButtons[key];
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = counts[key];
        button.replaceChildren(...categoryIcon(key), filterLabels[key], count);
        button.setAttribute("aria-pressed", String(shared.filter === key));
        button.hidden = key !== "all" && key !== shared.filter && counts[key] === 0;
    }
}

// ---------- Details pane ----------
function renderDetails(redraw = true) {
    const entry = shared.input?.entries[shared.focused];
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
    const profile = shared.input.settings[entry.category];
    const units = unitLabel();
    const size = entry.problem ? "" : ["thickness", "width", "length"]
        .map(key => measuredText(entry, key, profile)).join(" \u00D7 ") + " " + units;
    const shape = shapeInfo(entry);
    const source = entry.profile ?? {};
    const rows = [
        ["Category", customEntries[shared.focused] ? "Labeled by hand (" + names[entry.category] + ")" : names[entry.category]],
        ["Quantity", entry.quantity],
        ["Size", size],
        ["Shape", entry.category === "part" ? (entry.endCap ? "Plate (end cap)" : entry.shape) : shape ? shapeByKey(shape.family).name : ""],
        ["Diameter", entry.diameter ? measuredText(entry, "diameter", shared.input.settings.part) + " " + unitLabel() : ""],
        ["Profile", shape ? [source.standard, source.type, shape.sizeText].filter(Boolean).join(" \u00B7 ") : ""],
        ["Library", source.library ? (isDefaultLibrary(source.library) ? "SolidWorks default" : source.library) : ""],
        ["Gauge", entry.gauge || (shared.input.settings[entry.category]?.UseGauge && gaugeFromThickness(entry)
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
    const locks = fieldLocks(shared.focused);
    itemCustom.checked = Boolean(customEntries[shared.focused]);
    lockDescription.checked = Boolean(locks.Description);
    lockLength.checked = Boolean(locks.Length);
    const stale = $("#details-stale");
    stale.hidden = !entry.stale;
    stale.textContent = entry.stale ? "The model changed since this item was labeled, so its labels may be out of date." +
        (shared.states[shared.focused]?.changed ? "" : " The templates still give the same labels; if it's labeled by hand or kept, check it.") : "";
    linked.hidden = !entry.lengthLinked;
    linked.textContent = entry.lengthLinked ? (locks.Length
        ? "Length stays linked to SolidWorks' cut length."
        : "Length is linked to SolidWorks' cut length. Applying replaces it with fixed text that won't update if the member changes. Check Keep current Length to keep the link.") : "";
}

itemCustom.addEventListener("change", () => { if (shared.focused >= 0) setCustom([shared.focused], itemCustom.checked); });
for (const control of [lockDescription, lockLength]) {
    control.addEventListener("change", () => {
        if (shared.focused < 0) return;
        locksByEntry[shared.focused] = {Description: lockDescription.checked, Length: lockLength.checked};
        refresh();
    });
}

// Label items by hand (Custom) or go back to the category templates.
function setCustom(indices, on) {
    for (const index of indices) {
        const entry = shared.input.entries[index];
        if (on && !customEntries[index]) {
            // Unmeasured items start from their stored labels; others from what the template produces now.
            const state = shared.states[index];
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
    if (shared.focused !== index) shared.view = defaultView();
    shared.focused = index;
    const entry = shared.input?.entries[index];
    if (entry && !customEntries[index]) {
        setTemplateCategory(entry.category);
        shared.templateShape = entry.category === "weldment" ? shapeInfo(entry).family
            : entry.category === "part" && partShapes.some(item => item.key === entry.shape) ? entry.shape : "";
    }
    for (const row of entries.rows) row.classList.toggle("focused", Number(row.dataset.index) === index);
    renderDetails(true);
    syncTemplateBar();
}

export { buildRows, categoryIcon, focusEntry, renderDetails, renderFilters, updateRows, updateSelection };
