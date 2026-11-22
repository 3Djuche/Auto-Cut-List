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
        // While the window is open, keeps its Part list in step with the parts open in SolidWorks.
        private System.Windows.Forms.Timer partWatcher;
        private string lastParts;
        private bool lastPartOpen;
        private string lastConfiguration = "";

        private void StartPartWatcher(Session current)
        {
            StopPartWatcher();
            ResetWatch(current);
            partWatcher = new System.Windows.Forms.Timer { Interval = 1500 };
            partWatcher.Tick += (sender, args) => WatchParts();
            partWatcher.Start();
        }

        private void StopPartWatcher()
        {
            if (partWatcher == null) return;
            partWatcher.Stop();
            partWatcher.Dispose();
            partWatcher = null;
        }

        private void ResetWatch(Session current)
        {
            lastConfiguration = ActiveConfiguration(current.Part);
            lastParts = PartsSnapshot(current, OpenParts(), PartKey(current.Part) + "\n" + lastConfiguration + "\n" +
                String.Join("\n", ConfigurationNames(current.Part)));
            lastPartOpen = current.Part != null && IsOpen(current.Part);
        }

        private static string PartsSnapshot(Session current, List<object> parts, string key)
        {
            return Serializer().Serialize(new { parts, key, current.PartTitle });
        }

        // Runs on SolidWorks' main thread. Tells the window when parts are opened, closed or saved under a new name.
        private void WatchParts()
        {
            var current = session;
            if (current == null || current.Ended || app == null) { StopPartWatcher(); return; }
            if (handling) return;
            try
            {
                var parts = OpenParts();
                bool open = IsOpen(current.Part);
                if (open) current.PartTitle = current.Part.GetTitle();
                string key = open ? PartKey(current.Part) : "";
                string active = open ? ActiveConfiguration(current.Part) : "";
                var names = open ? ConfigurationNames(current.Part) : new List<string>();
                string snapshot = PartsSnapshot(current, parts, key + "\n" + active + "\n" + String.Join("\n", names));
                if (snapshot == lastParts) return;
                bool closedNow = lastPartOpen && !open;
                // The window keeps showing its own configuration when SolidWorks switches; it only needs telling
                // if that configuration was deleted or renamed.
                string gone = open && current.Configuration.Length > 0 && !names.Contains(current.Configuration) ? current.Configuration : null;
                if (gone != null) current.Configuration = active;
                lastParts = snapshot;
                lastPartOpen = open;
                lastConfiguration = active;
                current.SolidWorksConfiguration = active;
                Push(current, new {
                    type = "parts", push = true, parts, part = key, partTitle = current.PartTitle,
                    configuration = open ? current.Configuration : "", configurations = names.Count,
                    configurationNames = names, activeConfiguration = active,
                    message = closedNow ? current.PartTitle + " was closed. Choose an open part from the Part list."
                        : gone != null ? "Configuration " + gone + " is no longer in " + current.PartTitle + ". Showing " + active +
                          " instead; click Refresh to load its cut list." : null
                });
            }
            catch (Exception) { }
        }

        // Parts open in their own SolidWorks windows. Parts loaded only as assembly components are left out.
        private List<object> OpenParts()
        {
            var parts = new List<object>();
            try
            {
                var documents = app.GetDocuments() as object[];
                if (documents == null) return parts;
                foreach (var document in documents)
                {
                    var model = document as IModelDoc2;
                    if (model == null || !(model is IPartDoc) || !model.Visible) continue;
                    parts.Add(new { key = PartKey(model), title = model.GetTitle() });
                }
            }
            catch (COMException) { }
            return parts;
        }

        private List<IModelDoc2> OpenPartDocs()
        {
            var parts = new List<IModelDoc2>();
            var documents = app.GetDocuments() as object[];
            if (documents == null) return parts;
            foreach (var document in documents)
            {
                var model = document as IModelDoc2;
                if (model != null && model is IPartDoc && model.Visible) parts.Add(model);
            }
            return parts;
        }

        private IModelDoc2 FindPart(string key)
        {
            if (String.IsNullOrEmpty(key)) return null;
            var documents = app.GetDocuments() as object[];
            if (documents == null) return null;
            foreach (var document in documents)
            {
                var model = document as IModelDoc2;
                if (model != null && model is IPartDoc && model.Visible && PartKey(model) == key) return model;
            }
            return null;
        }

        // Identifies a document between messages: its file path, or its title if it has never been saved.
        private static string PartKey(IModelDoc2 model)
        {
            if (model == null) return "";
            try
            {
                string path = model.GetPathName();
                return String.IsNullOrEmpty(path) ? "title:" + model.GetTitle() : path;
            }
            catch (COMException) { return ""; }
        }

        private bool IsOpen(IModelDoc2 part)
        {
            if (part == null) return false;
            try
            {
                var documents = app.GetDocuments() as object[];
                return documents != null && Array.Exists(documents, document => ReferenceEquals(document, part));
            }
            catch (COMException) { return false; }
        }
    }
}
