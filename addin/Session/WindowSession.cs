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
        // Posts work from the window's reader thread back to SolidWorks' main thread, where API calls must run.
        private System.Windows.Forms.Control dispatcher;
        private Session session;
        // True while a request from the window is being handled, so the watcher doesn't report the
        // configuration switches that request makes.
        private bool handling;
        // Requests from the window waiting their turn. A request can show a dialog or call Excel, and both keep
        // SolidWorks' message loop running, which would otherwise start the next request in the middle of this one.
        private readonly Queue<KeyValuePair<Session, string>> requests = new Queue<KeyValuePair<Session, string>>();
        private bool draining;

        private const string WebView2Download = "https://developer.microsoft.com/microsoft-edge/webview2/";

        // Microsoft's documented check: the runtime registers a version ("pv") under EdgeUpdate\Clients.
        private static bool HasWebView2()
        {
            const string client = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
            foreach (var path in new[] {
                new { Hive = Registry.LocalMachine, Key = @"SOFTWARE\WOW6432Node\" + client },
                new { Hive = Registry.LocalMachine, Key = @"SOFTWARE\" + client },
                new { Hive = Registry.CurrentUser, Key = @"Software\" + client } })
            {
                using (var key = path.Hive.OpenSubKey(path.Key))
                {
                    var version = key == null ? null : key.GetValue("pv") as string;
                    if (!String.IsNullOrEmpty(version) && version != "0.0.0.0") return true;
                }
            }
            return false;
        }

        // One open settings window, bound to the part it was opened on. The window stays open between actions,
        // and SolidWorks stays responsive because this method returns as soon as the window starts.
        private sealed class Session
        {
            public Process Process;
            public StreamWriter Input;
            public IModelDoc2 Part;
            public string PartTitle;
            // The configuration whose cut list the window shows. It need not be the one active in SolidWorks:
            // requests switch to it, do their work and switch back.
            public string Configuration = "";
            // The configuration SolidWorks had active when the current request started.
            public string SolidWorksConfiguration = "";
            // The number of the request being answered (0 when none), echoed in its reply so the window can tell a
            // late answer to a request it stopped waiting for from the answer it is waiting for.
            public int RequestId;
            // Problems to mention alongside the current request's reply (a part left on the wrong configuration).
            public readonly List<string> Warnings = new List<string>();
            public bool Ended;
            // What the last apply changed, per part, so it can be undone.
            public List<UndoStep> Undo = new List<UndoStep>();
            public readonly StringBuilder Errors = new StringBuilder();

            public void Focus()
            {
                try
                {
                    Process.Refresh();
                    var window = Process.MainWindowHandle;
                    if (window == IntPtr.Zero) return;
                    if (IsIconic(window)) ShowWindow(window, 9);
                    SetForegroundWindow(window);
                }
                catch (Exception) { }
            }
        }

        private static JavaScriptSerializer Serializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
        }

        // `part` is null when the window opens with no part; it then starts with an empty list.
        private void StartSession(IModelDoc2 part, List<Label> labels, string message)
        {
            string directory = Path.GetDirectoryName(typeof(AddIn).Assembly.Location);
            string executable = Path.Combine(directory, "cut-list-settings.exe");
            if (!File.Exists(executable))
                throw new InvalidOperationException("The settings window (cut-list-settings.exe) is missing from " + directory +
                    ". Run Install.cmd again to reinstall the add-in.");

            var serializer = Serializer();
            var loaded = LabelSettings.LoadAll();
            string payload = serializer.Serialize(new {
                version = Version,
                configuration = ActiveConfiguration(part),
                configurations = ConfigurationNames(part).Count,
                configurationNames = ConfigurationNames(part),
                activeConfiguration = ActiveConfiguration(part),
                part = PartKey(part),
                partTitle = part == null ? "" : part.GetTitle(),
                parts = OpenParts(),
                message,
                settings = loaded,
                defaults = LabelSettings.AllDefaults(),
                presets = PresetStore.Load(),
                activePreset = PresetStore.Active(),
                entries = Entries(labels, serializer)
            });

            var start = new ProcessStartInfo(executable) {
                WorkingDirectory = directory,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                StandardOutputEncoding = Encoding.UTF8,
                RedirectStandardError = true,
                StandardErrorEncoding = Encoding.UTF8,
                CreateNoWindow = true
            };
            Process process;
            try { process = Process.Start(start); }
            catch (System.ComponentModel.Win32Exception error)
            {
                throw new InvalidOperationException("Windows would not start the settings window (" + error.Message + ").\n" +
                    "Check that antivirus software is not blocking " + executable + ", then run Install.cmd again.");
            }

            var current = new Session { Process = process, Part = part, PartTitle = part == null ? "" : part.GetTitle(),
                Configuration = ActiveConfiguration(part), SolidWorksConfiguration = ActiveConfiguration(part) };
            process.ErrorDataReceived += (sender, data) => {
                if (!String.IsNullOrWhiteSpace(data.Data)) lock (current.Errors) current.Errors.AppendLine(data.Data.Trim());
            };
            process.BeginErrorReadLine();
            // Use the stream directly so the JSON is UTF-8 without an encoding marker.
            current.Input = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true };
            current.Input.WriteLine(payload);
            session = current;
            StartPartWatcher(current);

            var reader = new System.Threading.Thread(() => {
                try
                {
                    string line;
                    while ((line = process.StandardOutput.ReadLine()) != null)
                    {
                        var text = line;
                        Post(() => Enqueue(current, text));
                    }
                }
                catch (Exception) { }
                // The window has closed its output. Wait for it to exit here, not on SolidWorks' main thread.
                int exitCode = 0;
                try
                {
                    if (process.WaitForExit(5000))
                    {
                        process.WaitForExit();
                        exitCode = process.ExitCode;
                    }
                    else process.Kill();
                }
                catch (Exception) { }
                Post(() => EndSession(current, exitCode));
            }) { IsBackground = true, Name = "Cut-list window reader" };
            reader.Start();
        }

        // Runs requests strictly one after another, on SolidWorks' main thread.
        private void Enqueue(Session current, string line)
        {
            requests.Enqueue(new KeyValuePair<Session, string>(current, line));
            if (draining) return;
            draining = true;
            try
            {
                while (requests.Count > 0)
                {
                    var next = requests.Dequeue();
                    try { Handle(next.Key, next.Value); }
                    catch (Exception) { }
                }
            }
            finally { draining = false; }
        }

        private void Post(Action action)
        {
            var target = dispatcher;
            try { if (target != null && !target.IsDisposed) target.BeginInvoke(action); }
            catch (InvalidOperationException) { }
        }

        private void EndSession(Session current, int exitCode)
        {
            if (current.Ended) return;
            current.Ended = true;
            if (session == current) { session = null; StopPartWatcher(); }
            try { current.Input.Dispose(); } catch (Exception) { }
            current.Process.Dispose();
            if (exitCode != 0 && app != null)
            {
                string detail;
                lock (current.Errors) detail = current.Errors.ToString().Trim();
                string advice = HasWebView2()
                    ? "\nIf this keeps happening, repair the Microsoft Edge WebView2 Runtime from " + WebView2Download + " and run Install.cmd again."
                    : "\nThe Microsoft Edge WebView2 Runtime does not appear to be installed. Install the Evergreen Runtime from " +
                      WebView2Download + ", then run the command again.";
                Show("The settings window closed unexpectedly (exit code " + exitCode + ")." +
                    (detail.Length > 0 ? "\n" + detail : "") + advice, swMessageBoxIcon_e.swMbStop);
            }
        }

        // Answers the request being handled. Its number and any warnings are added to the reply.
        private static void Reply(Session current, object message)
        {
            try
            {
                var serializer = Serializer();
                string json = serializer.Serialize(message);
                var extra = new List<string>();
                if (current.RequestId > 0) extra.Add("\"requestId\":" + current.RequestId.ToString(CultureInfo.InvariantCulture));
                if (current.Warnings.Count > 0) extra.Add("\"warning\":" + serializer.Serialize(String.Join(" ", current.Warnings)));
                if (extra.Count > 0 && json.Length > 2 && json[0] == '{')
                    json = "{" + String.Join(",", extra) + "," + json.Substring(1);
                current.Input.WriteLine(json);
            }
            catch (Exception) { }
        }

        // Tells the window something it didn't ask about (parts opened or closed, the command run on another part).
        private static void Push(Session current, object message)
        {
            try { current.Input.WriteLine(Serializer().Serialize(message)); }
            catch (Exception) { }
        }
    }
}
