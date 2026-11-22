namespace SheetMetalCutList
{
    // One row of the export's stock-totals sheet.
    public sealed partial class AddIn
    {
        private sealed class StockTotal
        {
            public string Profile;
            public string Material;
            public int Pieces;
            public int Unmeasured;
            public decimal Length;
        }
    }
}
