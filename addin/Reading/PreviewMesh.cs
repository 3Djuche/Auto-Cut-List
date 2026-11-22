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
    // The window's 3D preview: a body's triangles and colors.
    public sealed partial class AddIn
    {
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
    }
}
