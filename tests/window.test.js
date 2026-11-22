const test = require("node:test");
const assert = require("node:assert/strict");
const {openWindow, item, units, libraryProfile, settings} = require("./harness");

const refresh = (entries, message = "Done.") => ({type: "refresh", ok: true, message, entries,
    parts: [{key: "C:\\A.SLDPRT", title: "A.SLDPRT"}], part: "C:\\A.SLDPRT", partTitle: "A.SLDPRT"});

test("labels follow the templates, capitalization, units and leading-zero settings", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20), item("Small", "sheet", 0.75)]});
    assert.equal(app.label("P1"), "SHEET 0.060 X 10.000");
    assert.equal(app.label("Small", "Length"), "0.750");

    app.choose("case", "lower");
    assert.equal(app.label("P1"), "sheet 0.060 x 10.000");
    app.choose("case", "title");
    assert.equal(app.label("P1"), "Sheet 0.060 X 10.000");

    app.choose("leading-zero", "no");
    assert.equal(app.label("P1"), "Sheet .060 X 10.000");
    assert.equal(app.label("Small", "Length"), ".750");

    app.choose("units", "metric");
    assert.equal(app.label("P1"), "Sheet 1.524 X 254.000");
    assert.equal(app.$("#length-heading").textContent, "Length (mm)");
});

test("symbols keep their case and can be inserted at the cursor", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20)]});
    app.type(app.$("#description"), "plate \u00B5m \u00D8 45\u00B0");
    assert.equal(app.label("P1"), "PLATE \u00B5M \u00D8 45\u00B0");
    app.$("#description").focus();
    app.$("#description").setSelectionRange(5, 5);
    app.$$("#symbol-buttons button").find(button => button.textContent === "\u2300").click();
    assert.equal(app.$("#description").value, "plate\u2300 \u00B5m \u00D8 45\u00B0");
});

test("inch fractions apply to measured sizes and are off for metric", async () => {
    const app = await openWindow({entries: [item("P1", "part", 36.25, {thickness: units(0.25), width: units(1.5)})]});
    app.choose("fractions", "yes");
    assert.equal(app.label("P1"), "SOLID 1/4 X 1-1/2");
    assert.equal(app.label("P1", "Length"), "36-1/4");
    app.choose("units", "metric");
    assert.equal(app.label("P1", "Length"), "920.750");
    assert.equal(app.$('input[name="fractions"][value="yes"]').disabled, true);
});

test("only checked, changed items are applied, with the labels shown", async () => {
    const entries = [item("P1", "sheet", 20), item("P2", "sheet", 30, {currentDescription: "SHEET 0.060 X 10.000", currentLength: "30.000"})];
    const app = await openWindow({entries, respond: message => message.Action === "apply"
        ? refresh([{...entries[0], currentDescription: "SHEET 0.060 X 10.000", currentLength: "20.000"}, entries[1]], "1 cut-list entry updated.") : null});
    assert.equal(app.$("#apply").disabled, true);
    app.$("#select-all").click();
    assert.equal(app.$("#apply").textContent, "Apply 1 item");
    app.$("#apply").click();
    await app.tick();
    const request = app.last("apply");
    assert.deepEqual(request.Selection, [0]);
    assert.deepEqual(request.Labels, {0: {Description: "SHEET 0.060 X 10.000", Length: "20.000"}});
    assert.deepEqual(request.Names, ["P1", "P2"]);
    assert.equal(app.$("#host-status").textContent, "1 cut-list entry updated.");
    assert.equal(app.$("#apply").disabled, true);
});

test("an item that can't be measured must be labeled by hand", async () => {
    const bad = item("Bad", "sheet", 0, {problem: "the flat-pattern width is missing", currentDescription: "OLD", currentLength: "5"});
    const app = await openWindow({entries: [item("P1", "sheet", 20), bad]});
    assert.equal(app.row("Bad").cells[0].firstChild.disabled, true);
    assert.equal(app.label("Bad"), "Label by hand");
    app.row("Bad").click();
    app.$("#item-custom").click();
    assert.equal(app.tag("Bad"), "Custom");
    assert.equal(app.label("Bad"), "OLD");
    assert.equal(app.row("Bad").cells[0].firstChild.disabled, false);
    app.type(app.row("Bad").cells[5].querySelector("input"), "PLATE");
    assert.equal(app.$("#description").value, "PLATE");
});

