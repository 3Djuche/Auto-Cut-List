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
    // Undo last apply: what each Apply changed, and putting it back.
    public sealed partial class AddIn
    {
        private sealed class UndoStep
        {
            public IModelDoc2 Part;
            public string Configuration;
            public string Title;
            public PropertyJournal Journal;
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
                    var labels = ReadLabels(step.Part);
                    foreach (var label in labels) managers[label.Name] = label.Manager;
                    var edited = new List<string>();
                    var part = step.Part;
                    failed.AddRange(step.Journal.Restore(snap => {
                        // The same cut-list folder, even if SolidWorks renamed it after Apply changed its Description.
                        var manager = FromPersistReference(part, snap.PersistId);
                        if (manager != null) return manager;
                        if (managers.TryGetValue(snap.Item, out manager)) return manager;
                        // Last resort: the one item whose Description is still exactly what Apply wrote for this one.
                        string wrote = step.Journal.Written(snap.Item, "Description");
                        if (wrote == null) return null;
                        var matches = labels.FindAll(label => Expression(label.Manager, "Description") == wrote);
                        return matches.Count == 1 ? matches[0].Manager : null;
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

        private sealed class PropertySnapshot
        {
            public ICustomPropertyManager Manager;
            public string Item;
            public byte[] PersistId;
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

            public void Write(Label label, string property, string value)
            {
                Write(label.Manager, label.Name, property, value);
                snapshots.Find(snap => snap.Item == label.Name && snap.Name == property).PersistId = label.PersistId;
            }

            // What Apply wrote to `property` of `item`, or null if it wrote nothing there.
            public string Written(string item, string property)
            {
                var snap = snapshots.Find(s => s.Item == item && s.Name == property);
                return snap == null ? null : snap.Written;
            }

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
            public List<string> Restore(Func<PropertySnapshot, ICustomPropertyManager> resolve = null, List<string> changed = null)
            {
                var failed = new List<string>();
                for (int i = snapshots.Count - 1; i >= 0; i--)
                {
                    var snap = snapshots[i];
                    // For a later undo the managers are looked up again, since the cut list may have been rebuilt or renamed.
                    var manager = resolve == null ? snap.Manager : resolve(snap);
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
    }
}
