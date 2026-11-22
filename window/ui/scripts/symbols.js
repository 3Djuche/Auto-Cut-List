import { $, description, length } from "./state.js";

// ---------- Insert symbol ----------
// Puts a symbol at the cursor in the last Description or Length box used (the Templates bar or a table cell).
const symbols = [
    ["⌀", "Diameter"], ["Ø", "Diameter (O with stroke)"], ["°", "Degree"], ["±", "Plus or minus"],
    ["×", "Times"], ["″", "Inch (double prime)"], ["′", "Foot (prime)"], ["²", "Squared"],
    ["³", "Cubed"], ["≤", "Less than or equal to"], ["≥", "Greater than or equal to"],
    ["≈", "Approximately"], ["µ", "Micro"], ["½", "One half"], ["¼", "One quarter"], ["¾", "Three quarters"]
];
let lastTextField = null;
document.addEventListener("focusin", event => {
    const field = event.target;
    if (field === description || field === length || field.classList?.contains("cell-editor")) lastTextField = field;
});
function insertSymbol(symbol) {
    let field = lastTextField;
    if (!field || !field.isConnected || field.disabled || field.closest("[hidden]")) field = description;
    const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
    field.value = field.value.slice(0, start) + symbol + field.value.slice(end);
    field.focus();
    field.setSelectionRange(start + symbol.length, start + symbol.length);
    field.dispatchEvent(new Event("input", {bubbles: true}));
}
$("#symbol-buttons").replaceChildren(...symbols.map(([symbol, name]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = symbol;
    button.title = name;
    button.setAttribute("aria-label", "Insert " + name);
    // Keep the cursor in the text box.
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => insertSymbol(symbol));
    return button;
}));
$("#symbols-toggle").addEventListener("mousedown", event => event.preventDefault());
$("#symbols-toggle").addEventListener("click", () => {
    const bar = $("#symbol-buttons");
    bar.hidden = !bar.hidden;
    $("#symbols-toggle").setAttribute("aria-expanded", String(!bar.hidden));
});

