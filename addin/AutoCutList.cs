using System;
using System.Globalization;
using System.Linq;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Text.RegularExpressions;
using System.Reflection;

using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;
using SolidWorks.Interop.swpublished;

[assembly: ComVisible(false)]
[assembly: AssemblyTitle("Auto Cut List")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace SheetMetalCutList
{
    [Guid("B0B116CE-FAD5-4B33-9DB0-E1ED77E98884")]
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDispatch)]
    public sealed class AddIn : ISwAddin
    {
        // Shown in the window. Keep in step with AssemblyVersion above.
        public const string Version = "1.0.0";
        private const int GroupId = 681205;
        private ISldWorks app;
        private ICommandManager commands;
        // Parts being watched so a save can warn about labels the model has outgrown.
        private SldWorks swEvents;
        private DSldWorksEvents_ActiveDocChangeNotifyEventHandler activeDocChanged;
        private readonly List<WatchedPart> watched = new List<WatchedPart>();
        // Posts work from the window's reader thread back to SolidWorks' main thread, where API calls must run.
        private System.Windows.Forms.Control dispatcher;
        private Session session;
        // While the window is open, keeps its Part list in step with the parts open in SolidWorks.
        private System.Windows.Forms.Timer partWatcher;
        private string lastParts;
        private bool lastPartOpen;
        private string lastConfiguration = "";
        // True while a request from the window is being handled, so the watcher doesn't report the
        // configuration switches that request makes.
        private bool handling;
        // Requests from the window waiting their turn. A request can show a dialog or call Excel, and both keep
        // SolidWorks' message loop running, which would otherwise start the next request in the middle of this one.
        private readonly Queue<KeyValuePair<Session, string>> requests = new Queue<KeyValuePair<Session, string>>();
        private bool draining;

        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);

        [ComRegisterFunction]
        public static void Register(Type type)
        {
            using (var key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\SOLIDWORKS\AddIns\" + type.GUID.ToString("B")))
            {
                key.SetValue("", 0, RegistryValueKind.DWord);
                key.SetValue("Title", "Auto Cut List");
                key.SetValue("Description", "Label sheet-metal, weldment and solid-body cut-list items.");
                // Shown next to the add-in in Tools > Add-Ins. Install.ps1 copies the icons before registering.
                string icon = Path.Combine(Path.GetDirectoryName(type.Assembly.Location), "icons", "auto-cut-list_16.png");
                if (File.Exists(icon)) key.SetValue("Icon Path", icon);
            }
        }

        [ComUnregisterFunction]
        public static void Unregister(Type type)
        {
            Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\SOLIDWORKS\AddIns\" + type.GUID.ToString("B"), false);
            Registry.CurrentUser.DeleteSubKeyTree(@"SOFTWARE\SOLIDWORKS\AddInsStartup\" + type.GUID.ToString("B"), false);
        }

        public bool ConnectToSW(object solidWorks, int cookie)
        {
            app = (ISldWorks)solidWorks;
            try
            {
                if (!app.SetAddinCallbackInfo2(0, this, cookie))
                    throw new InvalidOperationException("SolidWorks could not register the add-in callbacks.");
                dispatcher = new System.Windows.Forms.Control();
                if (dispatcher.Handle == IntPtr.Zero)
                    throw new InvalidOperationException("Could not create the add-in's message window.");
                commands = app.GetCommandManager(cookie);
                int error = 0;
                // SolidWorks remembers a command group's layout and, when told to reuse it, rebuilds the menu from that
                // without the command's icon. The group is a single command with nothing worth keeping, so SolidWorks
                // is told to build it fresh on every start, icon included.
                var group = commands.CreateCommandGroup2(GroupId, "Auto Cut List",
                    "Label cut-list items", "Auto Cut List", -1, true, ref error);
                if (group == null)
                    throw new InvalidOperationException("Could not create the command group (" + error + ").");

                // The command's icon, one PNG per size SolidWorks asks for (installed in the icons folder).
                string iconFolder = Path.Combine(Path.GetDirectoryName(typeof(AddIn).Assembly.Location), "icons");
                var icons = new[] { 20, 32, 40, 64, 96, 128 }.Select(size =>
                    Path.Combine(iconFolder, "auto-cut-list_" + size + ".png")).ToArray();
                bool hasIcons = icons.All(File.Exists);
                if (hasIcons)
                {
                    group.IconList = icons;
                    group.MainIconList = icons;
                }

                // SolidWorks only draws a command's icon in its menu when the command group also has a toolbar, so the
                // command is on both. The toolbar is one of SolidWorks' optional toolbars, off unless the user shows it.
                var index = group.AddCommandItem2("Label Cut List", -1,
                    "Set label templates and apply them to the active cut list",
                    "Label Cut List", hasIcons ? 0 : -1, "LabelCutList", "CanLabel", 1,
                    (int)(swCommandItemType_e.swMenuItem | swCommandItemType_e.swToolbarItem));
                group.HasMenu = true;
                group.HasToolbar = true;
                if (index < 0 || !group.Activate())
                    throw new InvalidOperationException("Could not activate the cut-list command.");
                try { AttachEvents(); } catch (Exception) { }
                return true;
            }
            catch (Exception error)
            {
                Show(error.Message, swMessageBoxIcon_e.swMbStop);
                DisconnectFromSW();
                return false;
            }
        }

        public bool DisconnectFromSW()
        {
            if (session != null)
            {
                try { if (!session.Process.HasExited) session.Process.Kill(); } catch (Exception) { }
                session = null;
            }
            StopPartWatcher();
            try { DetachEvents(); } catch (Exception) { }
            if (dispatcher != null) { dispatcher.Dispose(); dispatcher = null; }
            if (commands != null) commands.RemoveCommandGroup(GroupId);
            commands = null;
            app = null;
            return true;
        }

        // The window opens with or without a part: with none open, it starts empty and Refresh loads one later.
        public int CanLabel()
        {
            return app != null ? 1 : 0;
        }

        public void LabelCutList()
        {
            try
            {
                var part = app.ActiveDoc as IModelDoc2;
                if (session != null && !session.Ended)
                {
                    session.Focus();
                    if (part is IPartDoc && !ReferenceEquals(part, session.Part))
                        Push(session, new {
                            type = "parts", push = true, parts = OpenParts(), part = PartKey(session.Part),
                            suggest = PartKey(part), suggestTitle = part.GetTitle()
                        });
                    return;
                }
                if (!(part is IPartDoc))
                {
                    StartSession(null, new List<Label>(), OpenParts().Count == 0
                        ? "No parts are open. Open a part in SolidWorks, then click Refresh to load its cut list."
                        : "Choose a part from the Part list, or click Refresh to load the active part.");
                    return;
                }

                var labels = ReadLabels(part);
                StartSession(part, labels, labels.Count == 0
                    ? "No populated cut-list entries in " + part.GetTitle() + ". Update its cut list in SolidWorks, then click Refresh." : null);
            }
            catch (Exception error)
            {
                Show(error.Message, swMessageBoxIcon_e.swMbStop);
            }
        }

        // One open settings window, bound to the part it was opened on. The window stays open between actions,
        // and SolidWorks stays responsive because this method returns as soon as the window starts.
        private const string WebView2Download = "https://developer.microsoft.com/microsoft-edge/webview2/";

        // Microsoft's documented check: the runtime registers a version ("pv") under EdgeUpdate\Clients.
        private static bool HasWebView2()
        {
            const string client = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
            foreach (var path in new[] {
                new { Hive = Registry.LocalMachine, Key = @"SOFTWARE\WOW6432Node\" + client },
                new { Hive = Registry.LocalMachine, Key = @"SOFTWARE\" + client },
                new { Hive = Registry.CurrentUser, Key = @"Software\" + client } })
            {
                using (var key = path.Hive.OpenSubKey(path.Key))
                {
                    var version = key == null ? null : key.GetValue("pv") as string;
                    if (!String.IsNullOrEmpty(version) && version != "0.0.0.0") return true;
                }
            }
            return false;
        }

        private sealed class WatchedPart
        {
            public IModelDoc2 Model;
            public PartDoc Doc;
            public DPartDocEvents_FileSaveNotifyEventHandler Save;
            public DPartDocEvents_DestroyNotify2EventHandler Destroy;
            public DPartDocEvents_ActiveConfigChangePostNotifyEventHandler ConfigurationChanged;
            // The out-of-date items last warned about, per configuration, so the same warning isn't repeated.
            public readonly Dictionary<string, string> Warned = new Dictionary<string, string>();
        }

        private void AttachEvents()
        {
            swEvents = app as SldWorks;
            if (swEvents == null) return;
            activeDocChanged = new DSldWorksEvents_ActiveDocChangeNotifyEventHandler(OnActiveDocChange);
            swEvents.ActiveDocChangeNotify += activeDocChanged;
            WatchActivePart();
        }

        private void DetachEvents()
        {
            if (swEvents != null && activeDocChanged != null) swEvents.ActiveDocChangeNotify -= activeDocChanged;
            swEvents = null;
            activeDocChanged = null;
            foreach (var entry in watched.ToArray()) Unwatch(entry);
        }

        private int OnActiveDocChange()
        {
            try { WatchActivePart(); } catch (Exception) { }
            return 0;
        }

        private void WatchActivePart()
        {
            if (app == null) return;
            var model = app.ActiveDoc as IModelDoc2;
            var part = model as PartDoc;
            if (part == null || watched.Exists(existing => ReferenceEquals(existing.Model, model))) return;
            var entry = new WatchedPart { Model = model, Doc = part };
            entry.Save = new DPartDocEvents_FileSaveNotifyEventHandler(file => OnPartSave(entry));
            entry.Destroy = new DPartDocEvents_DestroyNotify2EventHandler(type => { Unwatch(entry); return 0; });
            entry.ConfigurationChanged = new DPartDocEvents_ActiveConfigChangePostNotifyEventHandler(() => OnConfigurationChange(entry));
            part.FileSaveNotify += entry.Save;
            part.DestroyNotify2 += entry.Destroy;
            part.ActiveConfigChangePostNotify += entry.ConfigurationChanged;
            watched.Add(entry);
        }

        private void Unwatch(WatchedPart entry)
        {
            watched.Remove(entry);
            try
            {
                entry.Doc.FileSaveNotify -= entry.Save;
                entry.Doc.DestroyNotify2 -= entry.Destroy;
                entry.Doc.ActiveConfigChangePostNotify -= entry.ConfigurationChanged;
            }
            catch (Exception) { }
        }

        // Before a part is saved: warn once if items were labeled and the model has changed since.
        // Never blocks or fails the save.
        private int OnPartSave(WatchedPart entry)
        {
            CheckLabels(entry, false);
            return 0;
        }

        // SolidWorks can only measure the active configuration, so each configuration's labels are checked when
        // SolidWorks switches to it (and again when the part is saved). The check runs once the switch has finished.
        // Switches made by the add-in itself, while it reads or labels another configuration, are ignored.
        private int OnConfigurationChange(WatchedPart entry)
        {
            if (!handling) Post(() => { if (!handling && watched.Contains(entry)) CheckLabels(entry, true); });
            return 0;
        }

        private void CheckLabels(WatchedPart entry, bool switched)
        {
            try
            {
                // Skipped while a request from the window is running (it may have the part on another configuration).
                if (app == null || handling || !LabelSettings.WarnOnSaveEnabled() || !HasLabelBasis(entry.Model)) return;
                string configuration = ActiveConfiguration(entry.Model);
                // Measuring every item is slow on large parts, so first compare each labeled item's cheap fingerprint
                // with the one stored when it was labeled; only if one differs is the cut list measured in full.
                if (!FingerprintsChanged(entry.Model))
                {
                    entry.Warned[configuration] = "";
                    return;
                }
                var stale = ReadLabels(entry.Model).FindAll(IsStale).ConvertAll(label => label.Name);
                string print = String.Join("\n", stale);
                string warned;
                if (stale.Count == 0 || (entry.Warned.TryGetValue(configuration, out warned) && print == warned))
                {
                    if (stale.Count == 0) entry.Warned[configuration] = "";
                    return;
                }
                entry.Warned[configuration] = print;
                string title = entry.Model.GetTitle() + (ConfigurationNames(entry.Model).Count > 1 ? " [" + configuration + "]" : "");
                string names = String.Join(", ", stale.Take(8)) + (stale.Count > 8 ? ", and " + (stale.Count - 8) + " more" : "");
                Show(title + ": " + stale.Count + (stale.Count == 1 ? " cut-list label" : " cut-list labels") +
                    " may be out of date, because the model changed after " + (stale.Count == 1 ? "it was" : "they were") + " applied:\n" + names +
                    "\n\nRun Tools > Auto Cut List > Label Cut List to update them. You can turn this warning off in the add-in's Settings.",
                    swMessageBoxIcon_e.swMbWarning);
            }
            catch (Exception) { }
        }

        // True if any cut-list item in the part was labeled by this add-in (cheap; no measuring).
        private static bool HasLabelBasis(IModelDoc2 part)
        {
            for (var root = (IFeature)part.FirstFeature(); root != null; root = (IFeature)root.GetNextFeature())
            {
                if (root.GetTypeName2() != "SolidBodyFolder") continue;
                for (var item = (IFeature)root.GetFirstSubFeature(); item != null; item = (IFeature)item.GetNextSubFeature())
                    if (item.GetTypeName2() == "CutListFolder" && !String.IsNullOrEmpty(Read(item.CustomPropertyManager, "CutListLabelerBasis")))
                        return true;
            }
            return false;
        }

        // True if any labeled cut-list item's fingerprint differs from the one stored when it was labeled, or an item
        // was labeled before fingerprints were stored. Cheap: no measuring, just SolidWorks' mass properties.
        private static bool FingerprintsChanged(IModelDoc2 part)
        {
            for (var root = (IFeature)part.FirstFeature(); root != null; root = (IFeature)root.GetNextFeature())
            {
                if (root.GetTypeName2() != "SolidBodyFolder") continue;
                for (var item = (IFeature)root.GetFirstSubFeature(); item != null; item = (IFeature)item.GetNextSubFeature())
                {
                    if (item.GetTypeName2() != "CutListFolder") continue;
                    var manager = item.CustomPropertyManager;
                    if (String.IsNullOrEmpty(Read(manager, "CutListLabelerBasis"))) continue;
                    string stored = Read(manager, "CutListLabelerFingerprint");
                    if (String.IsNullOrEmpty(stored)) return true;
                    var folder = (IBodyFolder)item.GetSpecificFeature2();
                    var bodies = folder.GetBodyCount() > 0 ? (object[])folder.GetBodies() : new object[0];
                    if (Fingerprint(bodies, manager) != stored) return true;
                }
            }
            return false;
        }

        // Each body's volume and surface area (unchanged by moving or rotating it), plus the properties the labels use.
        // Different whenever anything a label is built from changes; occasionally different when nothing that matters
        // did, which only costs a full check.
        private static string Fingerprint(object[] bodies, ICustomPropertyManager manager)
        {
            var shapes = new List<string>();
            foreach (var body in bodies)
            {
                var values = ((IBody2)body).GetMassProperties(1.0) as double[];
                shapes.Add(values == null || values.Length < 5 ? "?" :
                    values[3].ToString("G6", CultureInfo.InvariantCulture) + "/" + values[4].ToString("G6", CultureInfo.InvariantCulture));
            }
            shapes.Sort(StringComparer.Ordinal);
            return String.Join(";", shapes) + "|" + String.Join("|", new[] { "MATERIAL", "ANGLE1", "ANGLE2", "Sheet Metal Gauge" }
                .Select(name => Read(manager, name) ?? ""));
        }

        // The item's measurements differ from the ones recorded when it was last labeled.
        private static bool IsStale(Label label)
        {
            string stored = Read(label.Manager, "CutListLabelerBasis");
            return !String.IsNullOrEmpty(stored) && !label.MatchesBasis(stored);
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

        private sealed class UndoStep
        {
            public IModelDoc2 Part;
            public string Configuration;
            public string Title;
            public PropertyJournal Journal;
        }

        private sealed class Session
        {
            public Process Process;
            public StreamWriter Input;
            public IModelDoc2 Part;
            public string PartTitle;
            // The configuration whose cut list the window shows. It need not be the one active in SolidWorks:
            // requests switch to it, do their work and switch back.
            public string Configuration = "";
            // The configuration SolidWorks had active when the current request started.
            public string SolidWorksConfiguration = "";
            // The number of the request being answered (0 when none), echoed in its reply so the window can tell a
            // late answer to a request it stopped waiting for from the answer it is waiting for.
            public int RequestId;
            // Problems to mention alongside the current request's reply (a part left on the wrong configuration).
            public readonly List<string> Warnings = new List<string>();
            public bool Ended;
            // What the last apply changed, per part, so it can be undone.
            public List<UndoStep> Undo = new List<UndoStep>();
            public readonly StringBuilder Errors = new StringBuilder();

            public void Focus()
            {
                try
                {
                    Process.Refresh();
                    var window = Process.MainWindowHandle;
                    if (window == IntPtr.Zero) return;
                    if (IsIconic(window)) ShowWindow(window, 9);
                    SetForegroundWindow(window);
                }
                catch (Exception) { }
            }
        }

        private static System.Windows.Forms.DialogResult ShowOwned(System.Windows.Forms.CommonDialog dialog, Session current)
        {
            IntPtr window = IntPtr.Zero;
            try { current.Process.Refresh(); window = current.Process.MainWindowHandle; } catch (Exception) { }
            return window == IntPtr.Zero ? dialog.ShowDialog() : dialog.ShowDialog(new OwnerWindow(window));
        }

        private static object ExportPreset(LabelResponse message, Session current)
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

        private sealed class OwnerWindow : System.Windows.Forms.IWin32Window
        {
            public OwnerWindow(IntPtr handle) { Handle = handle; }
            public IntPtr Handle { get; private set; }
        }

        private static JavaScriptSerializer Serializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
        }

        // `part` is null when the window opens with no part; it then starts with an empty list.
        private void StartSession(IModelDoc2 part, List<Label> labels, string message)
        {
            string directory = Path.GetDirectoryName(typeof(AddIn).Assembly.Location);
            string executable = Path.Combine(directory, "cut-list-settings.exe");
            if (!File.Exists(executable))
                throw new InvalidOperationException("The settings window (cut-list-settings.exe) is missing from " + directory +
                    ". Run Install.cmd again to reinstall the add-in.");

            var serializer = Serializer();
            var loaded = LabelSettings.LoadAll();
            string payload = serializer.Serialize(new {
                version = Version,
                configuration = ActiveConfiguration(part),
                configurations = ConfigurationNames(part).Count,
                configurationNames = ConfigurationNames(part),
                activeConfiguration = ActiveConfiguration(part),
                part = PartKey(part),
                partTitle = part == null ? "" : part.GetTitle(),
                parts = OpenParts(),
                message,
                settings = loaded,
                defaults = LabelSettings.AllDefaults(),
                presets = PresetStore.Load(),
                activePreset = PresetStore.Active(),
                entries = Entries(labels, serializer)
            });

            var start = new ProcessStartInfo(executable) {
                WorkingDirectory = directory,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                StandardOutputEncoding = Encoding.UTF8,
                RedirectStandardError = true,
                StandardErrorEncoding = Encoding.UTF8,
                CreateNoWindow = true
            };
            Process process;
            try { process = Process.Start(start); }
            catch (System.ComponentModel.Win32Exception error)
            {
                throw new InvalidOperationException("Windows would not start the settings window (" + error.Message + ").\n" +
                    "Check that antivirus software is not blocking " + executable + ", then run Install.cmd again.");
            }

            var current = new Session { Process = process, Part = part, PartTitle = part == null ? "" : part.GetTitle(),
                Configuration = ActiveConfiguration(part), SolidWorksConfiguration = ActiveConfiguration(part) };
            process.ErrorDataReceived += (sender, data) => {
                if (!String.IsNullOrWhiteSpace(data.Data)) lock (current.Errors) current.Errors.AppendLine(data.Data.Trim());
            };
            process.BeginErrorReadLine();
            // Use the stream directly so the JSON is UTF-8 without an encoding marker.
            current.Input = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true };
            current.Input.WriteLine(payload);
            session = current;
            StartPartWatcher(current);

            var reader = new System.Threading.Thread(() => {
                try
                {
                    string line;
                    while ((line = process.StandardOutput.ReadLine()) != null)
                    {
                        var text = line;
                        Post(() => Enqueue(current, text));
                    }
                }
                catch (Exception) { }
                // The window has closed its output. Wait for it to exit here, not on SolidWorks' main thread.
                int exitCode = 0;
                try
                {
                    if (process.WaitForExit(5000))
                    {
                        process.WaitForExit();
                        exitCode = process.ExitCode;
                    }
                    else process.Kill();
                }
                catch (Exception) { }
                Post(() => EndSession(current, exitCode));
            }) { IsBackground = true, Name = "Cut-list window reader" };
            reader.Start();
        }

        // Runs requests strictly one after another, on SolidWorks' main thread.
        private void Enqueue(Session current, string line)
        {
            requests.Enqueue(new KeyValuePair<Session, string>(current, line));
            if (draining) return;
            draining = true;
            try
            {
                while (requests.Count > 0)
                {
                    var next = requests.Dequeue();
                    try { Handle(next.Key, next.Value); }
                    catch (Exception) { }
                }
            }
            finally { draining = false; }
        }

        private void StartPartWatcher(Session current)
        {
            StopPartWatcher();
            ResetWatch(current);
            partWatcher = new System.Windows.Forms.Timer { Interval = 1500 };
            partWatcher.Tick += (sender, args) => WatchParts();
            partWatcher.Start();
        }

        private void StopPartWatcher()
        {
            if (partWatcher == null) return;
            partWatcher.Stop();
            partWatcher.Dispose();
            partWatcher = null;
        }

        private void ResetWatch(Session current)
        {
            lastConfiguration = ActiveConfiguration(current.Part);
            lastParts = PartsSnapshot(current, OpenParts(), PartKey(current.Part) + "\n" + lastConfiguration + "\n" +
                String.Join("\n", ConfigurationNames(current.Part)));
            lastPartOpen = current.Part != null && IsOpen(current.Part);
        }

        private static string PartsSnapshot(Session current, List<object> parts, string key)
        {
            return Serializer().Serialize(new { parts, key, current.PartTitle });
        }

        // Runs on SolidWorks' main thread. Tells the window when parts are opened, closed or saved under a new name.
        private void WatchParts()
        {
            var current = session;
            if (current == null || current.Ended || app == null) { StopPartWatcher(); return; }
            if (handling) return;
            try
            {
                var parts = OpenParts();
                bool open = IsOpen(current.Part);
                if (open) current.PartTitle = current.Part.GetTitle();
                string key = open ? PartKey(current.Part) : "";
                string active = open ? ActiveConfiguration(current.Part) : "";
                var names = open ? ConfigurationNames(current.Part) : new List<string>();
                string snapshot = PartsSnapshot(current, parts, key + "\n" + active + "\n" + String.Join("\n", names));
                if (snapshot == lastParts) return;
                bool closedNow = lastPartOpen && !open;
                // The window keeps showing its own configuration when SolidWorks switches; it only needs telling
                // if that configuration was deleted or renamed.
                string gone = open && current.Configuration.Length > 0 && !names.Contains(current.Configuration) ? current.Configuration : null;
                if (gone != null) current.Configuration = active;
                lastParts = snapshot;
                lastPartOpen = open;
                lastConfiguration = active;
                current.SolidWorksConfiguration = active;
                Push(current, new {
                    type = "parts", push = true, parts, part = key, partTitle = current.PartTitle,
                    configuration = open ? current.Configuration : "", configurations = names.Count,
                    configurationNames = names, activeConfiguration = active,
                    message = closedNow ? current.PartTitle + " was closed. Choose an open part from the Part list."
                        : gone != null ? "Configuration " + gone + " is no longer in " + current.PartTitle + ". Showing " + active +
                          " instead; click Refresh to load its cut list." : null
                });
            }
            catch (Exception) { }
        }

        private void Post(Action action)
        {
            var target = dispatcher;
            try { if (target != null && !target.IsDisposed) target.BeginInvoke(action); }
            catch (InvalidOperationException) { }
        }

        private void EndSession(Session current, int exitCode)
        {
            if (current.Ended) return;
            current.Ended = true;
            if (session == current) { session = null; StopPartWatcher(); }
            try { current.Input.Dispose(); } catch (Exception) { }
            current.Process.Dispose();
            if (exitCode != 0 && app != null)
            {
                string detail;
                lock (current.Errors) detail = current.Errors.ToString().Trim();
                string advice = HasWebView2()
                    ? "\nIf this keeps happening, repair the Microsoft Edge WebView2 Runtime from " + WebView2Download + " and run Install.cmd again."
                    : "\nThe Microsoft Edge WebView2 Runtime does not appear to be installed. Install the Evergreen Runtime from " +
                      WebView2Download + ", then run the command again.";
                Show("The settings window closed unexpectedly (exit code " + exitCode + ")." +
                    (detail.Length > 0 ? "\n" + detail : "") + advice, swMessageBoxIcon_e.swMbStop);
            }
        }

        // Answers the request being handled. Its number and any warnings are added to the reply.
        private static void Reply(Session current, object message)
        {
            try
            {
                var serializer = Serializer();
                string json = serializer.Serialize(message);
                var extra = new List<string>();
                if (current.RequestId > 0) extra.Add("\"requestId\":" + current.RequestId.ToString(CultureInfo.InvariantCulture));
                if (current.Warnings.Count > 0) extra.Add("\"warning\":" + serializer.Serialize(String.Join(" ", current.Warnings)));
                if (extra.Count > 0 && json.Length > 2 && json[0] == '{')
                    json = "{" + String.Join(",", extra) + "," + json.Substring(1);
                current.Input.WriteLine(json);
            }
            catch (Exception) { }
        }

        // Tells the window something it didn't ask about (parts opened or closed, the command run on another part).
        private static void Push(Session current, object message)
        {
            try { current.Input.WriteLine(Serializer().Serialize(message)); }
            catch (Exception) { }
        }

        // Switches `part` back to the configuration it was on. If SolidWorks refuses (twice), the reply says so,
        // so the part is never left on another configuration without the user knowing.
        private static void SwitchBack(Session current, IModelDoc2 part, string configuration)
        {
            if (String.IsNullOrEmpty(configuration) || Activate(part, configuration) || Activate(part, configuration)) return;
            string title;
            try { title = part.GetTitle(); } catch (COMException) { title = "A part"; }
            current.Warnings.Add(title + " was left on configuration " + ActiveConfiguration(part) + " because SolidWorks wouldn't switch it back to " +
                configuration + ". Switch it back in SolidWorks.");
        }

        // Parts open in their own SolidWorks windows. Parts loaded only as assembly components are left out.
        private List<object> OpenParts()
        {
            var parts = new List<object>();
            try
            {
                var documents = app.GetDocuments() as object[];
                if (documents == null) return parts;
                foreach (var document in documents)
                {
                    var model = document as IModelDoc2;
                    if (model == null || !(model is IPartDoc) || !model.Visible) continue;
                    parts.Add(new { key = PartKey(model), title = model.GetTitle() });
                }
            }
            catch (COMException) { }
            return parts;
        }

        private IModelDoc2 FindPart(string key)
        {
            if (String.IsNullOrEmpty(key)) return null;
            var documents = app.GetDocuments() as object[];
            if (documents == null) return null;
            foreach (var document in documents)
            {
                var model = document as IModelDoc2;
                if (model != null && model is IPartDoc && model.Visible && PartKey(model) == key) return model;
            }
            return null;
        }

        // Identifies a document between messages: its file path, or its title if it has never been saved.
        private static string PartKey(IModelDoc2 model)
        {
            if (model == null) return "";
            try
            {
                string path = model.GetPathName();
                return String.IsNullOrEmpty(path) ? "title:" + model.GetTitle() : path;
            }
            catch (COMException) { return ""; }
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

        private bool IsOpen(IModelDoc2 part)
        {
            if (part == null) return false;
            try
            {
                var documents = app.GetDocuments() as object[];
                return documents != null && Array.Exists(documents, document => ReferenceEquals(document, part));
            }
            catch (COMException) { return false; }
        }

        // Runs on SolidWorks' main thread for each request from the window, and always answers it.
        private void Handle(Session current, string line)
        {
            if (current.Ended || app == null) return;
            LabelResponse message = null;
            string unreadable = null;
            try { message = Serializer().Deserialize<LabelResponse>(line); }
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
        private object PartRequest(Session current, LabelResponse message, string exportPath)
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

        // Runs `work` with the part showing the configuration the window displays, then switches SolidWorks back
        // to the configuration it had active, so reading or labeling another configuration leaves the model as it was.
        // A shown configuration that was deleted or renamed falls back to the active one.
        private static T InShownConfiguration<T>(Session current, Func<T> work)
        {
            string active = ActiveConfiguration(current.Part);
            current.SolidWorksConfiguration = active;
            if (String.IsNullOrEmpty(current.Configuration) || !ConfigurationNames(current.Part).Contains(current.Configuration))
                current.Configuration = active;
            string shown = current.Configuration;
            if (shown == active) return work();
            if (!Activate(current.Part, shown))
                throw new InvalidOperationException("SolidWorks couldn't switch " + current.PartTitle + " to configuration " + shown +
                    " to read it. Its cut list was not changed.");
            try { return work(); }
            finally { SwitchBack(current, current.Part, active); }
        }

        // "PART [Configuration]" when the part has several configurations, for messages.
        private static string ShownName(Session current)
        {
            return ConfigurationNames(current.Part).Count > 1 && current.Configuration.Length > 0
                ? current.PartTitle + " [" + current.Configuration + "]" : current.PartTitle;
        }

        private static string ActiveConfiguration(IModelDoc2 part)
        {
            if (part == null) return "";
            try
            {
                var configuration = part.GetActiveConfiguration() as IConfiguration;
                return configuration == null ? "" : configuration.Name ?? "";
            }
            catch (COMException) { return ""; }
        }

        private static List<string> ConfigurationNames(IModelDoc2 part)
        {
            var names = new List<string>();
            if (part == null) return names;
            try
            {
                var raw = part.GetConfigurationNames() as Array;
                if (raw != null) foreach (var name in raw) if (name != null) names.Add(name.ToString());
            }
            catch (COMException) { }
            return names;
        }

        // Makes `configuration` the active one. True if it already was or the switch worked.
        private static bool Activate(IModelDoc2 part, string configuration)
        {
            if (String.IsNullOrEmpty(configuration) || configuration == ActiveConfiguration(part)) return true;
            try { return part.ShowConfiguration2(configuration) && ActiveConfiguration(part) == configuration; }
            catch (COMException) { return false; }
        }

        private List<IModelDoc2> OpenPartDocs()
        {
            var parts = new List<IModelDoc2>();
            var documents = app.GetDocuments() as object[];
            if (documents == null) return parts;
            foreach (var document in documents)
            {
                var model = document as IModelDoc2;
                if (model != null && model is IPartDoc && model.Visible) parts.Add(model);
            }
            return parts;
        }

        // Applies labels to several open parts. Each part is all-or-nothing; a part that changed since the
        // window read it is skipped.
        private object ApplyBatch(Session current, LabelResponse message)
        {
            var steps = new List<UndoStep>();
            var skipped = new List<string>();
            var originals = new List<KeyValuePair<IModelDoc2, string>>();
            int items = 0;
            try
            {
                foreach (var request in message.Batch ?? new LabelResponse[0])
                {
                    var part = FindPart(request.PartKey);
                    if (part == null) { skipped.Add("a part that is no longer open"); continue; }
                    if (!originals.Exists(pair => ReferenceEquals(pair.Key, part)))
                        originals.Add(new KeyValuePair<IModelDoc2, string>(part, ActiveConfiguration(part)));
                    string title = part.GetTitle() + (String.IsNullOrEmpty(request.Configuration) ? "" : " [" + request.Configuration + "]");
                    try
                    {
                        if (!Activate(part, request.Configuration))
                        {
                            skipped.Add(title + " (SolidWorks couldn't switch to this configuration)");
                            continue;
                        }
                        var labels = ReadLabels(part);
                        if (request.Names == null || !labels.ConvertAll(label => label.Name).SequenceEqual(request.Names) || !LabelsMatch(labels, request))
                        {
                            skipped.Add(title + " (its cut list or labels changed in SolidWorks)");
                            continue;
                        }
                        request.Settings = message.Settings;
                        PropertyJournal journal;
                        items += ApplyLabels(labels, request, out journal);
                        MarkWritten(part);
                        steps.Add(new UndoStep { Part = part, Title = title, Configuration = ActiveConfiguration(part), Journal = journal });
                    }
                    catch (Exception error)
                    {
                        skipped.Add(title + " (" + error.Message.Split('\n')[0] + ")");
                    }
                }
            }
            finally
            {
                // Leave every part showing the configuration it started on.
                foreach (var pair in originals) if (IsOpen(pair.Key)) SwitchBack(current, pair.Key, pair.Value);
            }
            if (steps.Count > 0) current.Undo = steps;
            int partCount = 0;
            for (int i = 0; i < steps.Count; i++)
                if (!steps.Take(i).Any(earlier => ReferenceEquals(earlier.Part, steps[i].Part))) partCount++;
            string where = steps.Count > partCount
                ? steps.Count + " configurations of " + partCount + (partCount == 1 ? " part" : " parts")
                : partCount + (partCount == 1 ? " part" : " parts");
            string text = steps.Count == 0 ? "No labels were changed."
                : items + (items == 1 ? " cut-list entry" : " cut-list entries") + " updated in " + where +
                  ". Save " + (partCount == 1 ? "the part" : "each part") + " to keep the labels.";
            if (skipped.Count > 0) text += " Skipped " + String.Join("; ", skipped) + ".";
            if (!IsOpen(current.Part)) return PartsReply(current, text);
            return InShownConfiguration(current, () => RefreshReply(current, ReadLabels(current.Part), steps.Count > 0, text));
        }

        // Puts back every property the last apply changed, in each part that is still open.
        private object UndoLast(Session current)
        {
            if (current.Undo.Count == 0) throw new InvalidOperationException("There is nothing to undo.");
            var failed = new List<string>();
            var closed = new List<string>();
            var kept = new List<string>();
            int parts = 0;
            foreach (var step in current.Undo)
            {
                if (!IsOpen(step.Part)) { closed.Add(step.Title); continue; }
                string showing = ActiveConfiguration(step.Part);
                try
                {
                    if (!Activate(step.Part, step.Configuration)) { failed.Add(step.Title + " (couldn't switch to its configuration)"); continue; }
                    var managers = new Dictionary<string, ICustomPropertyManager>();
                    MarkWritten(step.Part);
                    foreach (var label in ReadLabels(step.Part)) managers[label.Name] = label.Manager;
                    var edited = new List<string>();
                    failed.AddRange(step.Journal.Restore(item => {
                        ICustomPropertyManager manager;
                        return managers.TryGetValue(item, out manager) ? manager : null;
                    }, edited).ConvertAll(name => step.Title + " \u2013 " + name));
                    // Only properties the window shows are worth naming; the add-in's own bookkeeping isn't.
                    kept.AddRange(edited.Where(name => name.EndsWith(": Description", StringComparison.Ordinal) ||
                        name.EndsWith(": Length", StringComparison.Ordinal)).Select(name => step.Title + " \u2013 " + name));
                    parts++;
                }
                finally { SwitchBack(current, step.Part, showing); }
            }
            current.Undo = new List<UndoStep>();
            string text = parts == 0 ? "Nothing was undone."
                : "Undid the last apply" + (parts > 1 ? " in " + parts + " places" : "") + ". Save to keep the restored labels.";
            if (closed.Count > 0) text += " Not undone, because the part was closed: " + String.Join(", ", closed) + ".";
            if (kept.Count > 0) text += " Kept because they were changed after the apply: " + String.Join(", ", kept.Take(8)) +
                (kept.Count > 8 ? " and " + (kept.Count - 8) + " more" : "") + ".";
            if (failed.Count > 0) text += " Couldn't restore: " + String.Join(", ", failed) + ".";
            if (!IsOpen(current.Part)) return PartsReply(current, text);
            return InShownConfiguration(current, () => RefreshReply(current, ReadLabels(current.Part), failed.Count == 0 && parts > 0, text));
        }

        // True when every item's stored Description and Length still match what the window was showing.
        private static bool LabelsMatch(List<Label> labels, LabelResponse message)
        {
            if (message.Descriptions == null || message.Lengths == null ||
                message.Descriptions.Length != labels.Count || message.Lengths.Length != labels.Count) return false;
            for (int i = 0; i < labels.Count; i++)
                if ((Read(labels[i].Manager, "Description") ?? "") != message.Descriptions[i] ||
                    (Read(labels[i].Manager, "Length") ?? "") != message.Lengths[i]) return false;
            return true;
        }

        // Writes the selected entries' labels. All-or-nothing: on any failure every changed property is restored.
        private static int ApplyLabels(List<Label> labels, LabelResponse response, out PropertyJournal journal)
        {
            journal = new PropertyJournal();
            if (response.Selection == null || response.Selection.Length == 0 ||
                Array.Exists(response.Selection, index => index < 0 || index >= labels.Count))
                throw new InvalidOperationException("Check at least one item to apply.");
            var selected = new HashSet<int>(response.Selection);
            labels = labels.FindAll(label => selected.Contains(label.Index));

            foreach (var label in labels)
            {
                LabelSettings custom = null;
                if (response.Custom != null) response.Custom.TryGetValue(label.Index.ToString(CultureInfo.InvariantCulture), out custom);
                label.Custom = custom;
                var index = label.Index.ToString(CultureInfo.InvariantCulture);
                FieldLocks requested;
                label.Locks = response.Locks != null && response.Locks.TryGetValue(index, out requested) && requested != null
                    ? requested : ReadLocks(label.Manager);
                LabelSettings shown = null;
                if (response.Labels != null) response.Labels.TryGetValue(index, out shown);
                // The window works out every label (templates, shapes, fractions, capitalization); the add-in writes
                // exactly what it shows, so there's only one set of labeling rules.
                if (shown == null || shown.Description == null || shown.Length == null)
                    throw new InvalidOperationException(label.Name + ": the window didn't send its labels. Nothing was changed.");
                if (shown.Description.Length > 2000 || shown.Length.Length > 2000)
                    throw new InvalidOperationException(label.Name + ": the label is too long.");
                if (!label.Locks.Description) label.Description = shown.Description;
                if (!label.Locks.Length) label.Length = shown.Length;
            }

            // Record every property before it changes, so a failure can put the part back exactly as it was.
            int applied = 0;
            try
            {
                foreach (var label in labels)
                {
                    if (label.Category == "weldment" && !String.IsNullOrEmpty(label.DefaultCallout))
                        journal.Write(label.Manager, label.Name, "CutListLabelerOriginalCallout", label.DefaultCallout);
                    if (!label.Locks.Description) journal.Write(label.Manager, label.Name, "Description", label.Description);
                    if (!label.Locks.Length) journal.Write(label.Manager, label.Name, "Length", label.Length);
                    if (response.Custom != null && (label.Custom != null || Read(label.Manager, "CutListLabelerCustom") != ""))
                        journal.Write(label.Manager, label.Name, "CutListLabelerCustom", label.Custom == null ? "-" : Convert.ToBase64String(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(label.Custom))));
                    var previous = ReadLocks(label.Manager);
                    if (previous.Description != label.Locks.Description || previous.Length != label.Locks.Length)
                        journal.Write(label.Manager, label.Name, "CutListLabelerLocks", label.Locks.Encode());
                    // What the item measured when it was labeled; a later difference means the label may be out of date.
                    journal.Write(label.Manager, label.Name, "CutListLabelerBasis", label.Basis());
                    if (label.Bodies != null)
                        journal.Write(label.Manager, label.Name, "CutListLabelerFingerprint", Fingerprint(label.Bodies, label.Manager));
                    applied++;
                }
            }
            catch (Exception error)
            {
                var unrestored = journal.Restore();
                throw new InvalidOperationException(error.Message + (unrestored.Count == 0
                    ? "\nNo labels were changed. Every property was restored to its original value."
                    : "\nSome original values could not be restored (" + String.Join(", ", unrestored) +
                      "). Close the part without saving to discard the partial changes."));
            }
            return applied;
        }

        private static void ReorderCutList(IModelDoc2 part, List<Label> labels, int[] order)
        {
            if (order == null || order.Length != labels.Count || new HashSet<int>(order).Count != labels.Count ||
                Array.Exists(order, index => index < 0 || index >= labels.Count))
                throw new InvalidOperationException("The reorder preview does not match the active cut list.");

            var original = labels.ConvertAll(label => label.Name);
            var target = Array.ConvertAll(order, index => labels[index].Name);
            var names = new HashSet<string>(original, StringComparer.OrdinalIgnoreCase);
            if (names.Count != original.Count || !ReadTreeOrder(part, names).SequenceEqual(original))
                throw new InvalidOperationException("The cut-list tree changed. Reopen the add-in and preview it again.");

            try
            {
                ApplyTreeOrder(part, names, target);
            }
            catch (Exception error)
            {
                try { ApplyTreeOrder(part, names, original.ToArray()); }
                catch (Exception rollback)
                {
                    throw new InvalidOperationException(error.Message + " Restoring the original order also failed: " + rollback.Message);
                }
                throw new InvalidOperationException(error.Message + " The original order was restored.");
            }
        }

        private static List<string> ReadTreeOrder(IModelDoc2 part, HashSet<string> names)
        {
            var order = new List<string>();
            for (var root = (IFeature)part.FirstFeature(); root != null; root = (IFeature)root.GetNextFeature())
            {
                if (root.GetTypeName2() != "SolidBodyFolder") continue;
                for (var item = (IFeature)root.GetFirstSubFeature(); item != null; item = (IFeature)item.GetNextSubFeature())
                    if (item.GetTypeName2() == "CutListFolder" && names.Contains(item.Name)) order.Add(item.Name);
            }
            return order;
        }

        private static void ApplyTreeOrder(IModelDoc2 part, HashSet<string> names, string[] target)
        {
            var current = ReadTreeOrder(part, names);
            for (int index = 0; index < target.Length; index++)
            {
                if (index >= current.Count)
                    throw new InvalidOperationException("SolidWorks returned fewer cut-list folders than expected.");
                if (current[index] == target[index]) continue;
                if (!part.Extension.ReorderFeature2(target[index], current[index], (int)swMoveLocation_e.swMoveBefore))
                    throw new InvalidOperationException("SolidWorks would not move " + target[index] + ".");
                current = ReadTreeOrder(part, names);
            }

            if (!current.SequenceEqual(target))
                throw new InvalidOperationException("SolidWorks returned a different order from the preview.");
            part.FeatureManager.UpdateFeatureTree();
        }

        // Asks where to save an Excel workbook or (pdf) a PDF. Null if the user cancels.
        private static string AskExportPath(bool pdf, IntPtr owner)
        {
            using (var dialog = new System.Windows.Forms.SaveFileDialog {
                Filter = pdf ? "PDF document (*.pdf)|*.pdf" : "Excel workbook (*.xlsx)|*.xlsx", DefaultExt = pdf ? "pdf" : "xlsx",
                AddExtension = true, OverwritePrompt = true, FileName = pdf ? "Cut List.pdf" : "Cut List.xlsx"
            })
            {
                var result = owner == IntPtr.Zero ? dialog.ShowDialog() : dialog.ShowDialog(new OwnerWindow(owner));
                return result == System.Windows.Forms.DialogResult.OK ? dialog.FileName : null;
            }
        }

        // Writes the cut list as an Excel workbook, or (pdf) as a PDF that Excel prints from the same workbook.
        private static void WriteExport(string path, List<Label> labels, string[] thumbnails, bool pdf, bool metric)
        {
            var started = DateTime.Now.AddSeconds(-2);
            try
            {
                WriteExcel(path, labels, thumbnails, pdf, metric);
            }
            catch (COMException)
            {
                // Excel can report a disconnected object while closing, after the workbook is saved.
                // Only treat it as a failure if the file was not written.
                if (!File.Exists(path) || File.GetLastWriteTime(path) < started) throw;
            }
            finally
            {
                // Release every Excel object (cells, ranges, shapes) so EXCEL.EXE exits.
                GC.Collect();
                GC.WaitForPendingFinalizers();
                GC.Collect();
                GC.WaitForPendingFinalizers();
            }
        }

        private static void WriteExcel(string path, List<Label> labels, string[] thumbnails, bool pdf, bool metric)
        {
            var excelType = Type.GetTypeFromProgID("Excel.Application");
            if (excelType == null)
                throw new InvalidOperationException("Microsoft Excel is required for " + (pdf ? "the PDF" : "this") + " export.");
            dynamic excel = Activator.CreateInstance(excelType);
            dynamic book = null;
            var pictures = new List<string>();
            try
            {
                excel.DisplayAlerts = false;
                book = excel.Workbooks.Add(-4167);
                dynamic sheet = book.Worksheets[1];
                sheet.Name = "Cut list";
                var cells = new object[labels.Count + 1, 7];
                var headers = new[] { "Body", "Cut-list item", "Category", "Quantity", "Description", "Length", "Length basis" };
                for (int column = 0; column < headers.Length; column++) cells[0, column] = headers[column];
                for (int i = 0; i < labels.Count; i++)
                {
                    var label = labels[i];
                    cells[i + 1, 1] = label.Name;
                    cells[i + 1, 2] = CategoryName(label.Category, LabelSettings.HasCustom(label.Manager));
                    cells[i + 1, 3] = label.Quantity;
                    cells[i + 1, 4] = Read(label.Manager, "Description");
                    string length = Read(label.Manager, "Length");
                    cells[i + 1, 5] = length;
                    cells[i + 1, 6] = ExportLengthSource(label, length);
                }
                var columns = new[] { 22, 28, 18, 11, 40, 18, 30 };
                for (int i = 0; i < columns.Length; i++) sheet.Columns[i + 1].ColumnWidth = columns[i];
                sheet.Range["B:C"].NumberFormat = "@";
                sheet.Range["E:G"].NumberFormat = "@";
                dynamic used = sheet.Range["A1", "G" + (labels.Count + 1)];
                used.Value2 = cells;
                used.VerticalAlignment = -4108;
                used.WrapText = true;
                dynamic heading = sheet.Range["A1:G1"];
                heading.Font.Bold = true;
                heading.Font.Color = 16777215;
                heading.Interior.Color = 6693657;
                heading.RowHeight = 23;
                used.AutoFilter(1);
                sheet.Range["A2", "G" + (labels.Count + 1)].RowHeight = 70;
                for (int i = 0; thumbnails != null && i < Math.Min(thumbnails.Length, labels.Count); i++)
                {
                    if (String.IsNullOrEmpty(thumbnails[i])) continue;
                    string file = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".png");
                    pictures.Add(file);
                    File.WriteAllBytes(file, Convert.FromBase64String(thumbnails[i]));
                    dynamic cell = sheet.Cells[i + 2, 1];
                    dynamic shape = sheet.Shapes.AddPicture(file, 0, -1, (float)cell.Left + 4, (float)cell.Top + 3, 102f, 64f);
                    shape.Placement = 1;
                }
                AddStockTotals(book, sheet, labels, metric);
                if (pdf)
                {
                    foreach (dynamic page in book.Worksheets) SetUpPrinting(page);
                    // 0 = xlTypePDF. Every sheet is exported: the cut list, then stock totals if there are any.
                    book.ExportAsFixedFormat(0, path);
                }
                else book.SaveAs(path, 51);
            }
            finally
            {
                // Cleanup is best effort: once the workbook is saved, Excel shutting down or a released object
                // reporting "does not exist" must not turn a good export into an error.
                try { if (book != null) book.Close(false); } catch (COMException) { }
                try { excel.Quit(); } catch (COMException) { }
                try { if (book != null) Marshal.FinalReleaseComObject(book); } catch (Exception) { }
                try { Marshal.FinalReleaseComObject(excel); } catch (Exception) { }
                foreach (var file in pictures) try { File.Delete(file); } catch (IOException) { }
            }
        }

        // Landscape, one page wide, with the heading row repeated on every page. Page setup talks to the
        // printer driver and can fail on a PC without one; the PDF is still written with Excel's defaults.
        private static void SetUpPrinting(dynamic sheet)
        {
            try
            {
                dynamic setup = sheet.PageSetup;
                setup.Orientation = 2;
                setup.Zoom = false;
                setup.FitToPagesWide = 1;
                setup.FitToPagesTall = false;
                setup.PrintTitleRows = "$1:$1";
                setup.CenterFooter = "Page &P of &N";
            }
            catch (COMException) { }
        }

        private static string CategoryName(string category, bool custom)
        {
            return custom ? "Custom" : category == "sheet" ? "Sheet Metal" : category == "weldment" ? "Weldment" : "Regular Part";
        }

        private sealed class StockTotal
        {
            public string Profile;
            public string Material;
            public int Pieces;
            public int Unmeasured;
            public decimal Length;
        }

        // A second sheet for purchasing: total length of each weldment profile (by its Description and material).
        private static void AddStockTotals(dynamic book, dynamic first, List<Label> labels, bool metric)
        {
            var totals = new Dictionary<string, StockTotal>();
            foreach (var label in labels)
            {
                if (label.Category != "weldment") continue;
                string profile = Read(label.Manager, "Description");
                if (String.IsNullOrWhiteSpace(profile)) profile = String.IsNullOrWhiteSpace(label.DefaultCallout) ? label.Name : label.DefaultCallout;
                string key = profile + "\n" + label.Material;
                StockTotal total;
                if (!totals.TryGetValue(key, out total))
                    totals.Add(key, total = new StockTotal { Profile = profile, Material = label.Material });
                total.Pieces += label.Quantity;
                if (label.Dimensions == null) total.Unmeasured += label.Quantity;
                else total.Length += ToUnits(label, label.Dimensions[2], metric ? "metric" : "imperial") * label.Quantity;
            }
            if (totals.Count == 0) return;

            var rows = totals.Values.OrderBy(total => total.Profile, StringComparer.CurrentCultureIgnoreCase).ToList();
            dynamic sheet = book.Worksheets.Add(Type.Missing, first);
            sheet.Name = "Stock totals";
            var headers = new[] { "Profile", "Material", "Pieces", metric ? "Total length (mm)" : "Total length (in)",
                metric ? "Total length (m)" : "Total length (ft)", "Pieces not measured" };
            var cells = new object[rows.Count + 1, headers.Length];
            for (int column = 0; column < headers.Length; column++) cells[0, column] = headers[column];
            for (int i = 0; i < rows.Count; i++)
            {
                cells[i + 1, 0] = rows[i].Profile;
                cells[i + 1, 1] = rows[i].Material;
                cells[i + 1, 2] = rows[i].Pieces;
                cells[i + 1, 3] = (double)Math.Round(rows[i].Length, 3);
                cells[i + 1, 4] = (double)Math.Round(rows[i].Length / (metric ? 1000m : 12m), 3);
                cells[i + 1, 5] = rows[i].Unmeasured == 0 ? (object)"" : rows[i].Unmeasured;
            }
            var widths = new[] { 40, 26, 10, 18, 18, 20 };
            for (int i = 0; i < widths.Length; i++) sheet.Columns[i + 1].ColumnWidth = widths[i];
            sheet.Range["A:B"].NumberFormat = "@";
            dynamic used = sheet.Range["A1", "F" + (rows.Count + 1)];
            used.Value2 = cells;
            dynamic heading = sheet.Range["A1:F1"];
            heading.Font.Bold = true;
            heading.Font.Color = 16777215;
            heading.Interior.Color = 6693657;
            heading.RowHeight = 23;
            used.AutoFilter(1);
            first.Activate();
        }

        private static string ExportLengthSource(Label label, string length)
        {
            string expression, evaluated;
            bool resolved, linked;
            label.Manager.Get6("Length", false, out expression, out evaluated, out resolved, out linked);
            if (IsNativeLengthExpression(expression)) return "SolidWorks cut length";
            decimal value, rounded;
            if (label.Dimensions != null && TryPositiveLength(length, out value) &&
                UnitOptions(label, 2).Values.Any(options => Array.Exists(options, option =>
                    Decimal.TryParse(option, NumberStyles.Number, CultureInfo.InvariantCulture, out rounded) && rounded == value)))
                return label.LengthSource + " (matches)";
            return String.IsNullOrWhiteSpace(length) ? "" : "Stored value";
        }

        // Reads the part's cut list without marking an unmodified part as modified: SolidWorks flags a document after
        // any programmatic change (even one that is undone), and there is no way to clear that flag.
        //
        // Updating the cut list is such a change, but SolidWorks only hands back current cut-list property values after
        // one: without it, labels written by Apply still read as the old ones. So the cut list is updated whenever the
        // part is already modified (as it is after Apply, Undo or any edit), where updating costs nothing, and when it
        // has never been generated. A part just opened or saved is read as it is, which is also how it was saved.
        // Called after the add-in writes to a part. Writing cut-list properties through the API doesn't reliably mark
        // the part as modified, so it is marked here: SolidWorks then offers to save the labels, and every later
        // read updates the cut list first (see ReadLabels) and so sees them.
        private static void MarkWritten(IModelDoc2 part)
        {
            try { part.SetSaveFlag(); } catch (COMException) { }
        }

        private static List<Label> ReadLabels(IModelDoc2 part)
        {
            var labels = new List<Label>();
            var unit = (IUserUnit)part.GetUserUnit((int)swUserUnitsType_e.swLengthUnit);
            var exact = new ExactSizes(part, unit);
            bool modified = true;
            try { modified = part.GetSaveFlag(); } catch (COMException) { }

            for (var feature = (IFeature)part.FirstFeature(); feature != null; feature = (IFeature)feature.GetNextFeature())
            {
                if (feature.GetTypeName2() != "SolidBodyFolder") continue;
                var folder = (IBodyFolder)feature.GetSpecificFeature2();
                if (folder.GetAutomaticCutList() && (modified || !HasPopulatedCutList(feature)))
                    folder.UpdateCutList();
            }

            for (var root = (IFeature)part.FirstFeature(); root != null; root = (IFeature)root.GetNextFeature())
            {
                if (root.GetTypeName2() != "SolidBodyFolder") continue;

                for (var item = (IFeature)root.GetFirstSubFeature(); item != null; item = (IFeature)item.GetNextSubFeature())
                {
                    if (item.GetTypeName2() != "CutListFolder") continue;

                    var folder = (IBodyFolder)item.GetSpecificFeature2();
                    if (folder.GetBodyCount() == 0) continue;

                    var manager = item.CustomPropertyManager;
                    var bodies = (object[])folder.GetBodies();
                    try
                    {
                        labels.Add(MeasureLabel(part, item.Name, manager, bodies, unit, labels.Count, exact));
                    }
                    catch (Exception error)
                    {
                        labels.Add(UnmeasuredLabel(item.Name, manager, bodies, labels.Count, error));
                    }
                }
            }

            var partColor = AppearanceColor(part, "MaterialPropertyValues");
            foreach (var label in labels) label.PartColor = partColor;
            return labels;
        }

        // True when the solid-bodies folder already has at least one cut-list item with bodies in it.
        private static bool HasPopulatedCutList(IFeature solidBodies)
        {
            for (var item = (IFeature)solidBodies.GetFirstSubFeature(); item != null; item = (IFeature)item.GetNextSubFeature())
                if (item.GetTypeName2() == "CutListFolder" && ((IBodyFolder)item.GetSpecificFeature2()).GetBodyCount() > 0)
                    return true;
            return false;
        }

        // Exact sheet-metal sizes, read from the model instead of from cut-list properties (whose text SolidWorks rounds
        // to the part's decimal places). Each sheet-metal feature gives a thickness and each flat pattern's bounding-box
        // sketch gives a width and length; a cut-list item takes the exact value that rounds to its property's text.
        private sealed class ExactSizes
        {
            private readonly List<decimal> thicknesses = new List<decimal>();
            private readonly List<decimal[]> boxes = new List<decimal[]>();
            // One step of the part's decimal places, in its length unit (0.01 for two places).
            public readonly decimal Step;

            public ExactSizes(IModelDoc2 part, IUserUnit unit)
            {
                int places = 8;
                try
                {
                    places = part.Extension.GetUserPreferenceInteger((int)swUserPreferenceIntegerValue_e.swUnitsLinearDecimalPlaces,
                        (int)swUserPreferenceOption_e.swDetailingNoOptionSpecified);
                }
                catch (COMException) { }
                Step = (decimal)Math.Pow(10, -Math.Max(0, Math.Min(8, places)));
                double factor = unit.GetConversionFactor();
                try
                {
                    for (var feature = (IFeature)part.FirstFeature(); feature != null; feature = (IFeature)feature.GetNextFeature())
                    {
                        string type = feature.GetTypeName2();
                        if (type == "SheetMetal")
                        {
                            double thickness = ReadDouble(SafeDefinition(feature), "Thickness");
                            if (thickness > 0) thicknesses.Add((decimal)(thickness * factor));
                        }
                        else if (type == "FlatPattern")
                        {
                            for (var sub = (IFeature)feature.GetFirstSubFeature(); sub != null; sub = (IFeature)sub.GetNextSubFeature())
                            {
                                var box = BoundingBox(sub, factor);
                                if (box != null) boxes.Add(box);
                            }
                        }
                    }
                }
                catch (COMException) { }
            }

            // The exact thickness matching the rounded property text, or null.
            public decimal? Thickness(decimal rounded)
            {
                return Closest(thicknesses.Where(value => Rounds(value, rounded)), rounded);
            }

            // The exact {width, length} matching the rounded property texts, or null.
            public decimal[] Box(decimal width, decimal length)
            {
                var matches = boxes.Where(box => Rounds(box[0], width) && Rounds(box[1], length)).ToList();
                if (matches.Count == 0) return null;
                return matches.OrderBy(box => Math.Abs(box[0] - width) + Math.Abs(box[1] - length)).First();
            }

            // True if `exact` shows as `rounded` at the part's decimal places (with a little slack for binary rounding).
            public bool Rounds(decimal exact, decimal rounded)
            {
                return Math.Abs(exact - rounded) <= Step / 2 + Step / 1000;
            }

            private static decimal? Closest(IEnumerable<decimal> values, decimal target)
            {
                var list = values.ToList();
                if (list.Count == 0) return null;
                return list.OrderBy(value => Math.Abs(value - target)).First();
            }

            // A flat pattern's bounding-box sketch as {short side, long side}, in the part's unit; null for other sketches.
            private static decimal[] BoundingBox(IFeature sub, double factor)
            {
                if (sub.GetTypeName2() != "ProfileFeature") return null;
                object sketch = null;
                try { sketch = sub.GetSpecificFeature2(); } catch (COMException) { }
                if (sketch == null || !(Invoke(sketch, "IsBoundaryBoxSketch") is bool) || !(bool)Invoke(sketch, "IsBoundaryBoxSketch"))
                    return null;
                var segments = Invoke(sketch, "GetSketchSegments") as object[];
                if (segments == null) return null;
                var lengths = new List<double>();
                foreach (var segment in segments)
                {
                    var line = segment as ISketchSegment;
                    if (line == null || line.GetType() != (int)swSketchSegments_e.swSketchLINE) continue;
                    lengths.Add(line.GetLength() * factor);
                }
                if (lengths.Count != 4) return null;
                lengths.Sort();
                // A rectangle: two short sides and two long sides of equal length.
                if (Math.Abs(lengths[0] - lengths[1]) > 1e-6 * Math.Max(1, lengths[3]) ||
                    Math.Abs(lengths[2] - lengths[3]) > 1e-6 * Math.Max(1, lengths[3]) || !(lengths[0] > 0))
                    return null;
                return new[] { (decimal)lengths[0], (decimal)lengths[3] };
            }

            private static object SafeDefinition(IFeature feature)
            {
                try { return feature.GetDefinition(); } catch (COMException) { return null; }
            }

            private static double ReadDouble(object target, string property)
            {
                var value = Invoke(target, property, BindingFlags.GetProperty);
                return value is double ? (double)value : 0;
            }

            // Late bound, so a SolidWorks version without the member simply gives no exact size.
            private static object Invoke(object target, string member, BindingFlags kind = BindingFlags.InvokeMethod)
            {
                if (target == null) return null;
                try { return target.GetType().InvokeMember(member, kind, null, target, null); }
                catch (Exception) { return null; }
            }
        }

        private static Label MeasureLabel(IModelDoc2 part, string name, ICustomPropertyManager manager, object[] bodies, IUserUnit unit,
            int index, ExactSizes exact)
        {
            string thickness = Read(manager, "Sheet Metal Thickness");
            bool sheet = Array.Exists(bodies, body => ((IBody2)body).IsSheetMetal());
            decimal[] dimensions;
            bool rotated = false;
            // How much SolidWorks rounded each size (in the part's unit); 0 where the size is exact.
            var rounding = new decimal[3];
            if (sheet)
            {
                dimensions = new[] {
                    Dimension(thickness, name, "the sheet thickness"),
                    Dimension(Read(manager, "Bounding Box Width"), name, "the flat-pattern width"),
                    Dimension(Read(manager, "Bounding Box Length"), name, "the flat-pattern length")
                };
                var thick = exact.Thickness(dimensions[0]);
                if (thick.HasValue) dimensions[0] = thick.Value; else rounding[0] = exact.Step;
                var box = exact.Box(dimensions[1], dimensions[2]);
                if (box != null) { dimensions[1] = box[0]; dimensions[2] = box[1]; }
                else rounding[1] = rounding[2] = exact.Step;
            }
            else
            {
                dimensions = SolidDimensions(bodies, unit.GetConversionFactor(), name, out rotated);
            }

            string category = sheet ? "sheet" : (Array.Exists(bodies, IsWeldmentBody) || IsStockProfile(manager, name)) ? "weldment" : "part";
            string lengthSource = sheet ? "Flat-pattern bounding box" : rotated ? "Body extents, rotated to fit the body" : "Body extents";
            decimal nativeLength;
            if (category == "weldment" && TryNativeLength(manager, out nativeLength))
            {
                // SolidWorks' cut length is rounded to the part's decimal places. Where it agrees with the exact length
                // measured from the body, the measured one is kept.
                if (!exact.Rounds(dimensions[2], nativeLength))
                {
                    dimensions[2] = nativeLength;
                    rounding[2] = exact.Step;
                }
                lengthSource = "SolidWorks cut length";
            }
            bool endCap = !sheet && Array.Exists(bodies, IsEndCapBody);
            string detectedShape = sheet ? "" : endCap ? "Box" : GroupShape(bodies);
            // A round regular part is measured across and along its own axis: {diameter} and {length}, even when it's
            // shorter than it is wide (a 1 in bar 0.866 in long). Its thickness and width are the diameter.
            decimal diameter = 0;
            if (category == "part" && detectedShape == "Cylinder")
            {
                double factor = unit.GetConversionFactor(), across = 0, along = 0, d, a;
                bool round = true;
                foreach (IBody2 body in bodies)
                {
                    if (!RoundSize(body, out d, out a)) { round = false; break; }
                    across = Math.Max(across, d);
                    along = Math.Max(along, a);
                }
                if (round)
                {
                    diameter = (decimal)(across * factor);
                    dimensions = new[] { diameter, diameter, (decimal)(along * factor) };
                    rounding = new decimal[3];
                    lengthSource = "Along the cylinder's axis";
                }
            }
            return new Label {
                Manager = manager,
                Name = name,
                Category = category,
                Index = index,
                Body = (IBody2)bodies[0],
                Bodies = bodies,
                Shape = category == "part" ? detectedShape : "",
                DetectedShape = detectedShape,
                DefaultCallout = DefaultCallout(manager, name, bodies),
                Profile = ReadProfile(bodies),
                Material = ReadMaterial(manager),
                Angle1 = ReadText(manager, "ANGLE1"),
                Angle2 = ReadText(manager, "ANGLE2"),
                Gauge = sheet ? ReadGauge(manager) : "",
                Quantity = bodies.Length,
                LengthSource = lengthSource,
                Dimensions = dimensions,
                Rounding = rounding,
                Diameter = diameter,
                EndCap = endCap,
                MetersPerUnit = MetersPerUnitOf(unit)
            };
        }

        // An item that cannot be measured stays in the list so it can be labeled by hand in Custom.
        private static Label UnmeasuredLabel(string name, ICustomPropertyManager manager, object[] bodies, int index, Exception error)
        {
            string category = "part";
            string callout = "";
            try
            {
                category = Array.Exists(bodies, body => ((IBody2)body).IsSheetMetal()) ? "sheet" :
                    (Array.Exists(bodies, IsWeldmentBody) || IsStockProfile(manager, name)) ? "weldment" : "part";
                if (category == "weldment") callout = DefaultCallout(manager, name, bodies);
            }
            catch (Exception) { }
            string reason = error is COMException
                ? "SolidWorks could not return its geometry (" + error.Message + ")"
                : error.Message;
            if (reason.StartsWith(name + ": ", StringComparison.Ordinal)) reason = reason.Substring(name.Length + 2);
            reason = reason.Trim().TrimEnd('.');
            return new Label {
                Manager = manager,
                Name = name,
                Category = category,
                Index = index,
                Body = bodies.Length > 0 ? (IBody2)bodies[0] : null,
                Bodies = bodies,
                Shape = "",
                DetectedShape = "",
                DefaultCallout = callout,
                Profile = SafeProfile(bodies),
                Material = ReadMaterial(manager),
                Gauge = "",
                Quantity = bodies.Length,
                LengthSource = "Not measured",
                Problem = reason
            };
        }

        private static bool IsNativeLengthExpression(string expression)
        {
            var link = (expression ?? "").Trim().Trim('"');
            return link.StartsWith("SW-Length@@@", StringComparison.OrdinalIgnoreCase) ||
                link.StartsWith("Length@@@", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsLengthLinked(ICustomPropertyManager manager)
        {
            string expression, evaluated;
            bool resolved, linked;
            manager.Get6("Length", false, out expression, out evaluated, out resolved, out linked);
            return linked || IsNativeLengthExpression(expression);
        }

        // SolidWorks' own cut length, while the item's Length property is still linked to it. Once labels replace
        // Length with text, the length measured from the body is used instead (reading SolidWorks' value then would
        // mean adding a property, which marks the part as modified).
        private static bool TryNativeLength(ICustomPropertyManager manager, out decimal number)
        {
            string expression, evaluated;
            bool resolved, linked;
            manager.Get6("Length", false, out expression, out evaluated, out resolved, out linked);
            number = 0;
            return IsNativeLengthExpression(expression) && TryPositiveLength(evaluated, out number);
        }

        private static decimal? ParseSortLength(string text)
        {
            decimal value;
            if (TryPositiveLength(text, out value)) return value;
            var match = Regex.Match(text ?? "", @"^\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:in\.?|mm|cm|m|ft\.?|[""'])?\s*$", RegexOptions.IgnoreCase);
            return match.Success && TryPositiveLength(match.Groups[1].Value, out value) ? (decimal?)value : null;
        }

        private static bool TryPositiveLength(string text, out decimal value)
        {
            return (Decimal.TryParse(text, NumberStyles.Float, CultureInfo.CurrentCulture, out value) ||
                Decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value)) && value > 0;
        }

        private static bool IsStockProfile(ICustomPropertyManager manager, string name)
        {
            // Once the add-in has labeled an item, its Description and Length hold the add-in's own labels (and its
            // name may be built from them), so they say nothing about what the item is. It keeps the category it had
            // when it was labeled; otherwise a label such as "TS 2X2X1/4" would turn a regular part into a weldment.
            string basis = Read(manager, "CutListLabelerBasis");
            if (!String.IsNullOrEmpty(basis)) return basis.StartsWith("weldment|", StringComparison.Ordinal);

            string expression, evaluated;
            bool resolved, linked;
            manager.Get6("Length", false, out expression, out evaluated, out resolved, out linked);
            if (!String.IsNullOrEmpty(expression) &&
                expression.IndexOf("SW-Length@@@", StringComparison.OrdinalIgnoreCase) >= 0)
                return true;

            const string stock = @"^\s*(?:(?:TS|HSS|SHS|RHS)\s*\d|(?:SQUARE|RECTANGULAR|ROUND)\s+(?:TUBE|TUBING)\b|PIPE\s+\d.*\b(?:SCH(?:EDULE)?|NPS|STD|XS)\b)";
            foreach (var value in new[] { name, Read(manager, "Description"), Read(manager, "CutListLabelerOriginalCallout") })
                if (!String.IsNullOrEmpty(value) && Regex.IsMatch(value, stock, RegexOptions.IgnoreCase))
                    return true;
            return false;
        }

        // A cut-list item is a weldment when any of its bodies is a structural member. Bodies copied by Mirror Body,
        // Body Pattern or Move/Copy don't carry the member feature in their own history, so requiring it on every
        // body made mirrored or patterned members (angles in particular, which no name rule catches) Regular Parts.
        private static bool IsWeldmentBody(object body)
        {
            var features = ((IBody2)body).GetFeatures() as object[];
            return features != null && Array.Exists(features, feature =>
            {
                switch (((IFeature)feature).GetTypeName2())
                {
                    case "WeldMemberFeat":
                    case "AdvStructMember": return true;
                    // Gussets and end caps are plates without a structural profile, so they are labeled as Regular Parts.
                    default: return false;
                }
            });
        }

        private static string GroupShape(object[] bodies)
        {
            string shape = BodyShape((IBody2)bodies[0]);
            return Array.TrueForAll(bodies, body => BodyShape((IBody2)body) == shape) ? shape : "Mixed";
        }

        // Every body is a Box (its rectangular envelope) unless its envelope is round: a cylindrical face
        // whose diameter matches the body's size across the cylinder's axis.
        private static string BodyShape(IBody2 body)
        {
            double diameter, along;
            return RoundSize(body, out diameter, out along) ? "Cylinder" : "Box";
        }

        // A round body's diameter and its length along the cylinder's axis, in meters. False if the body isn't round.
        private static bool RoundSize(IBody2 body, out double diameter, out double along)
        {
            diameter = along = 0;
            try
            {
                var faces = body.GetFaces() as object[];
                if (faces == null) return false;
                foreach (IFace2 face in faces)
                {
                    var surface = (ISurface)face.GetSurface();
                    if (!surface.IsCylinder()) continue;
                    var cylinder = (double[])surface.CylinderParams;
                    if (cylinder == null || cylinder.Length < 7) continue;
                    double size = 2 * cylinder[6];
                    double tolerance = Math.Max(1e-6, size * 1e-4);
                    var frame = FrameFrom(Normalize(new[] { cylinder[3], cylinder[4], cylinder[5] }), null);
                    if (frame != null &&
                        Math.Abs(Extent(body, frame[1]) - size) <= tolerance &&
                        Math.Abs(Extent(body, frame[2]) - size) <= tolerance)
                    {
                        diameter = size;
                        along = Extent(body, frame[0]);
                        return along > 0;
                    }
                }
                return false;
            }
            catch (COMException) { return false; }
            catch (InvalidOperationException) { return false; }
        }

        // Bodies made by a weldment End Cap feature. They're plates cut to the member's shape, so a round end cap is
        // still labeled as a plate (thickness by width by length), never as round bar.
        private static bool IsEndCapBody(object body)
        {
            try
            {
                var features = ((IBody2)body).GetFeatures() as object[];
                return features != null && Array.Exists(features, feature => ((IFeature)feature).GetTypeName2() == "EndCap");
            }
            catch (COMException) { return false; }
        }

        // Where a weldment member's profile came from. The window uses it to sort members into shape families
        // and to fill size fields such as {side1} and {wall}.
        private sealed class ProfileInfo
        {
            public string Path = "";
            public string Configuration = "";
            public string Standard = "";
            public string Type = "";
            public string Size = "";
            public string Library = "";
        }

        private static string ReadText(ICustomPropertyManager manager, string property)
        {
            return (Read(manager, property) ?? "").Trim();
        }

        // The cut-list item's material, or "" when none is assigned.
        private static string ReadMaterial(ICustomPropertyManager manager)
        {
            string material = ReadText(manager, "MATERIAL");
            return material.StartsWith("<", StringComparison.Ordinal) || material.IndexOf("not specified", StringComparison.OrdinalIgnoreCase) >= 0
                ? "" : material;
        }

        private static ProfileInfo SafeProfile(object[] bodies)
        {
            try { return ReadProfile(bodies); }
            catch (Exception) { return new ProfileInfo(); }
        }

        // Structural members and Structure System members. Their definitions are read by name (late bound),
        // so a SolidWorks version without one of these properties simply yields no profile.
        private static ProfileInfo ReadProfile(object[] bodies)
        {
            foreach (IBody2 body in bodies)
            {
                var features = body.GetFeatures() as object[];
                if (features == null) continue;
                foreach (IFeature feature in features)
                {
                    string type = feature.GetTypeName2();
                    if (type != "WeldMemberFeat" && type != "AdvStructMember") continue;
                    object data = null;
                    try { data = feature.GetDefinition(); } catch (COMException) { }
                    if (data == null) continue;
                    string path = FirstText(data, "WeldmentProfilePath", "ProfilePath", "ProfileFilePath", "ProfileFile");
                    if (path.Length == 0) continue;
                    return DescribeProfile(path, FirstText(data, "ConfigurationName", "ProfileConfiguration", "ProfileConfigurationName"));
                }
            }
            return new ProfileInfo();
        }

        private static string FirstText(object target, params string[] names)
        {
            foreach (var name in names)
            {
                try
                {
                    var value = target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, null) as string;
                    if (!String.IsNullOrWhiteSpace(value)) return value.Trim();
                }
                catch (Exception) { }
            }
            return "";
        }

        // Libraries are laid out as library\standard\shape\size.sldlfp, or library\standard\shape.sldlfp with one
        // configuration per size.
        private static ProfileInfo DescribeProfile(string path, string configuration)
        {
            var info = new ProfileInfo { Path = path, Configuration = configuration ?? "" };
            try
            {
                string file = Path.GetFileNameWithoutExtension(path);
                string folder = Path.GetDirectoryName(path) ?? "";
                bool sizesAsConfigurations = info.Configuration.Length > 0 &&
                    !info.Configuration.Equals("Default", StringComparison.OrdinalIgnoreCase);
                if (sizesAsConfigurations)
                {
                    info.Type = file;
                    info.Size = info.Configuration;
                    info.Standard = Path.GetFileName(folder);
                    info.Library = folder.Length > 0 ? Path.GetDirectoryName(folder) ?? "" : "";
                }
                else
                {
                    info.Size = file;
                    info.Type = Path.GetFileName(folder);
                    string standard = folder.Length > 0 ? Path.GetDirectoryName(folder) ?? "" : "";
                    info.Standard = Path.GetFileName(standard);
                    info.Library = standard.Length > 0 ? Path.GetDirectoryName(standard) ?? "" : "";
                }
            }
            catch (ArgumentException) { }
            return info;
        }

        // Lists the shapes in a profile library the user chose to read: folder names and profile file names only.
        private static object ReadLibrary(string root)
        {
            if (String.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
                throw new InvalidOperationException("The profile library folder " + root + " couldn't be found.");
            var shapes = new List<object>();
            foreach (var standard in Directory.GetDirectories(root))
            {
                string standardName = Path.GetFileName(standard);
                foreach (var shape in Directory.GetDirectories(standard))
                {
                    shapes.Add(new { standard = standardName, type = Path.GetFileName(shape),
                        sizes = Directory.GetFiles(shape, "*.sldlfp").Length });
                    if (shapes.Count >= 1000) break;
                }
                foreach (var file in Directory.GetFiles(standard, "*.sldlfp"))
                {
                    shapes.Add(new { standard = standardName, type = Path.GetFileNameWithoutExtension(file), sizes = 0 });
                    if (shapes.Count >= 1000) break;
                }
                if (shapes.Count >= 1000) break;
            }
            return new { type = "library", path = root, shapes };
        }

        private static string DefaultCallout(ICustomPropertyManager manager, string name, object[] bodies)
        {
            string original = Read(manager, "CutListLabelerOriginalCallout");
            if (!String.IsNullOrWhiteSpace(original)) return original;

            string description = Read(manager, "Description");
            if (!String.IsNullOrWhiteSpace(description) &&
                !Regex.IsMatch(description, @"^(WELDMENT|SOLID) \d+(?:\.\d+)? X \d+(?:\.\d+)?$", RegexOptions.IgnoreCase))
                return description;

            foreach (IBody2 body in bodies)
            {
                var features = body.GetFeatures() as object[];
                if (features == null) continue;
                foreach (IFeature feature in features)
                {
                    if (feature.GetTypeName2() != "WeldMemberFeat") continue;
                    var data = feature.GetDefinition() as IStructuralMemberFeatureData;
                    if (data != null && !String.IsNullOrWhiteSpace(data.WeldmentProfilePath))
                        return Path.GetFileNameWithoutExtension(data.WeldmentProfilePath);
                }
            }
            return Regex.Replace(name, @"<\d+>$", "");
        }

        // Exact meters per unit for the usual SolidWorks length units; otherwise derived from SolidWorks' factor.
        private static decimal MetersPerUnitOf(IUserUnit unit)
        {
            double perMeter = unit.GetConversionFactor();
            foreach (var exact in new[] { 0.001m, 0.01m, 1m, 0.0254m, 0.3048m, 0.0000254m, 0.000001m })
                if (Math.Abs(perMeter * (double)exact - 1) < 1e-9) return exact;
            return (decimal)(1 / perMeter);
        }

        private static decimal ToUnits(Label label, decimal value, string units)
        {
            decimal meters = value * label.MetersPerUnit;
            return units == "metric" ? meters * 1000m : meters / 0.0254m;
        }

        private static Dictionary<string, string[]> UnitOptions(Label label, int axis)
        {
            var options = new Dictionary<string, string[]>();
            foreach (var units in new[] { "imperial", "metric" })
                options[units] = label.Dimensions == null ? new string[0] : DimensionOptions(ToUnits(label, label.Dimensions[axis], units));
            return options;
        }

        private static string[] DimensionOptions(decimal number)
        {
            return Array.ConvertAll(new[] { 0, 1, 2, 3, 4, 5, 6, 7, 8 }, places => Format(number, places));
        }

        private static string Format(decimal number, int places)
        {
            return Math.Round(number, places, MidpointRounding.AwayFromZero)
                .ToString("F" + places, CultureInfo.InvariantCulture);
        }

        private static string ReadGauge(ICustomPropertyManager manager)
        {
            var gauge = (Read(manager, "Sheet Metal Gauge") ?? "").Trim();
            return gauge.Length == 0 || gauge.IndexOf("not specified", StringComparison.OrdinalIgnoreCase) >= 0 ||
                gauge.StartsWith("<", StringComparison.Ordinal) ? "" :
                Regex.Replace(gauge, @"^(?:GA(?:UGE)?[\s:#-]*)?(\d+(?:[.,]\d+)?)[\s-]*(?:GA(?:UGE)?\.?)?$", "$1 GA", RegexOptions.IgnoreCase);
        }

        private static decimal[] SolidDimensions(object[] bodies, double factor, string name, out bool rotated)
        {
            var maximum = new double[3];
            rotated = false;
            foreach (IBody2 body in bodies)
            {
                bool turned;
                double[] extents;
                try { extents = FitExtents(body, out turned); }
                catch (InvalidOperationException) { throw new InvalidOperationException("Could not measure " + body.Name + " in " + name + "."); }
                rotated |= turned;
                for (int axis = 0; axis < 3; axis++) extents[axis] *= factor;
                Array.Sort(extents);
                for (int axis = 0; axis < 3; axis++)
                    maximum[axis] = Math.Max(maximum[axis], extents[axis]);
            }
            if (!(maximum[0] > 0))
                throw new InvalidOperationException("Could not measure three positive dimensions for " + name + ".");
            return Array.ConvertAll(maximum, value => (decimal)value);
        }

        private static readonly double[][] PartAxes = { new[] { 1.0, 0, 0 }, new[] { 0, 1.0, 0 }, new[] { 0, 0, 1.0 } };

        // The body's envelope, in meters: along the part's X, Y and Z axes, unless an orientation taken from the
        // body's own faces gives a smaller box (a part modeled at an angle). Only the frame search uses the
        // tessellation; the returned sizes are exact.
        private static double[] FitExtents(IBody2 body, out bool rotated)
        {
            rotated = false;
            var aligned = Extents(body, PartAxes);
            double[][] best = null;
            try
            {
                var points = BodyPoints(body);
                var directions = CandidateDirections(body);
                if (points.Length >= 12 && directions.Count > 0)
                {
                    double alignedVolume = Volume(PointExtents(points, PartAxes));
                    double bestVolume = alignedVolume;
                    foreach (var frame in CandidateFrames(directions))
                    {
                        double volume = Volume(PointExtents(points, frame));
                        if (volume < bestVolume) { bestVolume = volume; best = frame; }
                    }
                    if (bestVolume >= alignedVolume * (1 - 1e-6)) best = null;
                }
            }
            catch (COMException) { best = null; }
            if (best == null) return aligned;
            var fitted = Extents(body, best);
            if (Volume(fitted) >= Volume(aligned) * (1 - 1e-6)) return aligned;
            rotated = true;
            return fitted;
        }

        private static double[] Extents(IBody2 body, double[][] frame)
        {
            return Array.ConvertAll(frame, direction => Extent(body, direction));
        }

        // Exact size of the body along one direction, in meters.
        private static double Extent(IBody2 body, double[] d)
        {
            double highX, highY, highZ, lowX, lowY, lowZ;
            if (!body.GetExtremePoint(d[0], d[1], d[2], out highX, out highY, out highZ) ||
                !body.GetExtremePoint(-d[0], -d[1], -d[2], out lowX, out lowY, out lowZ))
                throw new InvalidOperationException("Could not measure " + body.Name + ".");
            return d[0] * (highX - lowX) + d[1] * (highY - lowY) + d[2] * (highZ - lowZ);
        }

        private static float[] BodyPoints(IBody2 body)
        {
            var points = new List<float>();
            var faces = body.GetFaces() as object[];
            if (faces == null) return points.ToArray();
            foreach (IFace2 face in faces)
            {
                var triangles = face.GetTessTriangles(true) as float[];
                if (triangles != null) points.AddRange(triangles);
            }
            return points.ToArray();
        }

        private static double[] PointExtents(float[] points, double[][] frame)
        {
            var extents = new double[3];
            for (int axis = 0; axis < 3; axis++)
            {
                var d = frame[axis];
                double low = Double.MaxValue, high = Double.MinValue;
                for (int i = 0; i + 2 < points.Length; i += 3)
                {
                    double value = d[0] * points[i] + d[1] * points[i + 1] + d[2] * points[i + 2];
                    if (value < low) low = value;
                    if (value > high) high = value;
                }
                extents[axis] = high - low;
            }
            return extents;
        }

        // Directions of the body's flat faces and round axes, largest faces first (at most 12).
        private static List<double[]> CandidateDirections(IBody2 body)
        {
            var directions = new List<double[]>();
            var areas = new List<double>();
            var faces = body.GetFaces() as object[];
            if (faces == null) return directions;
            foreach (IFace2 face in faces)
            {
                var surface = (ISurface)face.GetSurface();
                double[] direction = null;
                if (surface.IsPlane()) direction = face.Normal as double[];
                else if (surface.IsCylinder())
                {
                    var cylinder = surface.CylinderParams as double[];
                    if (cylinder != null && cylinder.Length >= 6) direction = new[] { cylinder[3], cylinder[4], cylinder[5] };
                }
                direction = direction == null || direction.Length < 3 ? null : Normalize(direction);
                if (direction == null) continue;
                double area = face.GetArea();
                int match = directions.FindIndex(existing => Math.Abs(Dot(existing, direction)) > 0.9999);
                if (match >= 0) areas[match] += area;
                else { directions.Add(direction); areas.Add(area); }
            }
            var order = Enumerable.Range(0, directions.Count).OrderByDescending(i => areas[i]).Take(12);
            return order.Select(i => directions[i]).ToList();
        }

        private static IEnumerable<double[][]> CandidateFrames(List<double[]> directions)
        {
            for (int i = 0; i < directions.Count; i++)
            {
                var single = FrameFrom(directions[i], null);
                if (single != null) yield return single;
                for (int j = i + 1; j < directions.Count; j++)
                {
                    var pair = FrameFrom(directions[i], directions[j]);
                    if (pair != null) yield return pair;
                }
            }
        }

        // An orthonormal frame whose first axis is `first` and whose second lies toward `second`
        // (or any perpendicular direction when `second` is null). Null if the directions are too close.
        private static double[][] FrameFrom(double[] first, double[] second)
        {
            if (first == null) return null;
            if (second == null)
            {
                var axis = Math.Abs(first[0]) < 0.9 ? new[] { 1.0, 0, 0 } : new[] { 0, 1.0, 0 };
                second = Cross(first, axis);
            }
            double along = Dot(first, second);
            var w = new[] { second[0] - along * first[0], second[1] - along * first[1], second[2] - along * first[2] };
            if (Math.Sqrt(Dot(w, w)) < 0.1) return null;
            w = Normalize(w);
            return new[] { first, w, Cross(first, w) };
        }

        private static double Volume(double[] extents)
        {
            return extents[0] * extents[1] * extents[2];
        }

        private static double Dot(double[] a, double[] b)
        {
            return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        }

        private static double[] Cross(double[] a, double[] b)
        {
            return new[] { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] };
        }

        private static double[] Normalize(double[] v)
        {
            double length = Math.Sqrt(Dot(v, v));
            return length > 0 ? new[] { v[0] / length, v[1] / length, v[2] / length } : null;
        }

        private static string Read(ICustomPropertyManager manager, string name)
        {
            string expression, evaluated;
            bool resolved, linked;
            manager.Get6(name, false, out expression, out evaluated, out resolved, out linked);
            return evaluated;
        }

        private static decimal Dimension(string value, string name, string field)
        {
            decimal number;
            if ((!Decimal.TryParse(value, NumberStyles.Float, CultureInfo.CurrentCulture, out number) &&
                 !Decimal.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number)) || number <= 0)
                throw new InvalidOperationException(name + ": " + field + " is missing or is not a positive number.");
            return number;
        }

        private sealed class MeshData
        {
            public float[] Points = new float[0];
            // Triangles per SolidWorks face, in order, so the preview can draw real model edges.
            public int[] Faces = new int[0];
            // Red, green, blue (0 to 1) for each face in Faces; empty when SolidWorks reports no colors.
            public double[] FaceColors = new double[0];
            public double[] BodyColor;
        }

        private static MeshData PreviewMesh(IBody2 body, double[] partColor = null)
        {
            var mesh = new MeshData();
            if (body == null) return mesh;
            try
            {
                var points = new List<float>();
                var counts = new List<int>();
                var colors = new List<double>();
                bool painted = false;
                mesh.BodyColor = AppearanceColor(body, "MaterialPropertyValues2") ?? partColor;
                var faces = body.GetFaces() as object[];
                if (faces == null) return mesh;
                foreach (IFace2 face in faces)
                {
                    var triangles = face.GetTessTriangles(true) as float[];
                    if (triangles == null || triangles.Length % 9 != 0) continue;
                    points.AddRange(triangles);
                    counts.Add(triangles.Length / 9);
                    var own = AppearanceColor(face, "MaterialPropertyValues");
                    painted |= own != null;
                    colors.AddRange(own ?? mesh.BodyColor ?? new[] { -1.0, -1.0, -1.0 });
                }
                mesh.Points = points.ToArray();
                mesh.Faces = counts.ToArray();
                // Per-face colors only when a face has its own; otherwise the body color covers every face.
                if (painted && mesh.BodyColor != null) mesh.FaceColors = colors.ToArray();
                else if (painted)
                    mesh.FaceColors = colors.Select(value => value < 0 ? 0.7 : value).ToArray();
                return mesh;
            }
            catch (COMException)
            {
                return new MeshData();
            }
        }

        // A display color from SolidWorks' material property values (red, green, blue, ... each 0 to 1), read
        // late bound so a SolidWorks version without the property simply has no color. Null when none is set.
        private static double[] AppearanceColor(object target, string property)
        {
            if (target == null) return null;
            try
            {
                var values = target.GetType().InvokeMember(property, BindingFlags.GetProperty, null, target, null) as double[];
                if (values == null || values.Length < 3) return null;
                for (int i = 0; i < 3; i++)
                    if (Double.IsNaN(values[i]) || values[i] < 0 || values[i] > 1) return null;
                return new[] { values[0], values[1], values[2] };
            }
            catch (Exception) { return null; }
        }

        private static void Write(ICustomPropertyManager manager, string item, string property, string value)
        {
            string expression, evaluated;
            bool resolved, linked;
            manager.Get6(property, false, out expression, out evaluated, out resolved, out linked);
            if (expression == value && evaluated == value) return;

            int oldType = manager.GetType2(property);
            string oldExpression = expression;
            bool wasLinked = linked;
            if (linked) manager.LinkProperty(property, false);

            int result = manager.Add3(property, (int)swCustomInfoType_e.swCustomInfoText, value,
                (int)swCustomPropertyAddOption_e.swCustomPropertyReplaceValue);
            manager.Get6(property, false, out expression, out evaluated, out resolved, out linked);
            if (expression == value && evaluated == value) return;

            if (oldType == (int)swCustomInfoType_e.swCustomInfoText)
            {
                manager.Set2(property, value);
                manager.Get6(property, false, out expression, out evaluated, out resolved, out linked);
                if (expression == value && evaluated == value) return;
            }

            if (oldType != (int)swCustomInfoType_e.swCustomInfoUnknown)
            {
                result = manager.Add3(property, (int)swCustomInfoType_e.swCustomInfoText, value,
                    (int)swCustomPropertyAddOption_e.swCustomPropertyDeleteAndAdd);
                manager.Get6(property, false, out expression, out evaluated, out resolved, out linked);
                if (expression == value && evaluated == value) return;
                if (expression != oldExpression || manager.GetType2(property) != oldType)
                    manager.Add3(property, oldType, oldExpression, (int)swCustomPropertyAddOption_e.swCustomPropertyDeleteAndAdd);
                if (wasLinked) manager.LinkProperty(property, true);
            }

            throw new InvalidOperationException(item + ": SolidWorks would not replace " + property +
                " with the requested text (result " + result + ").");
        }

        private void Show(string message, swMessageBoxIcon_e icon)
        {
            app.SendMsgToUser2(message, (int)icon, (int)swMessageBoxBtn_e.swMbOk);
        }

        private sealed class Label
        {
            public ICustomPropertyManager Manager;
            public string Name;
            public string Category;
            public int Index;
            public LabelSettings Custom;
            public FieldLocks Locks;
            public IBody2 Body;
            // Every body in the item, for its fingerprint.
            public object[] Bodies;
            public string Gauge;
            public string Material = "";
            // Weldment end-cut angles, as SolidWorks reports them.
            public string Angle1 = "";
            public string Angle2 = "";
            public string DefaultCallout;
            public string Shape;
            public string DetectedShape;
            public string Type { get { return Category == "sheet" ? "Sheet" : Category == "weldment" ? "Weldment" : "Solid"; } }
            public int Quantity;
            public decimal[] Dimensions;
            // How much SolidWorks rounded each of Dimensions (part units); 0 where the size is exact.
            public decimal[] Rounding = new decimal[3];
            // A round regular part's diameter (part units), 0 for other items; and whether the item is a weldment end cap.
            public decimal Diameter;
            public bool EndCap;
            // Meters per part length unit, to convert Dimensions to inches or millimeters.
            public decimal MetersPerUnit;
            public string LengthSource;
            public string Problem;
            public ProfileInfo Profile = new ProfileInfo();
            // The part's own appearance color, used for bodies that don't have one.
            public double[] PartColor;

            // A fingerprint of everything the labels are built from, in units that don't depend on the document's.
            public string Basis()
            {
                var parts = new List<string> { Category, Quantity.ToString(CultureInfo.InvariantCulture) };
                if (Dimensions == null) parts.Add("unmeasured");
                else foreach (var dimension in Dimensions)
                    parts.Add(Math.Round(dimension * MetersPerUnit, 5).ToString(CultureInfo.InvariantCulture));
                parts.AddRange(new[] { Profile.Size ?? "", Material ?? "", Angle1 ?? "", Angle2 ?? "", Gauge ?? "" });
                return String.Join("|", parts);
            }

            // Whether a stored Basis() still describes this item. Sizes may differ by the rounding SolidWorks applied
            // (one read can be exact and another rounded to the part's decimal places), so they're compared within it.
            public bool MatchesBasis(string stored)
            {
                string current = Basis();
                if (stored == current) return true;
                var was = stored.Split('|');
                var now = current.Split('|');
                if (was.Length != now.Length || Dimensions == null || was.Length != 10) return false;
                for (int i = 0; i < was.Length; i++)
                {
                    if (i < 2 || i > 4) { if (was[i] != now[i]) return false; continue; }
                    decimal before, after;
                    if (!Decimal.TryParse(was[i], NumberStyles.Float, CultureInfo.InvariantCulture, out before) ||
                        !Decimal.TryParse(now[i], NumberStyles.Float, CultureInfo.InvariantCulture, out after)) return false;
                    decimal slack = Math.Max(0.00001m, (Rounding != null ? Rounding[i - 2] : 0) * MetersPerUnit);
                    if (Math.Abs(before - after) > slack + 0.000005m) return false;
                }
                return true;
            }
            public string Description;
            public string Length;
        }

        private sealed class PropertySnapshot
        {
            public ICustomPropertyManager Manager;
            public string Item;
            public string Name;
            public bool Present;
            public int Type;
            public string Expression;
            public bool Linked;
            // What Apply wrote. Undo only puts back a property that still holds it.
            public string Written;
        }

        private sealed class PropertyJournal
        {
            private readonly List<PropertySnapshot> snapshots = new List<PropertySnapshot>();
            private readonly HashSet<string> recorded = new HashSet<string>();

            public void Write(ICustomPropertyManager manager, string item, string property, string value)
            {
                if (recorded.Add(item + "\n" + property))
                {
                    string expression, evaluated;
                    bool resolved, linked;
                    int found = manager.Get6(property, false, out expression, out evaluated, out resolved, out linked);
                    bool present = found != (int)swCustomInfoGetResult_e.swCustomInfoGetResult_NotPresent;
                    snapshots.Add(new PropertySnapshot {
                        Manager = manager, Item = item, Name = property, Present = present,
                        Type = present ? manager.GetType2(property) : 0,
                        Expression = expression, Linked = linked
                    });
                }
                AddIn.Write(manager, item, property, value);
                snapshots.Find(snap => snap.Item == item && snap.Name == property).Written = value;
            }

            // Undo in reverse order. Returns "item: property" for anything that could not be put back.
            // For a later undo (`changed` given), a property edited since Apply is left as it is and listed in `changed`,
            // so Undo never overwrites someone's later edit.
            public List<string> Restore(Func<string, ICustomPropertyManager> resolve = null, List<string> changed = null)
            {
                var failed = new List<string>();
                for (int i = snapshots.Count - 1; i >= 0; i--)
                {
                    var snap = snapshots[i];
                    // For a later undo the managers are looked up again by item name, since the cut list may have been rebuilt.
                    var manager = resolve == null ? snap.Manager : resolve(snap.Item);
                    if (manager == null) { failed.Add(snap.Item + ": " + snap.Name); continue; }
                    try
                    {
                        string expression, evaluated;
                        bool resolved, linked;
                        if (changed != null && snap.Written != null)
                        {
                            bool present = manager.Get6(snap.Name, false, out expression, out evaluated, out resolved, out linked) !=
                                (int)swCustomInfoGetResult_e.swCustomInfoGetResult_NotPresent;
                            if (!present || expression != snap.Written)
                            {
                                changed.Add(snap.Item + ": " + snap.Name);
                                continue;
                            }
                        }
                        if (!snap.Present)
                        {
                            manager.Delete2(snap.Name);
                            if (manager.Get6(snap.Name, false, out expression, out evaluated, out resolved, out linked) !=
                                (int)swCustomInfoGetResult_e.swCustomInfoGetResult_NotPresent)
                                failed.Add(snap.Item + ": " + snap.Name);
                            continue;
                        }
                        manager.Get6(snap.Name, false, out expression, out evaluated, out resolved, out linked);
                        if (expression == snap.Expression && linked == snap.Linked) continue;
                        if (linked) manager.LinkProperty(snap.Name, false);
                        manager.Add3(snap.Name, snap.Type, snap.Expression,
                            (int)swCustomPropertyAddOption_e.swCustomPropertyDeleteAndAdd);
                        if (snap.Linked) manager.LinkProperty(snap.Name, true);
                        manager.Get6(snap.Name, false, out expression, out evaluated, out resolved, out linked);
                        if (expression != snap.Expression) failed.Add(snap.Item + ": " + snap.Name);
                    }
                    catch (Exception)
                    {
                        failed.Add(snap.Item + ": " + snap.Name);
                    }
                }
                return failed;
            }
        }

        private static FieldLocks ReadLocks(ICustomPropertyManager manager)
        {
            string value = Read(manager, "CutListLabelerLocks") ?? "";
            return new FieldLocks { Description = value.Contains("D"), Length = value.Contains("L") };
        }

        private sealed class FieldLocks
        {
            public bool Description { get; set; }
            public bool Length { get; set; }

            public string Encode()
            {
                return (Description ? "D" : "-") + (Length ? "L" : "-");
            }
        }

        private sealed class LabelResponse
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
            public LabelResponse[] Batch { get; set; }
            public string ShapeRules { get; set; }
            public string LibraryPath { get; set; }
            // Labels exactly as the window shows them, by item index; written as-is for the selected items.
            public Dictionary<string, LabelSettings> Labels { get; set; }
        }

        private sealed class LabelSettings
        {
            private const string Key = @"Software\SheetMetalCutList\Settings";
            private static LabelSettings Defaults(string category)
            {
                return new LabelSettings {
                    Description = category == "weldment" ? "{default}" : "{type} {thickness} X {width}",
                    Decimals = 3,
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
            public int Decimals { get; set; }
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
