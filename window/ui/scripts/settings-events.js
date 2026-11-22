import { $, applyTheme, caseChoices, fractionChoices, fractionDenominator, gauge, keepCaps, labelPage, panel, setShared, shapeLabels, shared, themeChoices, thumbnailOptions, unitChoices, zeroChoices } from "./state.js";
import { refresh } from "./templates.js";
import { renderShapeSettings } from "./weldment-shapes.js";
import { drawThumbnail } from "./preview.js";
import { renderPresets } from "./presets.js";

// ---------- Settings that redraw the window ----------
// Event hookups for the shared label settings and the Settings panel. They call into the table, the preview and the
// presets, so they load after all of those, which lets state.js import nothing.
for (const [key, control] of Object.entries(shapeLabels)) {
    control.addEventListener("input", () => {
        shared.input.settings.part[key] = control.value;
        refresh();
    });
}
for (const [key, control] of Object.entries(thumbnailOptions)) {
    control.addEventListener("change", () => {
        const value = key === "DisplayStyle" ? control.value : control.checked;
        Object.values(shared.input.settings).forEach(profile => { profile[key] = value; });
        drawThumbnail(shared.input.entries[shared.focused]);
    });
}
for (const choice of themeChoices) {
    choice.addEventListener("change", () => {
        if (!choice.checked) return;
        applyTheme(choice.value);
        Object.values(shared.input.settings).forEach(profile => {
            profile.Theme = choice.value;
            profile.DarkMode = choice.value === "gray" || choice.value === "black";
        });
        drawThumbnail(shared.input.entries[shared.focused]);
    });
}
// "Use gauge" applies to sheet metal and regular parts alike.
gauge.addEventListener("change", () => {
    shared.input.settings.sheet.UseGauge = shared.input.settings.part.UseGauge = gauge.checked;
    refresh();
});
$("#open-settings").addEventListener("click", () => {
    if (!shared.input) return;
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
for (const choice of caseChoices) choice.addEventListener("change", () => { if (choice.checked) { setShared("Case", choice.value); refresh(); } });
keepCaps.addEventListener("change", () => { setShared("KeepCaps", keepCaps.checked); refresh(); });
for (const choice of unitChoices) choice.addEventListener("change", () => { if (choice.checked) { setShared("Units", choice.value); refresh(); } });
for (const choice of zeroChoices) choice.addEventListener("change", () => { if (choice.checked) { setShared("LeadingZero", choice.value === "yes"); refresh(); } });
for (const choice of fractionChoices) choice.addEventListener("change", () => { if (choice.checked) { setShared("Fractions", choice.value === "yes"); refresh(); } });
fractionDenominator.addEventListener("change", () => { setShared("FractionDenominator", Number(fractionDenominator.value)); refresh(); });
