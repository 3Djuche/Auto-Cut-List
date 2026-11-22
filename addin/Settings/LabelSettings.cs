using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;

namespace SheetMetalCutList
{
    // Label templates and window options per category (sheet, weldment, part), kept in the registry under
    // HKCU\Software\SheetMetalCutList\Settings, plus a cut-list item's own custom templates.
    public sealed partial class AddIn
    {
        private sealed class LabelSettings
        {
            private const string Key = @"Software\SheetMetalCutList\Settings";
            private static LabelSettings Defaults(string category)
            {
                return new LabelSettings {
                    Description = category == "weldment" ? "{default}" : "{type} {thickness} X {width}",
                    Decimals = 3,
                    MetricDecimals = 1,
                    DisplayStyle = "edges",
                    Theme = "white",
                    PartColors = true,
                    Font = "Segoe UI",
                    BoxLabel = "Box",
                    CylinderLabel = "Cylinder",
                    Length = "{length}",
                    Case = "upper",
                    KeepCaps = true,
                    Units = "imperial",
                    LeadingZero = true,
                    Fractions = false,
                    FractionDenominator = 16,
                    // Round regular parts are labeled by diameter, with their length along the axis.
                    ShapeTemplates = category == "part"
                        ? "{\"Cylinder\":{\"Description\":\"{shape} {diameter} DIA\",\"Length\":\"{length}\"}}" : "",
                    ShapeRules = "",
                    WarnOnSave = true
                };
            }

            public string Description { get; set; }
            public string Length { get; set; }
            // "upper" (ALL CAPS), "lower" (no caps) or "title" (First Letter Of Every Word). Applies to every category.
            public string Case { get; set; }
            // "imperial" (inches) or "metric" (millimeters) for {thickness}, {width} and {length}. Applies to every category.
            // Title case only: leave words typed entirely in capitals as they are. Applies to every category.
            public bool KeepCaps { get; set; }
            public string Units { get; set; }
            // Whether numbers below one keep their leading zero (0.500) or drop it (.500). Applies to every category.
            public bool LeadingZero { get; set; }
            // Inch values as fractions (1-1/4) instead of decimals, rounded to 1/FractionDenominator. Every category.
            public bool Fractions { get; set; }
            public int FractionDenominator { get; set; }
            // Weldment only: per-shape templates, and shape rules / custom shapes / profile libraries (JSON from the window).
            public string ShapeTemplates { get; set; }
            public string ShapeRules { get; set; }

            public bool UseGauge { get; set; }
            // Decimal places for inches; MetricDecimals is the same for millimeters, so switching units keeps each.
            public int Decimals { get; set; }
            public int MetricDecimals { get; set; }
            public bool DarkMode { get; set; }
            // Window theme: "white", "offwhite", "gray" or "black". DarkMode stays in step (gray and black are dark).
            public string Theme { get; set; }
            // Window font, by family name. Applies to every category.
            public string Font { get; set; }
            private static readonly string[] Themes = { "white", "offwhite", "gray", "black" };
            // Warn when saving a part whose labels no longer match the model. Applies to every category.
            public bool WarnOnSave { get; set; }
            public string DisplayStyle { get; set; }
            public string BoxLabel { get; set; }
            public string CylinderLabel { get; set; }
            public bool Shadows { get; set; }
            public bool Gloss { get; set; }
            public bool Cartoon { get; set; }
            public bool Perspective { get; set; }
            // Show bodies in their SolidWorks appearance colors (otherwise one neutral color).
            public bool PartColors { get; set; }
            // A font family name: letters, digits, spaces and hyphens only, else the default.
            private static string SafeFont(string font)
            {
                return !String.IsNullOrWhiteSpace(font) && font.Length <= 64 && Regex.IsMatch(font, @"^[A-Za-z0-9 \-]+$")
                    ? font.Trim() : "Segoe UI";
            }

            public static bool HasCustom(ICustomPropertyManager manager)
            { return ReadCustom(manager, new JavaScriptSerializer()) != null; }

            public static LabelSettings ReadCustom(ICustomPropertyManager manager, JavaScriptSerializer serializer)
            {
                var value = Read(manager, "CutListLabelerCustom");
                if (String.IsNullOrEmpty(value) || value == "-") return null;
                try
                {
                    return serializer.Deserialize<LabelSettings>(Encoding.UTF8.GetString(Convert.FromBase64String(value)));
                }
                catch (FormatException) { return null; }
                catch (ArgumentException) { return null; }
            }
            public static Dictionary<string, LabelSettings> AllDefaults()
            {
                var defaults = new Dictionary<string, LabelSettings>();
                foreach (var category in new[] { "sheet", "weldment", "part" }) defaults.Add(category, Defaults(category));
                return defaults;
            }

