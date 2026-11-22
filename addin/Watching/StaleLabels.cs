using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SheetMetalCutList
{
    public sealed partial class AddIn
    {
        // Parts being watched so a save can warn about labels the model has outgrown.
        private SldWorks swEvents;
        private DSldWorksEvents_ActiveDocChangeNotifyEventHandler activeDocChanged;
        private readonly List<WatchedPart> watched = new List<WatchedPart>();

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
    }
}
