namespace SheetMetalCutList
{
    // Which label fields the user locked on a cut-list item, stored in its CutListLabelerLocks property.
    public sealed partial class AddIn
    {
        private sealed class FieldLocks
        {
            public bool Description { get; set; }
            public bool Length { get; set; }

            public string Encode()
            {
                return (Description ? "D" : "-") + (Length ? "L" : "-");
            }
        }
    }
}