test("keeping a linked weldment length clears the warning", async () => {
    const app = await openWindow({entries: [item("M1", "weldment", 40, {callout: "TS 2X2X1/4", lengthLinked: true, currentLength: "40"})]});
    const flag = icon => app.row("M1").cells[7].querySelector(`img[src="icons/${icon}"]`);
    assert.ok(flag("warning.svg"));
    assert.equal(flag("padlock.svg"), null);
    app.row("M1").click();
    app.$("#lock-length").click();
    assert.equal(flag("warning.svg"), null);
    assert.ok(flag("padlock.svg"), "a kept field shows the padlock");
    assert.equal(app.label("M1", "Length"), "40");
});

test("filters and search narrow the table", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20), item("M1", "weldment", 40, {callout: "W8X31"}), item("B1", "part", 5)]});
    app.filter("weldment");
    assert.deepEqual(app.names(), ["M1"]);
    app.filter("all");
    app.type(app.$("#search"), "b1");
    assert.deepEqual(app.names(), ["B1"]);
});

test("weldment members are sorted into shapes from their profile or callout", async () => {
    const app = await openWindow({entries: [
        item("SQ", "weldment", 36, {profile: libraryProfile("ansi inch", "square tube", "2 x 2 x 0.25")}),
        item("RT", "weldment", 48, {profile: libraryProfile("ansi inch", "rectangular tube", "3 x 2 x 0.1875")}),
        item("CH", "weldment", 20, {profile: {...libraryProfile("ansi inch", "c channel", ""), configuration: "C3 x 4.1", size: "C3 x 4.1"}}),
        item("WB", "weldment", 120, {callout: "W8X31"}),
        item("TS", "weldment", 30, {callout: "TS 2X2"}),
        item("HSS", "weldment", 30, {callout: "HSS 4x2x1/4"}),
        item("PIPE", "weldment", 24, {profile: libraryProfile("ansi inch", "pipe", "2.0 sch 40")}),
        item("ANG", "weldment", 24, {callout: "L2x2x1/4"}),
        item("ODD", "weldment", 24, {callout: "MYSTERY 7"})
    ]});
    assert.deepEqual(["SQ", "RT", "CH", "WB", "TS", "HSS", "PIPE", "ANG", "ODD"].map(app.tag),
        ["Sq tube", "Rect tube", "Channel", "W beam", "Sq tube", "Rect tube", "Pipe", "Angle", "Weldment"]);
});

test("round tube and square bar are shapes of their own, apart from pipe and flat bar", async () => {
    const app = await openWindow({entries: [
        item("RHSS", "weldment", 30, {callout: "HSS 2.375X0.154"}),
        item("RTUBE", "weldment", 30, {profile: libraryProfile("ansi inch", "round tube", "1.5 x 0.12")}),
        item("PIPE", "weldment", 24, {profile: libraryProfile("ansi inch", "pipe", "2 sch 40")}),
        item("SQB", "weldment", 12, {profile: libraryProfile("ansi inch", "square bar", "1")}),
        item("FB", "weldment", 12, {callout: "FB 2 x 0.25"})
    ]});
    assert.deepEqual(["RHSS", "RTUBE", "PIPE", "SQB", "FB"].map(app.tag), ["Rnd tube", "Rnd tube", "Pipe", "Sq bar", "Flat bar"]);
    // Each tag shows its shape's icon; a shape without one of its own uses the weldment icon.
    const icon = name => app.row(name).cells[2].querySelector("img").getAttribute("src");
    assert.deepEqual(["RHSS", "PIPE", "SQB", "FB"].map(icon),
        ["icons/round-tube.svg", "icons/pipe.svg", "icons/square-bar.svg", "icons/flat-bar.svg"]);

    // Their size fields: {od} and {wall} for round tube, {side1} for square bar.
    app.select(app.$("#template-category"), "weldment");
    app.select(app.$("#template-shape"), "round-tube");
    app.type(app.$("#description"), "RD TUBE {od} X {wall}");
    assert.equal(app.label("RTUBE"), "RD TUBE 1.5 X 0.12");
    app.select(app.$("#template-shape"), "square-bar");
    app.type(app.$("#description"), "SQ BAR {side1}");
    assert.equal(app.label("SQB"), "SQ BAR 1");
});

