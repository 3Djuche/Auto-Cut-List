import { $, apply, customEntries, decimals, description, length, names, save, selection, shapeLabels, shared, status, templateCategory } from "./state.js";
import { itemState, render } from "./labels.js";
import { renderDetails, renderFilters, updateRows, updateSelection } from "./table.js";
import { decimalsFor, decimalsKey, partShapeOptions, renderLibraryBanner, renderShapeFilters, setShapeTemplate, shapeOptions, shapeTemplates } from "./weldment-shapes.js";
import { finish } from "./host.js";
import { updatePresetIndicator } from "./presets.js";

// ---------- Templates bar ----------
// Edits the category templates, or, when the selected item is labeled by hand, that item's own labels.
function setTemplateCategory(key) {
    shared.templateKey = key;
    templateCategory.value = key;
}

function customMode() {
    return shared.focused >= 0 && Boolean(customEntries[shared.focused]);
}

function syncTemplateBar() {
    if (!shared.input) return;
    const own = customMode();
    $("#templates-title").textContent = own ? "Labels for " + shared.input.entries[shared.focused].name + " (by hand)" : "Templates";
    templateCategory.hidden = own;
    $("#reset").hidden = own;
    decimals.hidden = $(".decimals-label").hidden = own;
    const shapeSelect = $("#template-shape");
    const shapes = !own && (shared.templateKey === "weldment" || shared.templateKey === "part");
    const everything = shared.templateKey === "part" ? "All regular parts" : "All weldments";
    shapeSelect.hidden = !shapes;
    if (shapes) {
        const general = document.createElement("option");
        general.value = "";
        general.textContent = everything;
        shapeSelect.replaceChildren(general, ...(shared.templateKey === "part" ? partShapeOptions(shared.templateShape) : shapeOptions(shared.templateShape)));
        shapeSelect.value = shared.templateShape;
    }
    const ownShape = shapes && shared.templateShape ? shapeTemplates(shared.templateKey)[shared.templateShape] : null;
    $("#shape-hint").hidden = !(shapes && shared.templateShape && !ownShape);
    $("#shape-hint").textContent = "Uses the " + everything + " template until you edit it";
    $("#shape-reset").textContent = "Use " + everything + " template";
    $("#shape-reset").hidden = !ownShape;
    const source = own ? customEntries[shared.focused] : ownShape ?? shared.input.settings[shared.templateKey];
    if (document.activeElement !== description) description.value = source.Description;
    if (document.activeElement !== length) length.value = source.Length;
    if (!own) decimals.value = String(decimalsFor(shared.input.settings[shared.templateKey]));
}

templateCategory.addEventListener("change", () => {
    setTemplateCategory(templateCategory.value);
    shared.templateShape = "";
    syncTemplateBar();
});
$("#template-shape").addEventListener("change", () => {
    shared.templateShape = $("#template-shape").value;
    syncTemplateBar();
});
$("#shape-reset").addEventListener("click", () => {
    setShapeTemplate(shared.templateShape, null, shared.templateKey);
    description.blur();
    length.blur();
    syncTemplateBar();
    refresh();
});
for (const control of [description, length, decimals]) {
    control.addEventListener("input", () => {
        if (!shared.input) return;
        if (customMode()) {
            customEntries[shared.focused] = {Description: description.value, Length: length.value};
        } else if ((shared.templateKey === "weldment" || shared.templateKey === "part") && shared.templateShape) {
            // Editing a shape's templates gives it its own; decimal places stay shared by the whole category.
            if (control !== decimals) setShapeTemplate(shared.templateShape, {Description: description.value, Length: length.value}, shared.templateKey);
            shared.input.settings[shared.templateKey][decimalsKey(shared.input.settings[shared.templateKey])] = Number(decimals.value);
            $("#shape-hint").hidden = true;
            $("#shape-reset").hidden = !shapeTemplates(shared.templateKey)[shared.templateShape];
        } else {
            shared.input.settings[shared.templateKey] = {...shared.input.settings[shared.templateKey],
                Description: description.value, Length: length.value,
                [decimalsKey(shared.input.settings[shared.templateKey])]: Number(decimals.value)};
        }
        refresh();
    });
}
$("#reset").addEventListener("click", () => {
    if (!shared.input) return;
    const defaults = shared.input.defaults[shared.templateKey];
    shared.input.settings[shared.templateKey] = {...shared.input.settings[shared.templateKey],
        Description: defaults.Description, Length: defaults.Length, Decimals: defaults.Decimals,
        MetricDecimals: defaults.MetricDecimals};
    if (shared.templateKey === "part") {
        Object.assign(shared.input.settings.part, {BoxLabel: defaults.BoxLabel, CylinderLabel: defaults.CylinderLabel});
        for (const [key, control] of Object.entries(shapeLabels)) control.value = shared.input.settings.part[key];
    }
    description.blur();
    length.blur();
    syncTemplateBar();
    refresh();
});

