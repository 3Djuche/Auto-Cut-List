using System;
using System.Globalization;
using System.Linq;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Text.RegularExpressions;
using System.Reflection;

using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;
using SolidWorks.Interop.swpublished;

[assembly: ComVisible(false)]
[assembly: AssemblyTitle("Auto Cut List")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace SheetMetalCutList
{
    [Guid("B0B116CE-FAD5-4B33-9DB0-E1ED77E98884")]
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDispatch)]
    public sealed partial class AddIn : ISwAddin
    {
        // Shown in the window. Keep in step with AssemblyVersion above.
        public const string Version = "1.0.0";
        private const int GroupId = 681205;
        private ISldWorks app;
        private ICommandManager commands;

        [ComRegisterFunction]
        public static void Register(Type type)
        {
            using (var key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\SOLIDWORKS\AddIns\" + type.GUID.ToString("B")))
            {
                key.SetValue("", 0, RegistryValueKind.DWord);
                key.SetValue("Title", "Auto Cut List");
                key.SetValue("Description", "Label sheet-metal, weldment and solid-body cut-list items.");
                // Shown next to the add-in in Tools > Add-Ins. The setup program (and Install.ps1) copies the icons before registering.
                string icon = Path.Combine(Path.GetDirectoryName(type.Assembly.Location), "icons", "auto-cut-list_16.png");
                if (File.Exists(icon)) key.SetValue("Icon Path", icon);
            }
        }

        [ComUnregisterFunction]
        public static void Unregister(Type type)
        {
            Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\SOLIDWORKS\AddIns\" + type.GUID.ToString("B"), false);
            Registry.CurrentUser.DeleteSubKeyTree(@"SOFTWARE\SOLIDWORKS\AddInsStartup\" + type.GUID.ToString("B"), false);
        }

        public bool ConnectToSW(object solidWorks, int cookie)
        {
            app = (ISldWorks)solidWorks;
            try
            {
                if (!app.SetAddinCallbackInfo2(0, this, cookie))
                    throw new InvalidOperationException("SolidWorks could not register the add-in callbacks.");
                dispatcher = new System.Windows.Forms.Control();
                if (dispatcher.Handle == IntPtr.Zero)
                    throw new InvalidOperationException("Could not create the add-in's message window.");
                commands = app.GetCommandManager(cookie);
                int error = 0;
                // SolidWorks remembers a command group's layout and, when told to reuse it, rebuilds the menu from that
                // without the command's icon. The group is a single command with nothing worth keeping, so SolidWorks
                // is told to build it fresh on every start, icon included.
                var group = commands.CreateCommandGroup2(GroupId, "Auto Cut List",
                    "Label cut-list items", "Auto Cut List", -1, true, ref error);
                if (group == null)
                    throw new InvalidOperationException("Could not create the command group (" + error + ").");

                // The command's icon, one PNG per size SolidWorks asks for (installed in the icons folder).
                string iconFolder = Path.Combine(Path.GetDirectoryName(typeof(AddIn).Assembly.Location), "icons");
                var icons = new[] { 20, 32, 40, 64, 96, 128 }.Select(size =>
                    Path.Combine(iconFolder, "auto-cut-list_" + size + ".png")).ToArray();
                bool hasIcons = icons.All(File.Exists);
                if (hasIcons)
                {
                    group.IconList = icons;
                    group.MainIconList = icons;
                }

                // SolidWorks only draws a command's icon in its menu when the command group also has a toolbar, so the
                // command is on both. The toolbar is one of SolidWorks' optional toolbars, off unless the user shows it.
                var index = group.AddCommandItem2("Label Cut List", -1,
                    "Set label templates and apply them to the active cut list",
                    "Label Cut List", hasIcons ? 0 : -1, "LabelCutList", "CanLabel", 1,
                    (int)(swCommandItemType_e.swMenuItem | swCommandItemType_e.swToolbarItem));
                group.HasMenu = true;
                group.HasToolbar = true;
                if (index < 0 || !group.Activate())
                    throw new InvalidOperationException("Could not activate the cut-list command.");
                try { AttachEvents(); } catch (Exception) { }
                return true;
            }
            catch (Exception error)
            {
                Show(error.Message, swMessageBoxIcon_e.swMbStop);
                DisconnectFromSW();
                return false;
            }
        }

        public bool DisconnectFromSW()
        {
            if (session != null)
            {
                try { if (!session.Process.HasExited) session.Process.Kill(); } catch (Exception) { }
                session = null;
            }
            StopPartWatcher();
            try { DetachEvents(); } catch (Exception) { }
            if (dispatcher != null) { dispatcher.Dispose(); dispatcher = null; }
            if (commands != null) commands.RemoveCommandGroup(GroupId);
            commands = null;
            app = null;
            return true;
        }

        // The window opens with or without a part: with none open, it starts empty and Refresh loads one later.
        public int CanLabel()
        {
            return app != null ? 1 : 0;
        }

        public void LabelCutList()
        {
            try
            {
                var part = app.ActiveDoc as IModelDoc2;
                if (session != null && !session.Ended)
                {
                    session.Focus();
                    if (part is IPartDoc && !ReferenceEquals(part, session.Part))
                        Push(session, new {
                            type = "parts", push = true, parts = OpenParts(), part = PartKey(session.Part),
                            suggest = PartKey(part), suggestTitle = part.GetTitle()
                        });
                    return;
                }
                if (!(part is IPartDoc))
                {
                    StartSession(null, new List<Label>(), OpenParts().Count == 0
                        ? "No parts are open. Open a part in SolidWorks, then click Refresh to load its cut list."
                        : "Choose a part from the Part list, or click Refresh to load the active part.");
                    return;
                }

                var labels = ReadLabels(part);
                StartSession(part, labels, labels.Count == 0
                    ? "No populated cut-list entries in " + part.GetTitle() + ". Update its cut list in SolidWorks, then click Refresh." : null);
            }
            catch (Exception error)
            {
                Show(error.Message, swMessageBoxIcon_e.swMbStop);
            }
        }

        private void Show(string message, swMessageBoxIcon_e icon)
        {
            app.SendMsgToUser2(message, (int)icon, (int)swMessageBoxBtn_e.swMbOk);
        }

        private sealed class Label
        {
            public ICustomPropertyManager Manager;
            public string Name;
            // SolidWorks' persistent reference to the item's cut-list folder. Unlike Name, it survives SolidWorks renaming
            // the folder (as it does when the folder's name follows its Description). Null if SolidWorks gave none.
            public byte[] PersistId;
            public string Category;
            public int Index;
            public LabelSettings Custom;
            public FieldLocks Locks;
            public IBody2 Body;
            // Every body in the item, for its fingerprint.
            public object[] Bodies;
            public string Gauge;
            public string Material = "";
            // Weldment end-cut angles, as SolidWorks reports them.
            public string Angle1 = "";
            public string Angle2 = "";
            public string DefaultCallout;
            public string Shape;
            public string DetectedShape;
            public string Type { get { return Category == "sheet" ? "Sheet" : Category == "weldment" ? "Weldment" : "Solid"; } }
            public int Quantity;
            public decimal[] Dimensions;
            // How much SolidWorks rounded each of Dimensions (part units); 0 where the size is exact.
            public decimal[] Rounding = new decimal[3];
            // A round regular part's diameter (part units), 0 for other items; and whether the item is a weldment end cap.
            public decimal Diameter;
            public bool EndCap;
            // Meters per part length unit, to convert Dimensions to inches or millimeters.
            public decimal MetersPerUnit;
            public string LengthSource;
            public string Problem;
            public ProfileInfo Profile = new ProfileInfo();
            // The part's own appearance color, used for bodies that don't have one.
            public double[] PartColor;

            // A fingerprint of everything the labels are built from, in units that don't depend on the document's.
            public string Basis()
            {
                var parts = new List<string> { Category, Quantity.ToString(CultureInfo.InvariantCulture) };
                if (Dimensions == null) parts.Add("unmeasured");
                else foreach (var dimension in Dimensions)
                    parts.Add(Math.Round(dimension * MetersPerUnit, 5).ToString(CultureInfo.InvariantCulture));
                parts.AddRange(new[] { Profile.Size ?? "", Material ?? "", Angle1 ?? "", Angle2 ?? "", Gauge ?? "" });
                return String.Join("|", parts);
            }

            // Whether a stored Basis() still describes this item. Sizes may differ by the rounding SolidWorks applied
            // (one read can be exact and another rounded to the part's decimal places), so they're compared within it.
            public bool MatchesBasis(string stored)
            {
                string current = Basis();
                if (stored == current) return true;
                var was = stored.Split('|');
                var now = current.Split('|');
                if (was.Length != now.Length || Dimensions == null || was.Length != 10) return false;
                for (int i = 0; i < was.Length; i++)
                {
                    if (i < 2 || i > 4) { if (was[i] != now[i]) return false; continue; }
                    decimal before, after;
                    if (!Decimal.TryParse(was[i], NumberStyles.Float, CultureInfo.InvariantCulture, out before) ||
                        !Decimal.TryParse(now[i], NumberStyles.Float, CultureInfo.InvariantCulture, out after)) return false;
                    decimal slack = Math.Max(0.00001m, (Rounding != null ? Rounding[i - 2] : 0) * MetersPerUnit);
                    if (Math.Abs(before - after) > slack + 0.000005m) return false;
                }
                return true;
            }
            public string Description;
            public string Length;
        }
    }
}
