using System;
using System.Runtime.InteropServices;

namespace SheetMetalCutList
{
    // Win32 calls the add-in makes to bring the settings window forward and to parent its dialogs.
    public sealed partial class AddIn
    {
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);

        private sealed class OwnerWindow : System.Windows.Forms.IWin32Window
        {
            public OwnerWindow(IntPtr handle) { Handle = handle; }
            public IntPtr Handle { get; private set; }
        }
    }
}