test("each shape can have its own template with its own fields", async () => {
    const app = await openWindow({entries: [
        item("SQ", "weldment", 36, {callout: "TS 2 X 2 X 1/4", profile: libraryProfile("ansi inch", "square tube", "2 x 2 x 0.25")}),
        item("RT", "weldment", 48, {callout: "TS 3 X 2 X 3/16", profile: libraryProfile("ansi inch", "rectangular tube", "3 x 2 x 0.1875")}),
        item("WB", "weldment", 120, {callout: "W8X31"}),
        item("PIPE", "weldment", 24, {profile: libraryProfile("ansi inch", "pipe", "2 sch 40")})
    ]});
    app.row("SQ").click();
    assert.equal(app.$("#template-shape").value, "square-tube");
    app.type(app.$("#description"), "TS {side1} X {side2} X {wall}");
    assert.equal(app.label("SQ"), "TS 2 X 2 X 0.25");
    assert.equal(app.label("RT"), "TS 3 X 2 X 3/16", "other shapes keep the All weldments template");

    app.row("WB").click();
    app.type(app.$("#description"), "W{depth} X {weight} {profile}");
    assert.equal(app.label("WB"), "W8 X 31 W BEAM");
    app.row("PIPE").click();
    app.type(app.$("#description"), "PIPE {nps} SCH {schedule}");
    assert.equal(app.label("PIPE"), "PIPE 2 SCH 40");

    app.choose("fractions", "yes");
    assert.equal(app.label("SQ"), "TS 2 X 2 X 1/4");

    app.row("SQ").click();
    app.$("#shape-reset").click();
    assert.equal(app.label("SQ"), "TS 2 X 2 X 1/4", "back on {default}, the callout");
    assert.equal(JSON.parse(app.last()?.Settings?.weldment?.ShapeTemplates ?? "{}")["square-tube"], undefined);
});

test("a custom profile library is read only when allowed, and its shapes can be assigned", async () => {
    const library = "D:\\Shop\\Profiles";
    const app = await openWindow({
        entries: [item("Z1", "weldment", 60, {callout: "Z 6X2", profile: libraryProfile("hss", "MYCO-Z", "Z 6x2x0.075", library)})],
        respond: message => message.Action === "shapes" ? {type: "shapes"}
            : message.Action === "readLibrary" ? {type: "library", path: message.LibraryPath, shapes: [{standard: "hss", type: "MYCO-Z", sizes: 4}]} : null
    });
    assert.equal(app.$("#library-banner").hidden, false);
    assert.equal(app.sent.length, 0, "nothing is read before the user agrees");
    app.$("#library-read").click();
    await app.tick(80);
    assert.equal(app.last("readLibrary").LibraryPath, library);
    assert.equal(app.$("#library-banner").hidden, true);

    app.$("#open-settings").click();
    app.$("#shape-name").value = "Z purlin";
    app.$("#shape-add").click();
    await app.tick();
    const choice = app.$("#part-profiles").rows[0].cells[2].querySelector("select");
    app.select(choice, [...choice.options].find(option => option.textContent === "Z purlin").value);
    await app.tick();
    app.$("#close-settings").click();
    assert.equal(app.tag("Z1"), "Z purlin");
    // The answer to the library prompt is kept straight away; the new shape and rule only with Save settings.
    const kept = JSON.parse(app.last("shapes").ShapeRules);
    assert.equal(kept.libraries[library].status, "read");
    assert.equal((kept.rules ?? []).length, 0, "unsaved rules aren't written");
    assert.equal(app.sent.filter(message => message.Action === "shapes").length, 1);
    app.$("#save").click();
    await app.tick();
    const saved = JSON.parse(app.last("save").Settings.weldment.ShapeRules);
    assert.equal(saved.rules[0].match, "MYCO-Z");
    assert.equal(saved.libraries[library].status, "read");
});

test("presets carry shape templates, rules and custom shapes", async () => {
    const rules = {rules: [{match: "MYCO-Z", family: "custom-z"}], custom: [{key: "custom-z", name: "Z purlin"}], labels: {}, libraries: {}};
    const weldment = {Description: "{default}", Length: "{length}", Decimals: 3, Case: "upper", Units: "imperial",
        ShapeTemplates: JSON.stringify({"custom-z": {Description: "Z {size1} X {size2}", Length: "{length}"}}), ShapeRules: JSON.stringify(rules)};
    const plain = {Description: "{type}", Length: "{length}", Decimals: 3, Case: "upper", Units: "imperial"};
    const app = await openWindow({
        entries: [item("Z1", "weldment", 60, {callout: "MYCO-Z 6x2"})],
        overrides: {presets: [{version: 1, name: "Shop", profiles: {sheet: plain, weldment, part: plain}}]},
        respond: message => message.Action === "presets" ? {type: "presets"} : null
    });
    assert.equal(app.tag("Z1"), "Weldment");
    app.$("#open-settings").click();
    app.select(app.$("#preset-list"), "Shop");
    app.$("#preset-load").click();
    await app.tick();
    app.$("#close-settings").click();
    assert.equal(app.tag("Z1"), "Z purlin");
    assert.equal(app.label("Z1"), "Z 6 X 2");
    assert.equal(JSON.parse(app.last("presets").Settings.weldment.ShapeRules).custom[0].name, "Z purlin");
    assert.equal(app.$("#preset-active").textContent, "Active preset: Shop");
});

