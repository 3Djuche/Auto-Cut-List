using System;
using System.Collections.Generic;

namespace SheetMetalCutList
{
    // Plain 3D vector math for the box fitting. Touches nothing in SolidWorks.
    public sealed partial class AddIn
    {
        private static readonly double[][] PartAxes = { new[] { 1.0, 0, 0 }, new[] { 0, 1.0, 0 }, new[] { 0, 0, 1.0 } };

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
    }
}
