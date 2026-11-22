using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SheetMetalCutList
{
    public sealed partial class AddIn
    {
        // Runs `work` with the part showing the configuration the window displays, then switches SolidWorks back
        // to the configuration it had active, so reading or labeling another configuration leaves the model as it was.
        // A shown configuration that was deleted or renamed falls back to the active one.
        private static T InShownConfiguration<T>(Session current, Func<T> work)
        {
            string active = ActiveConfiguration(current.Part);
            current.SolidWorksConfiguration = active;
            if (String.IsNullOrEmpty(current.Configuration) || !ConfigurationNames(current.Part).Contains(current.Configuration))
                current.Configuration = active;
            string shown = current.Configuration;
            if (shown == active) return work();
            if (!Activate(current.Part, shown))
                throw new InvalidOperationException("SolidWorks couldn't switch " + current.PartTitle + " to configuration " + shown +
                    " to read it. Its cut list was not changed.");
            try { return work(); }
            finally { SwitchBack(current, current.Part, active); }
        }

        // Switches `part` back to the configuration it was on. If SolidWorks refuses (twice), the reply says so,
        // so the part is never left on another configuration without the user knowing.
        private static void SwitchBack(Session current, IModelDoc2 part, string configuration)
        {
            if (String.IsNullOrEmpty(configuration) || Activate(part, configuration) || Activate(part, configuration)) return;
            string title;
            try { title = part.GetTitle(); } catch (COMException) { title = "A part"; }
            current.Warnings.Add(title + " was left on configuration " + ActiveConfiguration(part) + " because SolidWorks wouldn't switch it back to " +
                configuration + ". Switch it back in SolidWorks.");
        }

        // "PART [Configuration]" when the part has several configurations, for messages.
        private static string ShownName(Session current)
        {
            return ConfigurationNames(current.Part).Count > 1 && current.Configuration.Length > 0
                ? current.PartTitle + " [" + current.Configuration + "]" : current.PartTitle;
        }

        private static string ActiveConfiguration(IModelDoc2 part)
        {
            if (part == null) return "";
            try
            {
                var configuration = part.GetActiveConfiguration() as IConfiguration;
                return configuration == null ? "" : configuration.Name ?? "";
            }
            catch (COMException) { return ""; }
        }

        private static List<string> ConfigurationNames(IModelDoc2 part)
        {
            var names = new List<string>();
            if (part == null) return names;
            try
            {
                var raw = part.GetConfigurationNames() as Array;
                if (raw != null) foreach (var name in raw) if (name != null) names.Add(name.ToString());
            }
            catch (COMException) { }
            return names;
        }

        // Makes `configuration` the active one. True if it already was or the switch worked.
        private static bool Activate(IModelDoc2 part, string configuration)
        {
            if (String.IsNullOrEmpty(configuration) || configuration == ActiveConfiguration(part)) return true;
            try { return part.ShowConfiguration2(configuration) && ActiveConfiguration(part) == configuration; }
            catch (COMException) { return false; }
        }
    }
}