test("saving a preset asks before replacing one with the same name", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20)], respond: message => message.Action === "presets" ? {type: "presets"} : null});
    app.$("#open-settings").click();
    app.$("#preset-name").value = "Shop A";
    app.$("#preset-store").click();
    await app.tick();
    assert.deepEqual(JSON.parse(app.last("presets").PresetsJson).map(preset => preset.name), ["Shop A"]);
    app.$("#preset-name").value = "shop a";
    app.$("#preset-store").click();
    assert.equal(app.$("#preset-confirm").hidden, false);
    assert.equal(app.sent.filter(message => message.Action === "presets").length, 1);
});

test("switching parts asks before discarding edits and never carries them over", async () => {
    const parts = [{key: "C:\\A.SLDPRT", title: "A.SLDPRT"}, {key: "C:\\B.SLDPRT", title: "B.SLDPRT"}];
    const app = await openWindow({entries: [item("Item1", "sheet", 20)], parts, respond: message => message.Action === "selectPart"
        ? {type: "refresh", ok: true, message: "Loaded.", entries: [item("Item1", "sheet", 99)], parts, part: parts[1].key, partTitle: "B.SLDPRT"} : null});
    app.row("Item1").click();
    app.$("#item-custom").click();
    app.select(app.$("#part-select"), parts[1].key);
    assert.equal(app.$("#part-confirm").hidden, false);
    assert.equal(app.sent.length, 0);
    app.$("#part-confirm-yes").click();
    await app.tick();
    assert.equal(app.last("selectPart").PartKey, parts[1].key);
    assert.equal(app.tag("Item1"), "Sheet");
    assert.equal(app.row("Item1").cells[4].textContent, "99.000");
});

test("the part list follows SolidWorks and the window closes with it", async () => {
    const parts = [{key: "C:\\A.SLDPRT", title: "A.SLDPRT"}];
    const app = await openWindow({entries: [item("P1", "sheet", 20)], parts});
    app.push({type: "parts", push: true, parts: [...parts, {key: "C:\\B.SLDPRT", title: "B.SLDPRT"}], part: parts[0].key, partTitle: "A.SLDPRT"});
    await app.tick();
    assert.deepEqual([...app.$("#part-select").options].map(option => option.textContent), ["A.SLDPRT", "B.SLDPRT"]);
    app.push(null);
    await app.tick();
    assert.equal(app.isClosed(), true);
});

test("material and end-cut angles are available as fields", async () => {
    const app = await openWindow({entries: [item("M1", "weldment", 40, {callout: "TS 2X2X1/4", material: "ASTM A36 Steel", angle1: "45.00\u00B0", angle2: "22.50"})]});
    app.row("M1").click();
    app.type(app.$("#description"), "{default} {material} {angle1}/{angle2}");
    assert.equal(app.label("M1"), "TS 2X2X1/4 ASTM A36 STEEL 45/22.5");
});

test("the last apply can be undone", async () => {
    const before = [item("P1", "sheet", 20)];
    const after = [{...before[0], currentDescription: "SHEET 0.060 X 10.000", currentLength: "20.000"}];
    const app = await openWindow({entries: before, respond: message =>
        message.Action === "apply" ? {...refresh(after, "1 cut-list entry updated."), canUndo: true}
        : message.Action === "undo" ? {...refresh(before, "Undid the last apply."), canUndo: false} : null});
    assert.equal(app.$("#undo").hidden, true);
    app.$("#select-all").click();
    app.$("#apply").click();
    await app.tick();
    assert.equal(app.$("#undo").hidden, false);
    app.$("#undo").click();
    await app.tick();
    assert.equal(app.last().Action, "undo");
    assert.equal(app.$("#undo").hidden, true);
    assert.equal(app.$("#host-status").textContent, "Undid the last apply.");
    assert.equal(app.row("P1").cells[5].querySelector(".was").textContent, "was blank");
});

test("an item whose model changed since labeling is flagged", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20, {stale: true, currentDescription: "SHEET 0.060 X 10.000", currentLength: "20.000"})]});
    assert.match(app.row("P1").cells[7].textContent, /\u21BB/);
    app.row("P1").click();
    assert.equal(app.$("#details-stale").hidden, false);
    app.$("#warn-on-save").click();
    app.$("#save").click();
    await app.tick();
    assert.equal(app.last("save").Settings.part.WarnOnSave, false);
});

