using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SheetMetalCutList
{
    public sealed partial class AddIn
    {
        // Runs on SolidWorks' main thread for each request from the window, and always answers it.
        private void Handle(Session current, string line)
        {
            if (current.Ended || app == null) return;
            IpcRequest message = null;
            string unreadable = null;
            try { message = Serializer().Deserialize<IpcRequest>(line); }
            catch (Exception error) { unreadable = error.Message; }
            if (message == null)
            {
                // Still answer, or the window would wait forever. Its request number is read straight from the text.
                var number = Regex.Match(line ?? "", "\"RequestId\"\\s*:\\s*(\\d+)");
                int id;
                current.RequestId = number.Success && Int32.TryParse(number.Groups[1].Value, out id) ? id : 0;
                current.Warnings.Clear();
                Reply(current, new { type = "error", message = "The add-in couldn't read that request from the window" +
                    (unreadable == null ? "." : " (" + unreadable + ").") + " Nothing was changed." });
                current.RequestId = 0;
                return;
            }
            handling = true;
            current.RequestId = message.RequestId;
            current.Warnings.Clear();
            try
            {
                // Settings are saved only when the user saves them: Save settings, Apply (which saves the templates it
                // used), or loading/storing a preset. Other requests carry them for reading only, so trying out
                // templates and then refreshing or exporting doesn't make the experiment permanent.
                if (message.Settings != null && SavesSettings(message.Action))
                    foreach (var category in message.Settings) category.Value.Save(category.Key);
                if (message.Action == "save")
                {
                    Reply(current, new { type = "saved" });
                    return;
                }
                if (message.Action == "presets")
                {
                    PresetStore.Save(message.PresetsJson, message.ActivePreset);
                    Reply(current, new { type = "presets" });
                    return;
                }
                if (message.Action == "presetExport")
                {
                    Reply(current, ExportPreset(message, current));
                    return;
                }
                if (message.Action == "shapes")
                {
                    LabelSettings.SaveShapeRules(message.ShapeRules);
                    Reply(current, new { type = "shapes" });
                    return;
                }
                if (message.Action == "readLibrary")
                {
                    Reply(current, ReadLibrary(message.LibraryPath));
                    return;
                }
                if (message.Action == "presetImport")
                {
                    Reply(current, ImportPreset(current));
                    return;
                }

                if (message.Action == "undo")
                {
                    Reply(current, UndoLast(current));
                    return;
                }
                if (message.Action == "batchRead")
                {
                    var read = new List<object>();
                    foreach (var part in OpenPartDocs())
                    {
                        string active = ActiveConfiguration(part);
                        var names = ConfigurationNames(part);
                        var wanted = message.AllConfigurations && names.Count > 1 ? names : new List<string> { active };
                        try
                        {
                            foreach (var configuration in wanted)
                            {
                                try
                                {
                                    if (!Activate(part, configuration))
                                        throw new InvalidOperationException("SolidWorks couldn't switch to this configuration.");
                                    read.Add(new { key = PartKey(part), title = part.GetTitle(), configuration, active = configuration == active,
                                        configurations = names.Count, error = "", entries = Entries(ReadLabels(part), Serializer(), false) });
                                }
                                catch (Exception error)
                                {
                                    read.Add(new { key = PartKey(part), title = part.GetTitle(), configuration, active = configuration == active,
                                        configurations = names.Count, error = error.Message, entries = (object)new object[0] });
                                }
                            }
                        }
                        finally { SwitchBack(current, part, active); }
                    }
                    Reply(current, new { type = "batch", parts = read });
                    return;
                }
                if (message.Action == "batchApply")
                {
                    Reply(current, ApplyBatch(current, message));
                    return;
                }
                if (message.Action == "selectPart")
                {
                    var chosen = FindPart(message.PartKey);
                    if (chosen == null)
                    {
                        Reply(current, PartsReply(current, "That part is no longer open. The list of open parts was updated."));
                        return;
                    }
                    Reply(current, LoadPart(current, chosen));
                    return;
                }
                if (message.Action == "selectConfiguration")
                {
                    if (!IsOpen(current.Part))
                    {
                        Reply(current, PartsReply(current, NoPartMessage(current)));
                        return;
                    }
                    if (!ConfigurationNames(current.Part).Contains(message.Configuration ?? ""))
                        throw new InvalidOperationException("Configuration " + message.Configuration + " no longer exists in " + current.PartTitle + ".");
                    current.Configuration = message.Configuration;
                    Reply(current, InShownConfiguration(current, () => {
                        var shownLabels = ReadLabels(current.Part);
                        return RefreshReply(current, shownLabels, true, shownLabels.Count == 0
                            ? "Configuration " + current.Configuration + " has no populated cut-list entries."
                            : "Loaded " + shownLabels.Count + " cut-list entries from " + ShownName(current) + ".");
                    }));
                    return;
                }
                if (!IsOpen(current.Part))
                {
                    // Refresh with no part (the window was opened without one, or its part was closed) loads the part
                    // that's active in SolidWorks, or else the first open part.
                    var next = message.Action == "refresh" ? PartToLoad() : null;
                    if (next != null) Reply(current, LoadPart(current, next));
                    else Reply(current, PartsReply(current, NoPartMessage(current)));
                    return;
                }
                // Exports ask for the file first, so SolidWorks isn't left on another configuration while the dialog is open.
                string exportPath = null;
                if (message.Action == "export" || message.Action == "exportPdf")
                {
                    exportPath = AskExportPath(message.Action == "exportPdf", current.Process.MainWindowHandle);
                    if (exportPath == null)
                    {
                        Reply(current, new { type = "done", message = "Export canceled." });
                        return;
                    }
                    // SolidWorks stays usable while the dialog is open, so the part may have been closed meanwhile.
                    if (!IsOpen(current.Part))
                    {
                        Reply(current, PartsReply(current, current.PartTitle + " was closed, so nothing was exported."));
                        return;
                    }
                }
                Reply(current, InShownConfiguration(current, () => PartRequest(current, message, exportPath)));
            }
            catch (Exception error)
            {
                Reply(current, new { type = "error", message = error.Message });
            }
            finally
            {
                handling = false;
                current.RequestId = 0;
                current.Warnings.Clear();
            }
        }

        private static bool SavesSettings(string action)
        {
            return action == "save" || action == "apply" || action == "batchApply" || action == "presets";
        }

        // Refresh, apply, reorder and export for the part and configuration the window shows.
        private object PartRequest(Session current, IpcRequest message, string exportPath)
        {
            var labels = ReadLabels(current.Part);
            if (message.Action == "refresh")
                return RefreshReply(current, labels, true,
                    "Reloaded " + labels.Count + " cut-list entries from " + ShownName(current) + ".");
            string changed = null;
            if (message.Names == null || !labels.ConvertAll(label => label.Name).SequenceEqual(message.Names))
                changed = "The cut list changed in SolidWorks";
            else if (message.Action != "export" && message.Action != "exportPdf" && !LabelsMatch(labels, message))
                changed = "Labels were edited in SolidWorks";
            if (changed != null)
                return RefreshReply(current, labels, false,
                    changed + " since this list was loaded, so it was refreshed and nothing was changed. Check your changes and try again.");

            switch (message.Action)
            {
                case "apply":
                    PropertyJournal journal;
                    int applied = ApplyLabels(labels, message, out journal);
                    MarkWritten(current.Part);
                    current.Undo = new List<UndoStep> { new UndoStep { Part = current.Part, Title = ShownName(current),
                        Configuration = ActiveConfiguration(current.Part), Journal = journal } };
                    var after = ReadLabels(current.Part);
                    WarnIfNotReadBack(current, labels, after, message.Selection);
                    return RefreshReply(current, after, true,
                        applied + (applied == 1 ? " cut-list entry" : " cut-list entries") + " updated. Save the part to keep the labels.");
                case "reorder":
                    ReorderCutList(current.Part, labels, message.Selection);
                    MarkWritten(current.Part);
                    return RefreshReply(current, ReadLabels(current.Part), true,
                        "Cut list reordered. Save the part to keep the new order.");
                case "export":
                case "exportPdf":
                    // Stock totals follow the units shown in the window, saved or not.
                    LabelSettings weldment;
                    bool metric = message.Settings != null && message.Settings.TryGetValue("weldment", out weldment) && weldment != null
                        ? weldment.Units == "metric" : LabelSettings.LoadAll()["weldment"].Units == "metric";
                    WriteExport(exportPath, labels, message.Thumbnails, message.Action == "exportPdf", metric);
                    return new { type = "done", message = "Exported " + labels.Count + " cut-list entries to " + exportPath + "." };
                default:
                    throw new InvalidOperationException("Unknown request from the settings window: " + message.Action);
            }
        }

        // After Apply: if SolidWorks hands back something other than the labels just written, say so instead of
        // letting the table quietly show old values.
        private static void WarnIfNotReadBack(Session current, List<Label> written, List<Label> after, int[] selection)
        {
            var stale = new List<string>();
            foreach (int index in selection ?? new int[0])
            {
                if (index < 0 || index >= written.Count || index >= after.Count) continue;
                var label = written[index];
                if (label.Locks == null) continue;
                string description = Read(after[index].Manager, "Description") ?? "";
                string length = Read(after[index].Manager, "Length") ?? "";
                if ((!label.Locks.Description && label.Description != null && description != label.Description) ||
                    (!label.Locks.Length && label.Length != null && length != label.Length))
                    stale.Add(label.Name);
            }
            if (stale.Count > 0)
                current.Warnings.Add("The labels were written, but SolidWorks still reports the old ones for " + String.Join(", ", stale.Take(5)) +
                    (stale.Count > 5 ? " and " + (stale.Count - 5) + " more" : "") + ". Click Refresh; if they still look old, check the item's Properties in SolidWorks.");
        }

        private object RefreshReply(Session current, List<Label> labels, bool ok, string message)
        {
            return new {
                type = "refresh", ok = ok, entries = Entries(labels, Serializer()), message = message,
                parts = OpenParts(), part = PartKey(current.Part), partTitle = current.PartTitle,
                canUndo = current.Undo.Exists(step => IsOpen(step.Part)),
                configuration = current.Configuration, configurations = ConfigurationNames(current.Part).Count,
                configurationNames = ConfigurationNames(current.Part), activeConfiguration = current.SolidWorksConfiguration
            };
        }

        // Shows `part` in the window: its cut list, in its active configuration.
        private object LoadPart(Session current, IModelDoc2 part)
        {
            current.Part = part;
            current.PartTitle = part.GetTitle();
            current.Configuration = ActiveConfiguration(part);
            ResetWatch(current);
            return InShownConfiguration(current, () => {
                var labels = ReadLabels(part);
                return RefreshReply(current, labels, true, labels.Count == 0
                    ? "No populated cut-list entries in " + current.PartTitle + ". Update its cut list in SolidWorks, then click Refresh."
                    : "Loaded " + labels.Count + " cut-list entries from " + current.PartTitle + ".");
            });
        }

        // The part Refresh loads when the window has none: the active document if it's a part, else the first open part.
        private IModelDoc2 PartToLoad()
        {
            var active = app.ActiveDoc as IModelDoc2;
            if (active is IPartDoc && active.Visible) return active;
            foreach (var model in OpenPartDocs()) return model;
            return null;
        }

        private string NoPartMessage(Session current)
        {
            if (OpenParts().Count == 0) return "No parts are open. Open a part in SolidWorks, then click Refresh to load its cut list.";
            return current.Part == null ? "Choose a part from the Part list, or click Refresh to load the active part."
                : current.PartTitle + " has been closed. Choose an open part from the Part list.";
        }

        private object PartsReply(Session current, string message)
        {
            string key = IsOpen(current.Part) ? PartKey(current.Part) : "";
            return new { type = "parts", parts = OpenParts(), part = key, message = message };
        }

        private static object Entries(List<Label> labels, JavaScriptSerializer serializer, bool withMesh = true)
        {
            return labels.ConvertAll(label => {
                var mesh = withMesh ? PreviewMesh(label.Body, label.PartColor) : new MeshData();
                return new {
                name = label.Name,
                locks = ReadLocks(label.Manager),
                currentDescription = Read(label.Manager, "Description") ?? "",
                lengthSource = label.LengthSource,
                sortLength = ParseSortLength(Read(label.Manager, "Length")),
                currentLength = Read(label.Manager, "Length") ?? "",
                lengthLinked = IsLengthLinked(label.Manager),
                type = label.Type,
                category = label.Category,
                gauge = label.Gauge,
                callout = label.DefaultCallout,
                shape = label.Shape,
                custom = LabelSettings.ReadCustom(label.Manager, serializer),
                detectedShape = label.DetectedShape,
                mesh = mesh.Points,
                meshFaces = mesh.Faces,
                meshColors = mesh.FaceColors,
                color = mesh.BodyColor,
                problem = label.Problem,
                material = label.Material,
                angle1 = label.Angle1,
                angle2 = label.Angle2,
                stale = IsStale(label),
                profile = new {
                    path = label.Profile.Path, configuration = label.Profile.Configuration, standard = label.Profile.Standard,
                    type = label.Profile.Type, size = label.Profile.Size, library = label.Profile.Library
                },
                thickness = UnitOptions(label, 0),
                width = UnitOptions(label, 1),
                length = UnitOptions(label, 2),
                quantity = label.Quantity.ToString(CultureInfo.InvariantCulture),
                diameter = label.Diameter > 0 ? UnitOptions(label, 0) : null,
                endCap = label.EndCap,
                // Meters SolidWorks rounded thickness, width and length to (0 = exact); the window won't show finer digits.
                rounding = label.Dimensions == null || label.Rounding == null ? new double[3]
                    : label.Rounding.Select(step => (double)(step * label.MetersPerUnit)).ToArray()
                };
            });
        }

        private static System.Windows.Forms.DialogResult ShowOwned(System.Windows.Forms.CommonDialog dialog, Session current)
        {
            IntPtr window = IntPtr.Zero;
            try { current.Process.Refresh(); window = current.Process.MainWindowHandle; } catch (Exception) { }
            return window == IntPtr.Zero ? dialog.ShowDialog() : dialog.ShowDialog(new OwnerWindow(window));
        }

        private static object ExportPreset(IpcRequest message, Session current)
        {
            string name = String.IsNullOrWhiteSpace(message.PresetName) ? "Cut-list preset" : message.PresetName.Trim();
            var safe = new string(name.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c).ToArray());
            using (var dialog = new System.Windows.Forms.SaveFileDialog {
                Filter = "Cut-list preset (*.json)|*.json", DefaultExt = "json", AddExtension = true,
                OverwritePrompt = true, FileName = safe + ".json"
            })
            {
                if (ShowOwned(dialog, current) != System.Windows.Forms.DialogResult.OK)
                    return new { type = "done", message = "Export canceled." };
                File.WriteAllText(dialog.FileName, message.PresetJson ?? "", new UTF8Encoding(false));
                return new { type = "done", message = "Exported preset " + name + " to " + dialog.FileName + "." };
            }
        }

        private static object ImportPreset(Session current)
        {
            using (var dialog = new System.Windows.Forms.OpenFileDialog {
                Filter = "Cut-list preset (*.json)|*.json|All files (*.*)|*.*", CheckFileExists = true
            })
            {
                if (ShowOwned(dialog, current) != System.Windows.Forms.DialogResult.OK)
                    return new { type = "done", message = "Import canceled." };
                if (new FileInfo(dialog.FileName).Length > 1000000)
                    throw new InvalidOperationException("That file is too large to be a cut-list preset.");
                return new { type = "presetFile", text = File.ReadAllText(dialog.FileName), file = Path.GetFileName(dialog.FileName) };
            }
        }
    }
}
