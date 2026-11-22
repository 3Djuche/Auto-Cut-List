using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;

namespace SheetMetalCutList
{
    // Sizes a solid body by the smallest box around it, trying orientations taken from the body's own faces.
    // Reads the body through SolidWorks' body API but keeps no state.
    public sealed partial class AddIn
    {
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
    }
}
