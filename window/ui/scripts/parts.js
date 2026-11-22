import { $, customEntries, labelPage, locksByEntry, names, shared, status } from "./state.js";
import { computeState } from "./labels.js";
import { cellWith } from "./weldment-shapes.js";
import { defaultView, drawThumbnail } from "./preview.js";
import { finish, setHostStatus, showLabelPage } from "./host.js";
import { showConfiguration } from "./presets.js";

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
    const source = live ? shared.input.entries : part.entries;
    const partStates = source.map((entry, index) => live ? shared.states[index]
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
    batchApply.disabled = shared.busy || !count || Boolean(shared.templatesInvalid);
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
    if (!shared.input || shared.busy) return;
    if (shared.templatesInvalid) { setHostStatus("Fix the templates before applying to all open parts.", true); return; }
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
    if (shared.busy) return;
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
    if (!shared.input || shared.busy) return;
    const sorted = sortedCutList(shared.input.entries);
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
    if (shared.busy) return;
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
    if (shared.input && !shared.input.entries.length) $("#empty-note").textContent = emptyListText();
}

// What the empty table says: no part loaded, no parts open, or a part with nothing in its cut list.
function emptyListText() {
    if (currentPart) return "This part has no populated cut-list items. Update its cut list in SolidWorks, then click Refresh.";
    return partSelect.options.length > 1 ? "No part loaded. Choose one from the Part list, or click Refresh to load the active part."
        : "No parts are open. Open a part in SolidWorks, then click Refresh.";
}

// Unapplied Custom edits or lock changes that switching parts would discard.
function hasPendingEdits() {
    return shared.input.entries.some((entry, index) => {
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
    if (!key || key === currentPart || shared.busy) { partSelect.value = currentPart; return; }
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
    if (!shared.input || shared.busy) return;
    try {
        // Drawn at twice the size, then scaled down, for smooth edges in Excel and the PDF.
        const large = document.createElement("canvas");
        large.width = 816;
        large.height = 510;
        const canvas = document.createElement("canvas");
        canvas.width = 408;
        canvas.height = 255;
        const images = shared.input.entries.map(entry => {
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

export { askConfirm, batchPage, batchStatus, clearPartConfirm, currentPart, emptyListText, handlePush, hasPendingEdits, partSelect, pendingOrder, renderParts, reorderApply, reorderPage, reorderStatus };
