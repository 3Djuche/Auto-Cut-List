using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Win32;

namespace SheetMetalCutList
{
    public sealed partial class AddIn
    {
        // Named template presets, one registry value per preset (its JSON), next to the other settings.
        private static class PresetStore
        {
            private const string PresetKey = @"Software\SheetMetalCutList\Presets";
            private const string SettingsKey = @"Software\SheetMetalCutList\Settings";

            public static List<object> Load()
            {
                var presets = new List<object>();
                var serializer = Serializer();
                using (var key = Registry.CurrentUser.OpenSubKey(PresetKey))
                {
                    if (key == null) return presets;
                    foreach (var name in key.GetValueNames().OrderBy(value => value, StringComparer.CurrentCultureIgnoreCase))
                    {
                        var text = key.GetValue(name) as string;
                        if (String.IsNullOrEmpty(text)) continue;
                        try { presets.Add(serializer.DeserializeObject(text)); }
                        catch (ArgumentException) { }
                        catch (InvalidOperationException) { }
                    }
                }
                return presets;
            }

            public static string Active()
            {
                using (var key = Registry.CurrentUser.OpenSubKey(SettingsKey))
                    return key == null ? "" : key.GetValue("ActivePreset") as string ?? "";
            }

            public static void Save(string json, string active)
            {
                var serializer = Serializer();
                var items = serializer.DeserializeObject(String.IsNullOrEmpty(json) ? "[]" : json) as object[];
                if (items == null) throw new InvalidOperationException("The preset list could not be read.");
                var keep = new Dictionary<string, string>();
                foreach (var item in items)
                {
                    var preset = item as Dictionary<string, object>;
                    object name;
                    if (preset == null || !preset.TryGetValue("name", out name) || !(name is string) || ((string)name).Trim().Length == 0) continue;
                    keep[((string)name).Trim()] = serializer.Serialize(preset);
                }
                using (var key = Registry.CurrentUser.CreateSubKey(PresetKey))
                {
                    foreach (var pair in keep) key.SetValue(pair.Key, pair.Value);
                    foreach (var name in key.GetValueNames())
                        if (!keep.ContainsKey(name)) key.DeleteValue(name, false);
                }
                using (var key = Registry.CurrentUser.CreateSubKey(SettingsKey))
                    key.SetValue("ActivePreset", active ?? "");
            }
        }
    }
}
