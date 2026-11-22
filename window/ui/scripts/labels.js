import { applyCase, customEntries, fieldLocks, gaugeOf, shared, tokens } from "./state.js";
import { checkRounding, measuredText, partShapes, shapeField, shapeInfo, shapeTemplates, shapeTokens } from "./weldment-shapes.js";

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
    return computeState(shared.input.entries[index], customEntries[index], fieldLocks(index), index);
}

// The same, for any part's item: `custom` is its hand-typed labels (if any), `locks` its kept fields.
function computeState(entry, custom, locks, index) {
    const profile = shared.input.settings[entry.category];
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
    const profile = shared.input.settings[entry.category] ?? shared.input.settings.part;
    return measuredText(entry, "length", profile) || "\u2014";
}

function unitLabel() {
    return (shared.input.settings.sheet.Units ?? "imperial") === "metric" ? "mm" : "in";
}

export { computeState, formatAngle, itemState, measuredLength, render, unitLabel };