test("all open parts can be labeled at once", async () => {
    const parts = [{key: "C:\\A.SLDPRT", title: "A.SLDPRT"}, {key: "C:\\B.SLDPRT", title: "B.SLDPRT"}, {key: "C:\\C.SLDPRT", title: "C.SLDPRT"}];
    const a = [item("A1", "sheet", 20)];
    const b = [item("B1", "part", 5), item("B2", "part", 6, {custom: {Description: "HAND", Length: "6"}, currentDescription: "HAND", currentLength: "6"})];
    const c = [item("C1", "sheet", 9, {currentDescription: "SHEET 0.060 X 10.000", currentLength: "9.000"})];
    const app = await openWindow({entries: a, parts, respond: message =>
        message.Action === "batchRead" ? {type: "batch", parts: [{...parts[0], error: "", entries: a}, {...parts[1], error: "", entries: b}, {...parts[2], error: "", entries: c}]}
        : message.Action === "batchApply" ? {...refresh(a, "2 cut-list entries updated in 2 parts. Save each part to keep the labels."), canUndo: true} : null});
    app.$("#open-batch").click();
    await app.tick();
    assert.equal(app.$("#batch-page").hidden, false);
    const rows = [...app.$("#batch-rows").rows];
    assert.deepEqual(rows.map(row => row.cells[3].textContent), ["1", "1", "0"]);
    assert.equal(rows[2].cells[0].firstChild.disabled, true, "a part that's already up to date can't be checked");
    assert.equal(app.$("#batch-apply").textContent, "Apply to 2 parts");
    app.$("#batch-apply").click();
    await app.tick();
    const batch = app.last("batchApply").Batch;
    assert.deepEqual(batch.map(request => request.PartKey), [parts[0].key, parts[1].key]);
    assert.deepEqual(batch[1].Selection, [0], "the hand-labeled item is left alone");
    assert.deepEqual(batch[1].Labels, {0: {Description: "SOLID 0.060 X 10.000", Length: "5.000"}});
    assert.deepEqual(batch[1].Custom, {1: {Description: "HAND", Length: "6"}});
    assert.equal(app.$("#batch-page").hidden, true);
    assert.equal(app.$("#undo").hidden, false);
});

test("the cut list can be exported to Excel or PDF", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20)], respond: message =>
        message.Action === "export" || message.Action === "exportPdf" ? {type: "done", message: "Exported 1 cut-list entries."} : null});
    app.$("#export-pdf").click();
    await app.tick();
    assert.equal(app.last().Action, "exportPdf");
    assert.equal(app.last().Thumbnails.length, 1);
    assert.equal(app.$("#host-status").textContent, "Exported 1 cut-list entries.");
    app.$("#export-excel").click();
    await app.tick();
    assert.equal(app.last().Action, "export");
});

test("the window has four themes, and older dark-mode settings still load", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20)]});
    const root = app.window.document.documentElement.classList;
    assert.equal(app.$('input[name="theme"]:checked').value, "white");
    app.choose("theme", "offwhite");
    assert.ok(root.contains("offwhite") && !root.contains("dark"));
    app.choose("theme", "gray");
    assert.ok(root.contains("dark") && root.contains("gray") && !root.contains("offwhite"));
    app.choose("theme", "black");
    assert.ok(root.contains("dark") && !root.contains("gray"));
    app.$("#save").disabled = false;
    app.$("#save").click();
    await app.tick();
    assert.equal(app.last("save").Settings.sheet.Theme, "black");
    assert.equal(app.last("save").Settings.part.DarkMode, true);

    // Settings saved before themes existed have only DarkMode.
    const saved = settings();
    for (const profile of Object.values(saved)) profile.DarkMode = true;
    const old = await openWindow({entries: [item("P1", "sheet", 20)], overrides: {settings: saved}});
    assert.equal(old.$('input[name="theme"]:checked').value, "black");
    assert.ok(old.window.document.documentElement.classList.contains("dark"));
});

test("the window font can be changed and is saved", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20)]});
    const font = () => app.window.document.documentElement.style.getPropertyValue("--font");
    assert.equal(app.$("#font-family").value, "Segoe UI");
    app.select(app.$("#font-family"), "Verdana");
    assert.match(font(), /^"Verdana"/);
    app.$("#save").disabled = false;
    app.$("#save").click();
    await app.tick();
    assert.equal(app.last("save").Settings.part.Font, "Verdana");

    const saved = settings();
    for (const profile of Object.values(saved)) profile.Font = "Calibri";
    const again = await openWindow({entries: [item("P1", "sheet", 20)], overrides: {settings: saved}});
    assert.equal(again.$("#font-family").value, "Calibri");
});