            public static Dictionary<string, LabelSettings> LoadAll()
            {
                var settings = new Dictionary<string, LabelSettings>();
                foreach (var category in new[] { "sheet", "weldment", "part" })
                {
                    var profile = Defaults(category);
                    using (var key = Registry.CurrentUser.OpenSubKey(Key + "\\" + category) ??
                        Registry.CurrentUser.OpenSubKey(Key))
                    {
                        if (key != null)
                        {
                            var saved = (string)key.GetValue("Description", profile.Description);
                            if (category != "weldment" || key.GetValue("Decimals") != null ||
                                saved != "{type} {thickness} X {width}")
                                profile.Description = saved;
                            profile.DarkMode = (int)key.GetValue("DarkMode", 0) != 0;
                            // Settings saved before themes existed only have DarkMode.
                            var theme = key.GetValue("Theme") as string;
                            profile.Theme = Themes.Contains(theme) ? theme : profile.DarkMode ? "black" : "white";
                            profile.Font = SafeFont(key.GetValue("Font") as string);
                            profile.WarnOnSave = (int)key.GetValue("WarnOnSave", 1) != 0;
                            profile.BoxLabel = (string)key.GetValue("BoxLabel", "Box");
                            profile.CylinderLabel = (string)key.GetValue("CylinderLabel", "Cylinder");
                            profile.DisplayStyle = (string)key.GetValue("DisplayStyle", "edges");
                            profile.Shadows = (int)key.GetValue("Shadows", 0) != 0;
                            profile.Gloss = (int)key.GetValue("Gloss", 0) != 0;
                            profile.Cartoon = (int)key.GetValue("Cartoon", 0) != 0;
                            profile.Perspective = (int)key.GetValue("Perspective", 0) != 0;
                            profile.PartColors = (int)key.GetValue("PartColors", 1) != 0;
                            profile.Decimals = Math.Max(0, Math.Min(8, (int)key.GetValue("Decimals", 3)));
                            profile.Length = (string)key.GetValue("Length", profile.Length);
                            profile.Case = key.GetValue("Case") as string ??
                                ((int)key.GetValue("Uppercase", 1) != 0 ? "upper" : "title");
                            profile.KeepCaps = (int)key.GetValue("KeepCaps", 1) != 0;
                            profile.Units = key.GetValue("Units") as string ?? "imperial";
                            // Settings saved before millimeters had their own decimal places: Decimals set while
                            // metric was chosen was meant for millimeters.
                            profile.MetricDecimals = Math.Max(0, Math.Min(8, (int)key.GetValue("MetricDecimals",
                                profile.Units == "metric" ? profile.Decimals : 1)));
                            profile.LeadingZero = (int)key.GetValue("LeadingZero", 1) != 0;
                            profile.Fractions = (int)key.GetValue("Fractions", 0) != 0;
                            profile.FractionDenominator = Math.Max(2, Math.Min(64, (int)key.GetValue("FractionDenominator", 16)));
                            if (category == "part")
                                profile.ShapeTemplates = key.GetValue("ShapeTemplates") as string ?? profile.ShapeTemplates;
                            if (category == "weldment")
                            {
                                profile.ShapeTemplates = key.GetValue("ShapeTemplates") as string ?? "";
                                profile.ShapeRules = key.GetValue("ShapeRules") as string ?? "";
                            }
                            profile.UseGauge = (category == "sheet" || category == "part") && (int)key.GetValue("UseGauge", 0) != 0;
                        }
                    }
                    settings.Add(category, profile);
                }
                return settings;
            }

            // Answers to the custom-library prompt are saved straight away (with the shape rules as last saved).
            public static bool WarnOnSaveEnabled()
            {
                using (var key = Registry.CurrentUser.OpenSubKey(Key + "\\sheet"))
                    return key == null || (int)key.GetValue("WarnOnSave", 1) != 0;
            }

            public static void SaveShapeRules(string rules)
            {
                using (var key = Registry.CurrentUser.CreateSubKey(Key + "\\weldment"))
                    key.SetValue("ShapeRules", rules ?? "");
            }

            public void Save(string category)
            {
                using (var key = Registry.CurrentUser.CreateSubKey(Key + "\\" + category))
                {
                    key.SetValue("Description", Description);
                    string theme = Themes.Contains(Theme) ? Theme : DarkMode ? "black" : "white";
                    key.SetValue("Theme", theme);
                    key.SetValue("Font", SafeFont(Font));
                    key.SetValue("DarkMode", theme == "gray" || theme == "black" ? 1 : 0, RegistryValueKind.DWord);
                    key.SetValue("WarnOnSave", WarnOnSave ? 1 : 0, RegistryValueKind.DWord);
                    key.SetValue("BoxLabel", BoxLabel ?? "Box");
                    key.SetValue("CylinderLabel", CylinderLabel ?? "Cylinder");
                    key.SetValue("DisplayStyle", DisplayStyle ?? "edges");
                    key.SetValue("Shadows", Shadows ? 1 : 0, RegistryValueKind.DWord);
                    key.SetValue("Gloss", Gloss ? 1 : 0, RegistryValueKind.DWord);
                    key.SetValue("Cartoon", Cartoon ? 1 : 0, RegistryValueKind.DWord);
                    key.SetValue("Perspective", Perspective ? 1 : 0, RegistryValueKind.DWord);
                    key.SetValue("PartColors", PartColors ? 1 : 0, RegistryValueKind.DWord);
                    key.SetValue("Decimals", Decimals, RegistryValueKind.DWord);
                    key.SetValue("MetricDecimals", Math.Max(0, Math.Min(8, MetricDecimals)), RegistryValueKind.DWord);
                    key.SetValue("Length", Length);
                    key.SetValue("Case", Case == "lower" || Case == "title" ? Case : "upper");
                    key.SetValue("KeepCaps", KeepCaps ? 1 : 0, RegistryValueKind.DWord);
                    key.SetValue("Units", Units == "metric" ? "metric" : "imperial");
                    key.SetValue("LeadingZero", LeadingZero ? 1 : 0, RegistryValueKind.DWord);
                    key.SetValue("Fractions", Fractions ? 1 : 0, RegistryValueKind.DWord);
                    key.SetValue("FractionDenominator", FractionDenominator >= 2 && FractionDenominator <= 64 ? FractionDenominator : 16, RegistryValueKind.DWord);
                    if (category == "part") key.SetValue("ShapeTemplates", ShapeTemplates ?? "");
                    if (category == "weldment")
                    {
                        key.SetValue("ShapeTemplates", ShapeTemplates ?? "");
                        key.SetValue("ShapeRules", ShapeRules ?? "");
                    }
                    key.SetValue("UseGauge", UseGauge ? 1 : 0, RegistryValueKind.DWord);
                }
            }
        }
    }
}
