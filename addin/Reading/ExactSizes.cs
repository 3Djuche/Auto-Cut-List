using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SheetMetalCutList
{
    public sealed partial class AddIn
    {
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
    }
}
