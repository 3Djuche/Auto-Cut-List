namespace SheetMetalCutList
{
    public sealed partial class AddIn
    {
        // Where a weldment member's profile came from. The window uses it to sort members into shape families
        // and to fill size fields such as {side1} and {wall}.
        private sealed class ProfileInfo
        {
            public string Path = "";
            public string Configuration = "";
            public string Standard = "";
            public string Type = "";
            public string Size = "";
            public string Library = "";
        }
    }
}
