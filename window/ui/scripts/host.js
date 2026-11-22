import { $, apply, applyFont, applyTheme, customEntries, gauge, invoke, labelPage, locksByEntry, panel, save, selection, setShared, shapeLabels, shared, sharedCase, status, themeOf, thumbnailOptions, unitModes } from "./state.js";
import { buildRows, focusEntry } from "./table.js";
import { refresh, setTemplateCategory } from "./templates.js";
import { loadShapeRules } from "./weldment-shapes.js";
import { configSelect, initPresets, presetStatus, presets, renderPresets, showConfiguration } from "./presets.js";
import { batchPage, batchStatus, handlePush, partSelect, pendingOrder, renderParts, reorderApply, reorderPage, reorderStatus } from "./parts.js";

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
    const appliedNames = new Set((applied ?? []).map(index => shared.input.entries[index]?.name));
    const focusedName = shared.input.entries[shared.focused]?.name;
    const pending = new Map();
    if (keepPending) shared.input.entries.forEach((entry, index) => {
        if (!appliedNames.has(entry.name)) pending.set(entry.name, {custom: customEntries[index], locks: locksByEntry[index]});
    });
    shared.input.entries = entries;
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
    shared.focused = -2;
    buildRows();
    if (again >= 0 && [...document.querySelectorAll("#entries tr")].some(row => Number(row.dataset.index) === again)) focusEntry(again);
}

const quietActions = ["save", "presets", "presetExport", "presetImport", "shapes", "readLibrary"];
async function finish(Action, Selection, Thumbnails, extra = {}) {
    if (shared.busy || !shared.input) return null;
    shared.busy = true;
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
        await invoke("send_to_host", {message: {Action, RequestId, Settings: shared.input.settings, Custom: customEntries, Locks: locksByEntry,
            Selection, Thumbnails, Names: shared.input.entries.map(entry => entry.name),
            Descriptions: shared.input.entries.map(entry => entry.currentDescription ?? ""),
            Lengths: shared.input.entries.map(entry => entry.currentLength ?? ""), ...extra}});
        message = await reply;
        shared.busy = false;
        if (message.type === "saved") {
            const notice = $("#save-status");
            clearTimeout(shared.saveNoticeTimer);
            notice.textContent = "Settings saved.";
            shared.saveNoticeTimer = setTimeout(() => { notice.textContent = ""; }, 2000);
        } else if (message.type === "refresh") {
            // A different part's list never inherits edits from the previous part.
            loadEntries(message.entries, message.ok && Action === "apply" ? Selection : [],
                Action !== "selectPart" && Action !== "selectConfiguration");
            if (message.parts) renderParts(message.parts, message.part, message.partTitle);
            showConfiguration(message);
            shared.canUndo = Boolean(message.canUndo);
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
            shared.savedShapeRules = shared.input.settings.weldment.ShapeRules ?? "";
        // Anything SolidWorks couldn't put back, such as a part left on another configuration.
        if (message?.warning) setHostStatus([message.message, message.warning].filter(Boolean).join(" "), true);
    } catch (error) {
        hostReply = null;
        setHostStatus(String(error), true);
    } finally {
        clearTimeout(offerStop);
        stopWaiting.hidden = true;
        shared.busy = false;
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
$("#undo").addEventListener("click", () => { if (!shared.busy) finish("undo"); });
const warnOnSave = $("#warn-on-save");
warnOnSave.addEventListener("change", () => {
    Object.values(shared.input.settings).forEach(profile => { profile.WarnOnSave = warnOnSave.checked; });
});
$("#cancel").addEventListener("click", () => invoke("cancel"));

invoke("read_settings").then(data => {
    shared.input = data;
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
    shared.savedShapeRules = data.settings.weldment.ShapeRules ?? "";
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

export { finish, setHostStatus, showLabelPage };
