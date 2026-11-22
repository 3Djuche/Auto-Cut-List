namespace SheetMetalCutList
{
    // A body's triangles and colors, sent to the window for its 3D preview.
    public sealed partial class AddIn
    {
        private sealed class MeshData
        {
            public float[] Points = new float[0];
            // Triangles per SolidWorks face, in order, so the preview can draw real model edges.
            public int[] Faces = new int[0];
            // Red, green, blue (0 to 1) for each face in Faces; empty when SolidWorks reports no colors.
            public double[] FaceColors = new double[0];
            public double[] BodyColor;
        }
    }
}
