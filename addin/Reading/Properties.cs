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
    // Reading cut-list item properties.
    public sealed partial class AddIn
    {
        private static string ReadText(ICustomPropertyManager manager, string property)
        {
            return (Read(manager, property) ?? "").Trim();
        }

        // The cut-list item's material, or "" when none is assigned.
        private static string ReadMaterial(ICustomPropertyManager manager)
        {
            string material = ReadText(manager, "MATERIAL");
            return material.StartsWith("<", StringComparison.Ordinal) || material.IndexOf("not specified", StringComparison.OrdinalIgnoreCase) >= 0
                ? "" : material;
        }

        private static string ReadGauge(ICustomPropertyManager manager)
        {
            var gauge = (Read(manager, "Sheet Metal Gauge") ?? "").Trim();
            return gauge.Length == 0 || gauge.IndexOf("not specified", StringComparison.OrdinalIgnoreCase) >= 0 ||
                gauge.StartsWith("<", StringComparison.Ordinal) ? "" :
                Regex.Replace(gauge, @"^(?:GA(?:UGE)?[\s:#-]*)?(\d+(?:[.,]\d+)?)[\s-]*(?:GA(?:UGE)?\.?)?$", "$1 GA", RegexOptions.IgnoreCase);
        }

        // A property's expression, as typed (Read gives its evaluated value). Null if it isn't there.
        private static string Expression(ICustomPropertyManager manager, string name)
        {
            string expression, evaluated;
            bool resolved, linked;
            return manager.Get6(name, false, out expression, out evaluated, out resolved, out linked) ==
                (int)swCustomInfoGetResult_e.swCustomInfoGetResult_NotPresent ? null : expression;
        }

        private static string Read(ICustomPropertyManager manager, string name)
        {
            string expression, evaluated;
            bool resolved, linked;
            manager.Get6(name, false, out expression, out evaluated, out resolved, out linked);
            return evaluated;
        }

        private static FieldLocks ReadLocks(ICustomPropertyManager manager)
        {
            string value = Read(manager, "CutListLabelerLocks") ?? "";
            return new FieldLocks { Description = value.Contains("D"), Length = value.Contains("L") };
        }

        private static decimal Dimension(string value, string name, string field)
        {
            decimal number;
            if ((!Decimal.TryParse(value, NumberStyles.Float, CultureInfo.CurrentCulture, out number) &&
                 !Decimal.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number)) || number <= 0)
                throw new InvalidOperationException(name + ": " + field + " is missing or is not a positive number.");
            return number;
        }
    }
}
