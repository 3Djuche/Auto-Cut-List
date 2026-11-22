using System.Collections.Generic;

namespace SheetMetalCutList
{
    // A request from the settings window: one line of JSON on its standard output.
    public sealed partial class AddIn
    {
        private sealed class IpcRequest
        {
            public string Action { get; set; }
            // Numbers each request; the reply carries the same number.
            public int RequestId { get; set; }
            public Dictionary<string, LabelSettings> Settings { get; set; }
            public Dictionary<string, LabelSettings> Custom { get; set; }
            public int[] Selection { get; set; }
            public string[] Thumbnails { get; set; }
            public Dictionary<string, FieldLocks> Locks { get; set; }
            public string[] Names { get; set; }
            public string[] Descriptions { get; set; }
            public string[] Lengths { get; set; }
            public string PresetsJson { get; set; }
            public string ActivePreset { get; set; }
            public string PresetName { get; set; }
            public string PresetJson { get; set; }
            public string PartKey { get; set; }
            // Batch: the configuration to apply to ("" = whichever is active), and whether to read every configuration.
            public string Configuration { get; set; }
            public bool AllConfigurations { get; set; }
            // "batchApply": one request per part, each with its own PartKey, Names, Selection and Labels.
            public IpcRequest[] Batch { get; set; }
            public string ShapeRules { get; set; }
            public string LibraryPath { get; set; }
            // Labels exactly as the window shows them, by item index; written as-is for the selected items.
            public Dictionary<string, LabelSettings> Labels { get; set; }
        }
    }
}