test("previews can use the part's SolidWorks colors, and the choice is saved", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20, {color: [0.8, 0.1, 0.1]})]});
    assert.equal(app.$("#part-colors").checked, true, "on by default");
    app.$("#part-colors").click();
    app.$("#save").disabled = false;
    app.$("#save").click();
    await app.tick();
    assert.equal(app.last("save").Settings.sheet.PartColors, false);

    const saved = settings();
    for (const profile of Object.values(saved)) profile.PartColors = false;
    const again = await openWindow({entries: [item("P1", "sheet", 20)], overrides: {settings: saved}});
    assert.equal(again.$("#part-colors").checked, false);
});

test("another configuration's cut list can be shown without switching SolidWorks", async () => {
    const short = [item("P1", "sheet", 20)];
    const long = [item("P1", "sheet", 40), item("P2", "sheet", 10)];
    const config = name => ({configuration: name, configurations: 2, configurationNames: ["Short", "Long"], activeConfiguration: "Short"});
    const app = await openWindow({entries: short, overrides: config("Short"), respond: message =>
        message.Action === "selectConfiguration" ? {...refresh(message.Configuration === "Long" ? long : short, "Loaded."), ...config(message.Configuration)}
        : message.Action === "apply" ? {...refresh(long, "Applied."), ...config("Long")} : null});
    const select = app.$("#config-select");
    assert.equal(select.hidden, false);
    assert.deepEqual([...select.options].map(option => option.textContent), ["Short (active)", "Long"]);

    // Showing a configuration that isn't active warns first: SolidWorks will mark the part as changed.
    app.select(select, "Long");
    assert.equal(app.$("#part-confirm").hidden, false);
    assert.match(app.$("#part-confirm-text").textContent, /marks it as changed/);
    assert.equal(app.last(), undefined, "nothing is sent until the warning is accepted");
    app.$("#part-confirm-yes").click();
    await app.tick();
    assert.equal(app.last().Action, "selectConfiguration");
    assert.equal(app.last().Configuration, "Long");
    assert.deepEqual(app.names(), ["P1", "P2"]);
    assert.equal(select.value, "Long");
    assert.match(select.title, /SolidWorks has Short active/);

    // Unapplied hand-typed labels are only discarded after asking.
    app.row("P2").click();
    app.$("#item-custom").click();
    app.select(select, "Short");
    assert.equal(app.$("#part-confirm").hidden, false);
    assert.equal(app.last().Action, "selectConfiguration");
    assert.equal(app.last().Configuration, "Long", "nothing is sent until the switch is confirmed");
    app.$("#part-confirm-yes").click();
    await app.tick();
    assert.equal(app.last().Configuration, "Short");
    assert.deepEqual(app.names(), ["P1"]);
});

test("a part with one configuration shows no configuration list", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20)], overrides: {configuration: "Default", configurations: 1, configurationNames: ["Default"]}});
    assert.equal(app.$("#config-select").hidden, true);
});

test("labels never show a size more finely than SolidWorks reported it", async () => {
    // Width rounded by SolidWorks to 0.01 in (0.000254 m): fine at 2 decimals, refused at 3.
    const app = await openWindow({entries: [item("P1", "sheet", 20, {rounding: [0, 0.000254, 0]})]});
    assert.match(app.row("P1").cells[5].querySelector(".cell-error").title, /fewer decimal places/);
    app.type(app.$("#decimals"), "2");
    assert.equal(app.label("P1"), "SHEET 0.06 X 10.00");
    // The measured-length column still shows the size.
    assert.equal(app.row("P1").cells[4].textContent, "20.00");
});

test("an unanswered request can be abandoned, and its late answer is ignored", async () => {
    const entries = [item("P1", "sheet", 20)];
    const app = await openWindow({entries, respond: () => null});
    app.$("#refresh").click();
    await app.tick();
    const first = app.last("refresh");
    assert.ok(first.RequestId > 0, "requests are numbered");
    assert.equal(app.$("#apply").disabled, true, "the window is busy while it waits");

    app.$("#stop-waiting").click();
    await app.tick();
    assert.match(app.$("#host-status").textContent, /Stopped waiting/);
    assert.equal(app.window.document.documentElement.classList.contains("busy"), false);

    // The late answer to the abandoned request doesn't answer the next one.
    app.$("#refresh").click();
    await app.tick();
    const second = app.last("refresh");
    assert.notEqual(second.RequestId, first.RequestId);
    app.push({...refresh(entries, "Late answer."), requestId: first.RequestId});
    await app.tick();
    assert.equal(app.window.document.documentElement.classList.contains("busy"), true, "still waiting for the second answer");
    app.push({...refresh(entries, "Reloaded."), requestId: second.RequestId});
    await app.tick();
    assert.equal(app.$("#host-status").textContent, "Reloaded.");
});

