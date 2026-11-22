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
        // Exact meters per unit for the usual SolidWorks length units; otherwise derived from SolidWorks' factor.
        private static decimal MetersPerUnitOf(IUserUnit unit)
        {
            double perMeter = unit.GetConversionFactor();
            foreach (var exact in new[] { 0.001m, 0.01m, 1m, 0.0254m, 0.3048m, 0.0000254m, 0.000001m })
                if (Math.Abs(perMeter * (double)exact - 1) < 1e-9) return exact;
            return (decimal)(1 / perMeter);
        }

        private static decimal ToUnits(Label label, decimal value, string units)
        {
            decimal meters = value * label.MetersPerUnit;
            return units == "metric" ? meters * 1000m : meters / 0.0254m;
        }

        private static Dictionary<string, string[]> UnitOptions(Label label, int axis)
        {
            var options = new Dictionary<string, string[]>();
            foreach (var units in new[] { "imperial", "metric" })
                options[units] = label.Dimensions == null ? new string[0] : DimensionOptions(ToUnits(label, label.Dimensions[axis], units));
            return options;
        }

        private static string[] DimensionOptions(decimal number)
        {
            return Array.ConvertAll(new[] { 0, 1, 2, 3, 4, 5, 6, 7, 8 }, places => Format(number, places));
        }

        private static string Format(decimal number, int places)
        {
            return Math.Round(number, places, MidpointRounding.AwayFromZero)
                .ToString("F" + places, CultureInfo.InvariantCulture);
        }
    }
}
