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
    // Cut lengths: SolidWorks' own cut length and length text typed into the Length property.
    public sealed partial class AddIn
    {
        private static bool IsNativeLengthExpression(string expression)
        {
            var link = (expression ?? "").Trim().Trim('"');
            return link.StartsWith("SW-Length@@@", StringComparison.OrdinalIgnoreCase) ||
                link.StartsWith("Length@@@", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsLengthLinked(ICustomPropertyManager manager)
        {
            string expression, evaluated;
            bool resolved, linked;
            manager.Get6("Length", false, out expression, out evaluated, out resolved, out linked);
            return linked || IsNativeLengthExpression(expression);
        }

        // SolidWorks' own cut length, while the item's Length property is still linked to it. Once labels replace
        // Length with text, the length measured from the body is used instead (reading SolidWorks' value then would
        // mean adding a property, which marks the part as modified).
        private static bool TryNativeLength(ICustomPropertyManager manager, out decimal number)
        {
            string expression, evaluated;
            bool resolved, linked;
            manager.Get6("Length", false, out expression, out evaluated, out resolved, out linked);
            number = 0;
            return IsNativeLengthExpression(expression) && TryPositiveLength(evaluated, out number);
        }

        private static decimal? ParseSortLength(string text)
        {
            decimal value;
            if (TryPositiveLength(text, out value)) return value;
            var match = Regex.Match(text ?? "", @"^\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:in\.?|mm|cm|m|ft\.?|[""'])?\s*$", RegexOptions.IgnoreCase);
            return match.Success && TryPositiveLength(match.Groups[1].Value, out value) ? (decimal?)value : null;
        }

        private static bool TryPositiveLength(string text, out decimal value)
        {
            return (Decimal.TryParse(text, NumberStyles.Float, CultureInfo.CurrentCulture, out value) ||
                Decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value)) && value > 0;
        }
    }
}
