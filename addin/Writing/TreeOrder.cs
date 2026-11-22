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
    // Reordering cut-list items in the FeatureManager tree to match the window's sort.
    public sealed partial class AddIn
    {
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
    }
}