// Recompute proposed labels after any edit and update the table, details and buttons in place.
function refresh() {
    if (!shared.input || shared.busy) return;
    shared.states = shared.input.entries.map((entry, index) => itemState(index));
    const sample = {type: "", thickness: [], width: [], length: [], quantity: "", gauge: "", callout: "", shape: ""};
    shared.templatesInvalid = Object.keys(names).find(key => {
        const settings = shared.input.settings[key];
        try {
            render(settings.Description, sample, settings);
            render(settings.Length, sample, settings);
            return false;
        } catch {
            return true;
        }
    }) ?? null;
    if (!shared.templatesInvalid) {
        const sampleWeld = {...sample, category: "weldment"};
        const broken = Object.values(shapeTemplates()).some(template => {
            try { render(template.Description, sampleWeld, shared.input.settings.weldment); render(template.Length, sampleWeld, shared.input.settings.weldment); return false; }
            catch { return true; }
        });
        if (broken) shared.templatesInvalid = "weldment";
    }
    if (!shared.templatesInvalid) {
        const samplePart = {...sample, category: "part"};
        const broken = Object.values(shapeTemplates("part")).some(template => {
            try { render(template.Description, samplePart, shared.input.settings.part); render(template.Length, samplePart, shared.input.settings.part); return false; }
            catch { return true; }
        });
        if (broken) shared.templatesInvalid = "part";
    }
    shared.customInvalid = Object.keys(customEntries).some(index => shared.states[index]?.error && !shared.input.entries[index].problem);
    updateRows();
    updateSelection();
    renderFilters();
    renderShapeFilters();
    renderLibraryBanner();
    renderDetails(false);
    syncTemplateBar();
    updatePresetIndicator();
    save.disabled = Boolean(shared.templatesInvalid);
    $("#undo").hidden = !shared.canUndo;
    const own = customMode() ? shared.states[shared.focused]?.error : "";
    status.textContent = shared.templatesInvalid ? "Check the " + names[shared.templatesInvalid] + " templates: " + templateError(shared.templatesInvalid)
        : own ? own
        : shared.customInvalid ? "Check the labels of items labeled by hand." : "";
}

function templateError(key) {
    const sample = {type: "", thickness: [], width: [], length: [], quantity: "", gauge: "", callout: "", shape: ""};
    try { render(shared.input.settings[key].Description, sample, shared.input.settings[key]); render(shared.input.settings[key].Length, sample, shared.input.settings[key]); return ""; }
    catch (error) { return error.message; }
}

apply.addEventListener("click", () => {
    if (apply.disabled) return;
    const chosen = [...selection].sort((a, b) => a - b);
    const Labels = Object.fromEntries(chosen.map(index => [index, {Description: shared.states[index].description, Length: shared.states[index].length}]));
    finish("apply", chosen, undefined, {Labels});
});

export { refresh, setTemplateCategory, syncTemplateBar };
