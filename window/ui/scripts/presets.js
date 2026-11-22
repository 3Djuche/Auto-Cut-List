import { $, gauge, names, setShared, shapeLabels, shared, sharedCase, unitModes } from "./state.js";
import { render } from "./labels.js";
import { buildRows } from "./table.js";
import { syncTemplateBar } from "./templates.js";
import { loadShapeRules, partShapes, renderShapeSettings, shapeRules } from "./weldment-shapes.js";
import { finish } from "./host.js";
import { askConfirm, clearPartConfirm, currentPart, hasPendingEdits } from "./parts.js";

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
        // Presets saved before millimeters had their own decimal places: one set while metric was chosen was for mm.
        const MetricDecimals = Number.isInteger(profile.MetricDecimals) && profile.MetricDecimals >= 0 && profile.MetricDecimals <= 8
            ? profile.MetricDecimals : Units === "metric" ? Decimals : 1;
        render(Description, sample, profile);
        render(Length, sample, profile);
        profiles[category] = {Description, Length, Decimals, MetricDecimals, Case, Units, LeadingZero: profile.LeadingZero !== false,
            Fractions: profile.Fractions === true, KeepCaps: profile.KeepCaps !== false,
            FractionDenominator: [2, 4, 8, 16, 32, 64].includes(profile.FractionDenominator) ? profile.FractionDenominator : 16};
        if (category === "part") {
            let shapes = {};
            // Presets saved before regular parts had shape templates get the default Cylinder template.
            const stored = typeof profile.ShapeTemplates === "string" ? profile.ShapeTemplates : shared.input?.defaults?.part?.ShapeTemplates;
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
    try { return validatePreset({version: 1, name: name || "Current", profiles: shared.input.settings}); }
    catch { return null; }
}

function updatePresetIndicator() {
    if (!shared.input) return;
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
        document.querySelector(id).disabled = !has || shared.busy;
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
        if (!shared.input || shared.busy) return;
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
    const candidate = validatePreset({version: 1, name: presetName.value, profiles: shared.input.settings});
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
        Object.assign(shared.input.settings[category], rest);
        if (category === "weldment" && presetShapes) {
            // The preset's rules, shapes and {profile} text replace the current ones; library choices are kept.
            shared.input.settings.weldment.ShapeRules = JSON.stringify({...JSON.parse(presetShapes), libraries: shapeRules.libraries});
            loadShapeRules(shared.input.settings.weldment.ShapeRules);
        }
    }
    renderShapeSettings();
    setShared("Case", sharedCase(shared.input.settings.sheet));
    setShared("Units", shared.input.settings.sheet.Units ?? "imperial");
    setShared("LeadingZero", shared.input.settings.sheet.LeadingZero !== false);
    setShared("Fractions", shared.input.settings.sheet.Fractions === true);
    setShared("KeepCaps", shared.input.settings.sheet.KeepCaps !== false);
    setShared("FractionDenominator", shared.input.settings.sheet.FractionDenominator || 16);
    gauge.checked = shared.input.settings.sheet.UseGauge;
    shared.input.settings.part.UseGauge = gauge.checked;
    for (const [key, control] of Object.entries(shapeLabels)) control.value = shared.input.settings.part[key];
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
    if (!name || name === currentConfiguration || shared.busy) return;
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

export { configSelect, initPresets, presetStatus, presets, renderPresets, showConfiguration, updatePresetIndicator };
