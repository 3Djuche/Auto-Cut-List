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
    // What kind of item a body is: weldment member, end cap, stock profile, box or round.
    public sealed partial class AddIn
    {
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
    }
}
