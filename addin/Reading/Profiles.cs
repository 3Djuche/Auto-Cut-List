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
    // Weldment profiles: where a member's profile came from, profile libraries, and the default callout.
    public sealed partial class AddIn
    {
        private static ProfileInfo SafeProfile(object[] bodies)
        {
            try { return ReadProfile(bodies); }
            catch (Exception) { return new ProfileInfo(); }
        }

        // Structural members and Structure System members. Their definitions are read by name (late bound),
        // so a SolidWorks version without one of these properties simply yields no profile.
        private static ProfileInfo ReadProfile(object[] bodies)
        {
            foreach (IBody2 body in bodies)
            {
                var features = body.GetFeatures() as object[];
                if (features == null) continue;
                foreach (IFeature feature in features)
                {
                    string type = feature.GetTypeName2();
                    if (type != "WeldMemberFeat" && type != "AdvStructMember") continue;
                    object data = null;
                    try { data = feature.GetDefinition(); } catch (COMException) { }
                    if (data == null) continue;
                    string path = FirstText(data, "WeldmentProfilePath", "ProfilePath", "ProfileFilePath", "ProfileFile");
                    if (path.Length == 0) continue;
                    return DescribeProfile(path, FirstText(data, "ConfigurationName", "ProfileConfiguration", "ProfileConfigurationName"));
                }
            }
            return new ProfileInfo();
        }

        private static string FirstText(object target, params string[] names)
        {
            foreach (var name in names)
            {
                try
                {
                    var value = target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, null) as string;
                    if (!String.IsNullOrWhiteSpace(value)) return value.Trim();
                }
                catch (Exception) { }
            }
            return "";
        }

        // Libraries are laid out as library\standard\shape\size.sldlfp, or library\standard\shape.sldlfp with one
        // configuration per size.
        private static ProfileInfo DescribeProfile(string path, string configuration)
        {
            var info = new ProfileInfo { Path = path, Configuration = configuration ?? "" };
            try
            {
                string file = Path.GetFileNameWithoutExtension(path);
                string folder = Path.GetDirectoryName(path) ?? "";
                bool sizesAsConfigurations = info.Configuration.Length > 0 &&
                    !info.Configuration.Equals("Default", StringComparison.OrdinalIgnoreCase);
                if (sizesAsConfigurations)
                {
                    info.Type = file;
                    info.Size = info.Configuration;
                    info.Standard = Path.GetFileName(folder);
                    info.Library = folder.Length > 0 ? Path.GetDirectoryName(folder) ?? "" : "";
                }
                else
                {
                    info.Size = file;
                    info.Type = Path.GetFileName(folder);
                    string standard = folder.Length > 0 ? Path.GetDirectoryName(folder) ?? "" : "";
                    info.Standard = Path.GetFileName(standard);
                    info.Library = standard.Length > 0 ? Path.GetDirectoryName(standard) ?? "" : "";
                }
            }
            catch (ArgumentException) { }
            return info;
        }

        // Lists the shapes in a profile library the user chose to read: folder names and profile file names only.
        private static object ReadLibrary(string root)
        {
            if (String.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
                throw new InvalidOperationException("The profile library folder " + root + " couldn't be found.");
            var shapes = new List<object>();
            foreach (var standard in Directory.GetDirectories(root))
            {
                string standardName = Path.GetFileName(standard);
                foreach (var shape in Directory.GetDirectories(standard))
                {
                    shapes.Add(new { standard = standardName, type = Path.GetFileName(shape),
                        sizes = Directory.GetFiles(shape, "*.sldlfp").Length });
                    if (shapes.Count >= 1000) break;
                }
                foreach (var file in Directory.GetFiles(standard, "*.sldlfp"))
                {
                    shapes.Add(new { standard = standardName, type = Path.GetFileNameWithoutExtension(file), sizes = 0 });
                    if (shapes.Count >= 1000) break;
                }
                if (shapes.Count >= 1000) break;
            }
            return new { type = "library", path = root, shapes };
        }

        private static string DefaultCallout(ICustomPropertyManager manager, string name, object[] bodies)
        {
            string original = Read(manager, "CutListLabelerOriginalCallout");
            if (!String.IsNullOrWhiteSpace(original)) return original;

            string description = Read(manager, "Description");
            if (!String.IsNullOrWhiteSpace(description) &&
                !Regex.IsMatch(description, @"^(WELDMENT|SOLID) \d+(?:\.\d+)? X \d+(?:\.\d+)?$", RegexOptions.IgnoreCase))
                return description;

            foreach (IBody2 body in bodies)
            {
                var features = body.GetFeatures() as object[];
                if (features == null) continue;
                foreach (IFeature feature in features)
                {
                    if (feature.GetTypeName2() != "WeldMemberFeat") continue;
                    var data = feature.GetDefinition() as IStructuralMemberFeatureData;
                    if (data != null && !String.IsNullOrWhiteSpace(data.WeldmentProfilePath))
                        return Path.GetFileNameWithoutExtension(data.WeldmentProfilePath);
                }
            }
            return Regex.Replace(name, @"<\d+>$", "");
        }
    }
}
