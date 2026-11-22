using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SheetMetalCutList
{
    public sealed partial class AddIn
    {
        // Applies labels to several open parts. Each part is all-or-nothing; a part that changed since the
        // window read it is skipped.
        private object ApplyBatch(Session current, IpcRequest message)
        {
            var steps = new List<UndoStep>();
            var skipped = new List<string>();
            var originals = new List<KeyValuePair<IModelDoc2, string>>();
            int items = 0;
            try
            {
                foreach (var request in message.Batch ?? new IpcRequest[0])
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

        // True when every item's stored Description and Length still match what the window was showing.
        private static bool LabelsMatch(List<Label> labels, IpcRequest message)
        {
            if (message.Descriptions == null || message.Lengths == null ||
                message.Descriptions.Length != labels.Count || message.Lengths.Length != labels.Count) return false;
            for (int i = 0; i < labels.Count; i++)
                if ((Read(labels[i].Manager, "Description") ?? "") != message.Descriptions[i] ||
                    (Read(labels[i].Manager, "Length") ?? "") != message.Lengths[i]) return false;
            return true;
        }

        // Writes the selected entries' labels. All-or-nothing: on any failure every changed property is restored.
        private static int ApplyLabels(List<Label> labels, IpcRequest response, out PropertyJournal journal)
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
                        journal.Write(label, "CutListLabelerOriginalCallout", label.DefaultCallout);
                    if (!label.Locks.Description) journal.Write(label, "Description", label.Description);
                    if (!label.Locks.Length) journal.Write(label, "Length", label.Length);
                    if (response.Custom != null && (label.Custom != null || Read(label.Manager, "CutListLabelerCustom") != ""))
                        journal.Write(label, "CutListLabelerCustom", label.Custom == null ? "-" : Convert.ToBase64String(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(label.Custom))));
                    var previous = ReadLocks(label.Manager);
                    if (previous.Description != label.Locks.Description || previous.Length != label.Locks.Length)
                        journal.Write(label, "CutListLabelerLocks", label.Locks.Encode());
                    // What the item measured when it was labeled; a later difference means the label may be out of date.
                    journal.Write(label, "CutListLabelerBasis", label.Basis());
                    if (label.Bodies != null)
                        journal.Write(label, "CutListLabelerFingerprint", Fingerprint(label.Bodies, label.Manager));
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

        // Called after the add-in writes to a part. Writing cut-list properties through the API doesn't reliably mark
        // the part as modified, so it is marked here: SolidWorks then offers to save the labels, and every later
        // read updates the cut list first (see ReadLabels) and so sees them.
        private static void MarkWritten(IModelDoc2 part)
        {
            try { part.SetSaveFlag(); } catch (COMException) { }
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
    }
}
