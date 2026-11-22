const invoke = window.__TAURI__.core.invoke;
const $ = selector => document.querySelector(selector);
// Window state that more than one script file changes. (Files can read each other's names but, as modules,
// can't assign them, so state they all update lives here.)
const shared = {};

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
shared.canUndo = false;

shared.input = undefined;
shared.busy = false;
shared.saveNoticeTimer = undefined;
shared.focused = -1;
shared.filter = "all";           // category shown in the table: all, sheet, weldment, part or custom
shared.templateKey = "sheet";    // category whose templates the Templates bar edits
shared.states = [];              // proposed labels and change state for every item
shared.templatesInvalid = null;  // category name whose templates don't render, if any
shared.customInvalid = false;
const customEntries = {};      // items labeled by hand: index -> {Description, Length}
const locksByEntry = {};       // unapplied lock changes: index -> {Description, Length}
const selection = new Set();   // items checked for Apply

function fieldLocks(index) {
    return locksByEntry[index] ?? shared.input.entries[index]?.locks ?? {};
}
function categoryOf(index) {
    return customEntries[index] ? "custom" : shared.input.entries[index].category;
}

// ---------- Shared label settings ----------
const shapeLabels = {BoxLabel: $("#box-label"), CylinderLabel: $("#cylinder-label")};
const thumbnailOptions = {
    DisplayStyle: $("#display-style"),
    Shadows: $("#shadows"),
    Gloss: $("#gloss"),
    Cartoon: $("#cartoon"),
    Perspective: $("#perspective"),
    PartColors: $("#part-colors")
};
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
    Object.values(shared.input.settings).forEach(profile => { profile.Font = fontChoice.value; });
});

// Capitalization, units and leading zeros apply to every category, so keep each stored profile in step.
const caseModes = ["upper", "lower", "title"];
const unitModes = ["imperial", "metric"];
function setShared(key, value) {
    for (const profile of Object.values(shared.input.settings)) profile[key] = value;
    if (key === "LeadingZero") for (const choice of zeroChoices) choice.checked = (choice.value === "yes") === value;
    else if (key === "Fractions") for (const choice of fractionChoices) choice.checked = (choice.value === "yes") === value;
    else if (key === "KeepCaps") keepCaps.checked = value;
    else if (key === "FractionDenominator") fractionDenominator.value = String(value);
    else for (const choice of key === "Case" ? caseChoices : unitChoices) choice.checked = choice.value === value;
    if (key === "Case") keepCaps.disabled = value !== "title";
    if (key === "Units" || key === "Fractions") {
        const metric = (shared.input.settings.sheet.Units ?? "imperial") === "metric";
        for (const choice of fractionChoices) choice.disabled = metric;
        fractionDenominator.disabled = metric || !shared.input.settings.sheet.Fractions;
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

export { $, apply, applyCase, applyFont, applyTheme, caseChoices, categoryOf, changedOnlyBox, customEntries, decimals, description, entries, fieldLocks, formatNumber, fractionChoices, fractionDenominator, gauge, gaugeFromThickness, gaugeOf, gaugeTableFor, invoke, itemCustom, keepCaps, labelPage, length, lockDescription, lockLength, locksByEntry, names, panel, save, searchBox, selectAll, selection, setShared, shapeLabels, shared, sharedCase, status, tagNames, templateCategory, themeChoices, themeOf, thumbnail, thumbnailOptions, tokens, unitChoices, unitModes, zeroChoices };
