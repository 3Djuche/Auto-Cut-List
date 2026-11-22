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
        // Reads the part's cut list without marking an unmodified part as modified: SolidWorks flags a document after
        // any programmatic change (even one that is undone), and there is no way to clear that flag.
        //
        // Updating the cut list is such a change, but SolidWorks only hands back current cut-list property values after
        // one: without it, labels written by Apply still read as the old ones. So the cut list is updated whenever the
        // part is already modified (as it is after Apply, Undo or any edit), where updating costs nothing, and when it
        // has never been generated. A part just opened or saved is read as it is, which is also how it was saved.
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
                    labels[labels.Count - 1].PersistId = PersistReference(part, item);
                }
            }

            var partColor = AppearanceColor(part, "MaterialPropertyValues");
            foreach (var label in labels) label.PartColor = partColor;
            return labels;
        }

        // A reference to a cut-list folder that stays the same when SolidWorks renames the folder. Null if none is given.
        private static byte[] PersistReference(IModelDoc2 part, IFeature item)
        {
            try { return part.Extension.GetPersistReference3(item) as byte[]; }
            catch (COMException) { return null; }
        }

        // The custom properties of the cut-list folder `persistId` refers to, or null if it no longer exists.
        private static ICustomPropertyManager FromPersistReference(IModelDoc2 part, byte[] persistId)
        {
            if (persistId == null) return null;
            try
            {
                int error;
                var feature = part.Extension.GetObjectByPersistReference3(persistId, out error) as IFeature;
                return feature != null && feature.GetTypeName2() == "CutListFolder" ? feature.CustomPropertyManager : null;
            }
            catch (COMException) { return null; }
        }

        // True when the solid-bodies folder already has at least one cut-list item with bodies in it.
        private static bool HasPopulatedCutList(IFeature solidBodies)
        {
            for (var item = (IFeature)solidBodies.GetFirstSubFeature(); item != null; item = (IFeature)item.GetNextSubFeature())
                if (item.GetTypeName2() == "CutListFolder" && ((IBodyFolder)item.GetSpecificFeature2()).GetBodyCount() > 0)
                    return true;
            return false;
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
    }
}
