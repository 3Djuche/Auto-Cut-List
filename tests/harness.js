// Loads the window (window/ui) in jsdom with a simulated add-in in place of SolidWorks.
const {JSDOM} = require("jsdom");
const fs = require("fs");
const path = require("path");

const ui = path.join(__dirname, "..", "window", "ui");

// Measured sizes as the add-in sends them: text for 0 to 8 decimal places, in both unit systems.
const units = inches => ({
    imperial: Array.from({length: 9}, (_, places) => inches.toFixed(places)),
    metric: Array.from({length: 9}, (_, places) => (inches * 25.4).toFixed(places))
});

const profile = description => ({
    Description: description, Length: "{length}", Case: "upper", Units: "imperial", LeadingZero: true, Decimals: 3,
    UseGauge: false, DarkMode: false, DisplayStyle: "edges", BoxLabel: "Box", CylinderLabel: "Cylinder",
    Fractions: false, FractionDenominator: 16, ShapeTemplates: "", ShapeRules: ""
});

const defaultLibrary = "C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS\\lang\\english\\weldment profiles";

function libraryProfile(standard, type, size, library = defaultLibrary) {
    return {path: [library, standard, type, size + ".sldlfp"].join("\\"), configuration: "", standard, type, size, library};
}

function item(name, category, length, extra = {}) {
    return {
        name, category, type: {sheet: "Sheet", weldment: "Weldment", part: "Solid"}[category],
        gauge: "", callout: "", shape: category === "part" ? "Box" : "", mesh: [], meshFaces: [],
        thickness: units(0.06), width: units(10), length: units(length), quantity: "1",
        currentDescription: "", currentLength: "", locks: {}, custom: null, profile: {}, ...extra
    };
}

function settings() {
    return {sheet: profile("{type} {thickness} X {width}"), weldment: profile("{default}"), part: profile("{type} {thickness} X {width}")};
}

// Opens the window on `entries`. `respond(message)` may return the add-in's reply to a request.
async function openWindow({entries, parts, respond, overrides = {}} = {}) {
    const html = fs.readFileSync(path.join(ui, "index.html"), "utf8").replace(/<script[^>]*src=[^>]*><\/script>/g, "");
    const dom = new JSDOM(html, {runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/"});
    const window = dom.window;
    window.HTMLCanvasElement.prototype.getContext = () => null;
    parts = parts ?? [{key: "C:\\A.SLDPRT", title: "A.SLDPRT"}];
    const data = {version: "1.0.0", part: parts[0]?.key ?? "", partTitle: parts[0]?.title ?? "", parts, presets: [], activePreset: "",
        settings: settings(), defaults: settings(), entries: entries ?? [], ...overrides};
    const sent = [];
    const queue = [];
    let waiting = null;
    let closed = false;
    const push = message => {
        if (waiting) { const deliver = waiting; waiting = null; deliver(message); }
        else queue.push(message);
    };
    window.__TAURI__ = {core: {invoke: async (command, args) => {
        if (command === "read_settings") return JSON.parse(JSON.stringify(data));
        if (command === "next_message") return queue.length ? queue.shift() : new Promise(resolve => { waiting = resolve; });
        if (command === "cancel") { closed = true; return; }
        if (command === "send_to_host") {
            // Copy out of the window's realm so tests can compare with plain objects.
            const message = JSON.parse(JSON.stringify(args.message));
            sent.push(message);
            const reply = respond?.(message);
            if (reply) setTimeout(() => push(reply), 2);
        }
    }}};
    window.eval(fs.readFileSync(path.join(ui, "settings.js"), "utf8"));
    const $ = selector => window.document.querySelector(selector);
    const $$ = selector => [...window.document.querySelectorAll(selector)];
    const fire = (element, type) => element.dispatchEvent(new window.Event(type, {bubbles: true}));
    const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
    await tick();
    return {
        window, $, $$, fire, tick, sent, push,
        isClosed: () => closed,
        last: action => sent.filter(message => !action || message.Action === action).at(-1),
        row: name => [...$("#entries").rows].find(row => row.cells[1].firstChild.textContent === name),
        names: () => [...$("#entries").rows].map(row => row.cells[1].firstChild.textContent),
        // The proposed label shown for an item: "Description" or "Length".
        label: (name, field = "Description") => {
            const row = [...$("#entries").rows].find(candidate => candidate.cells[1].firstChild.textContent === name);
            const cell = row.cells[field === "Description" ? 5 : 6];
            return cell.querySelector("input")?.value ?? cell.querySelector(".label-value, .cell-error")?.textContent ?? cell.textContent;
        },
        tag: name => [...$("#entries").rows].find(row => row.cells[1].firstChild.textContent === name).cells[2].textContent,
        type: (element, value) => { element.value = value; fire(element, "input"); },
        choose: (name, value) => { const radio = $(`input[name="${name}"][value="${value}"]`); radio.checked = true; fire(radio, "change"); },
        select: (element, value) => { element.value = value; fire(element, "change"); },
        filter: key => $$("#category-filters button").find(button => button.dataset.filter === key).click()
    };
}

module.exports = {openWindow, item, units, libraryProfile, defaultLibrary, settings};