test("a part SolidWorks couldn't switch back is reported", async () => {
    const entries = [item("P1", "sheet", 20)];
    const app = await openWindow({entries, respond: message => message.Action === "refresh"
        ? {...refresh(entries, "Reloaded."), warning: "A.SLDPRT was left on configuration Long because SolidWorks wouldn't switch it back to Short."} : null});
    app.$("#refresh").click();
    await app.tick();
    assert.match(app.$("#host-status").textContent, /^Reloaded\. A\.SLDPRT was left on configuration Long/);
    assert.ok(app.$("#host-status").classList.contains("error"));
});

test("with Use gauge on, a thickness matching a standard gauge is labeled with it", async () => {
    const thick = inches => ({thickness: units(inches)});
    const app = await openWindow({entries: [
        item("STEEL", "sheet", 20, {...thick(0.1196), material: "Plain Carbon Steel"}),
        item("NOMAT", "part", 20, {...thick(0.0598), material: ""}),
        item("SS", "sheet", 20, {...thick(0.125), material: "AISI 304"}),
        item("ALU", "part", 20, {...thick(0.0907), material: "6061-T6 (SS)"}),
        item("GALV", "sheet", 20, {...thick(0.1233), material: "Galvanized Steel"}),
        item("ASSIGNED", "sheet", 20, {...thick(0.1196), material: "Plain Carbon Steel", gauge: "10 GA"}),
        item("METRIC", "sheet", 20, {...thick(3 / 25.4), material: "Plain Carbon Steel"}),
        item("BRASS", "part", 20, {...thick(0.1196), material: "Brass"}),
        item("PLATE", "sheet", 20, {...thick(0.25), material: "AISI 304"}),
        item("SSCAP", "part", 20, {...thick(0.1196), material: "AISI 304"})
    ]});
    const before = app.label("STEEL");
    assert.equal(before, "SHEET 0.120 X 10.000", "off by default");
    app.$("#use-gauge").click();
    assert.equal(app.label("STEEL"), "SHEET 11 GA X 10.000");
    assert.equal(app.label("NOMAT"), "SOLID 16 GA X 10.000", "regular parts too; no material means steel");
    assert.equal(app.label("SS"), "SHEET 11 GA X 10.000", "stainless table");
    assert.equal(app.label("ALU"), "SOLID 11 GA X 10.000", "aluminum (Brown & Sharpe) table");
    assert.equal(app.label("GALV"), "SHEET 11 GA X 10.000", "galvanized table");
    assert.equal(app.label("ASSIGNED"), "SHEET 10 GA X 10.000", "a gauge assigned in SolidWorks wins");
    assert.equal(app.label("METRIC"), "SHEET 0.118 X 10.000", "3 mm matches no gauge");
    assert.equal(app.label("BRASS"), "SOLID 0.120 X 10.000", "materials without a gauge table keep their size");
    assert.equal(app.label("PLATE"), "SHEET 0.250 X 10.000", "1/4 in stainless plate isn't called 3 GA");
    assert.equal(app.label("SSCAP"), "SOLID 11 GA X 10.000", "stainless at the steel gauge decimal");
    // {gauge} gives the matched gauge as well.
    app.type(app.$("#description"), "{gauge}");
    assert.equal(app.label("STEEL"), "11 GA");
});

test("title case can leave words typed in capitals alone", async () => {
    const app = await openWindow({entries: [item("P1", "sheet", 20, {gauge: "14 GA"})]});
    app.type(app.$("#description"), "stock {type} {gauge} ss plate");
    app.choose("case", "title");
    assert.equal(app.label("P1"), "Stock Sheet 14 GA Ss Plate");
    app.$("#keep-caps").click();
    assert.equal(app.label("P1"), "Stock Sheet 14 Ga Ss Plate");
    app.choose("case", "upper");
    assert.equal(app.$("#keep-caps").disabled, true);
});

