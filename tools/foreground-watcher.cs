using System;
using System.Runtime.InteropServices;
using System.Threading;

// Prints "1" when the foreground window covers its monitor completely,
// "0" otherwise. Used by Island HUD to auto-hide while a fullscreen app
// (video/game/slides) is in the foreground.
//
// Test mode: pipe-host-style explicit handle check:
//   foreground-watcher.exe --test-hwnd 0x00123456
internal static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);

    private static bool IsFullscreen(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) return false;
        IntPtr monitor = MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
        var info = new MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(monitor, ref info)) return false;
        // Allow a few pixels of slack for borderless windows.
        return rect.Left <= info.rcMonitor.Left + 2
            && rect.Top <= info.rcMonitor.Top + 2
            && rect.Right >= info.rcMonitor.Right - 2
            && rect.Bottom >= info.rcMonitor.Bottom - 2;
    }

    private static void Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--test-hwnd")
        {
            string raw = args[1];
            long value;
            if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                value = Convert.ToInt64(raw.Substring(2), 16);
            else
                value = long.Parse(raw);
            Console.WriteLine(IsFullscreen(new IntPtr(value)) ? "1" : "0");
            return;
        }

        bool last = IsFullscreen(GetForegroundWindow());
        Console.WriteLine(last ? "1" : "0");
        Console.Out.Flush();
        while (true)
        {
            Thread.Sleep(400);
            bool current = IsFullscreen(GetForegroundWindow());
            if (current != last)
            {
                last = current;
                Console.WriteLine(current ? "1" : "0");
                Console.Out.Flush();
            }
        }
    }
}