test("every configuration of a part can be labeled in one go", async () => {
    const parts = [{key: "C:\\A.SLDPRT", title: "A.SLDPRT"}];
    const short = [item("A1", "sheet", 20)], long = [item("A1", "sheet", 40)];
    const app = await openWindow({entries: short, parts, overrides: {configuration: "Short", configurations: 2}, respond: message =>
        message.Action === "batchRead" ? {type: "batch", parts: message.AllConfigurations
            ? [{...parts[0], configuration: "Short", active: true, configurations: 2, error: "", entries: short},
               {...parts[0], configuration: "Long", active: false, configurations: 2, error: "", entries: long}]
            : [{...parts[0], configuration: "Short", active: true, configurations: 2, error: "", entries: short}]}
        : message.Action === "batchApply" ? {...refresh(short, "2 cut-list entries updated in 2 configurations of 1 part."), canUndo: true, configuration: "Short", configurations: 2} : null});
    assert.equal(app.$("#config-select").value, "Short");
    app.$("#open-batch").click();
    await app.tick();
    assert.equal(app.$("#batch-rows").rows.length, 1);
    assert.equal(app.last("batchRead").AllConfigurations, false);
    app.$("#batch-configs").click();
    await app.tick();
    assert.deepEqual([...app.$("#batch-rows").rows].map(row => row.cells[1].textContent), ["A.SLDPRT \u2014 Short", "A.SLDPRT \u2014 Long"]);
    app.$("#batch-apply").click();
    await app.tick();
    const batch = app.last("batchApply").Batch;
    assert.deepEqual(batch.map(request => request.Configuration), ["Short", "Long"]);
    assert.equal(batch[1].Labels[0].Length, "40.000");
    assert.equal(app.$("#config-select").value, "Short");
});

test("round regular parts use the Cylinder template with {diameter}; end caps stay plates", async () => {
    const cylinder = JSON.stringify({Cylinder: {Description: "{shape} {diameter} DIA", Length: "{length}"}});
    const part = {...settings().part, ShapeTemplates: cylinder, CylinderLabel: "RND"};
    const app = await openWindow({
        entries: [
            item("BAR", "part", 0.866, {shape: "Cylinder", thickness: units(1), width: units(1), diameter: units(1)}),
            item("CAP", "part", 2.375, {shape: "Box", endCap: true, thickness: units(0.12), width: units(2.375)})
        ],
        overrides: {settings: {...settings(), part}, defaults: {...settings(), part}}
    });
    assert.equal(app.label("BAR"), "RND 1.000 DIA");
    assert.equal(app.label("BAR", "Length"), "0.866");
    assert.equal(app.label("CAP"), "SOLID 0.120 X 2.375", "end caps use the regular template");
    // The Templates bar offers the Cylinder template for regular parts.
    app.row("BAR").cells[1].click();
    assert.equal(app.$("#template-shape").hidden, false);
    assert.equal(app.$("#template-shape").value, "Cylinder");
    assert.equal(app.$("#description").value, "{shape} {diameter} DIA");
    app.type(app.$("#description"), "ROUND {diameter}");
    assert.equal(app.label("BAR"), "ROUND 1.000");
    assert.equal(app.label("CAP"), "SOLID 0.120 X 2.375");
});

test("the window opens with no part, and Refresh loads one once it's open", async () => {
    const app = await openWindow({
        entries: [], parts: [],
        overrides: {part: "", partTitle: "", message: "No parts are open. Open a part in SolidWorks, then click Refresh to load its cut list."},
        respond: message => message.Action === "refresh" ? {type: "refresh", ok: true, requestId: message.RequestId,
            entries: [item("P1", "sheet", 20)], parts: [{key: "C:\\A.SLDPRT", title: "A.SLDPRT"}], part: "C:\\A.SLDPRT",
            partTitle: "A.SLDPRT", message: "Loaded 1 cut-list entries from A.SLDPRT."} : null
    });
    assert.match(app.$("#host-status").textContent, /No parts are open/);
    assert.equal(app.$("#part-select").value, "");
    assert.deepEqual(app.names(), []);
    assert.match(app.$("#empty-note").textContent, /No parts are open/);
    // Opening a part in SolidWorks updates the empty table's hint.
    app.push({type: "parts", push: true, parts: [{key: "C:\\A.SLDPRT", title: "A.SLDPRT"}], part: ""});
    await app.tick();
    assert.match(app.$("#empty-note").textContent, /No part loaded/);
    app.$("#refresh").click();
    await app.tick(60);
    assert.equal(app.last().Action, "refresh");
    assert.deepEqual(app.names(), ["P1"]);
    assert.equal(app.$("#part-select").value, "C:\\A.SLDPRT");
});
