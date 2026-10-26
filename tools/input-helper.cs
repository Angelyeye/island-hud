using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

// Real Windows pointer input for the GUI regression suites.
//
// Usage:
//   input-helper.exe cursor            -> prints "<x>,<y>" in pixels
//   input-helper.exe probe             -> exit 0 when this session accepts input
//   input-helper.exe move <x> <y>      -> moves the pointer
//   input-helper.exe click <x> <y>     -> moves, jiggles and left-clicks
//
// The suites used to compile this through PowerShell Add-Type on every click,
// which fails on hosts that deny the C# compiler to a nested PowerShell
// process. Input goes through SendInput rather than SetCursorPos: hardened
// sessions can refuse SetCursorPos while still accepting synthesized input.
internal static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    private const uint INPUT_MOUSE = 0;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    private static void Pause(int milliseconds)
    {
        Thread.Sleep(milliseconds);
    }

    private static INPUT MouseEvent(uint flags, int dx, int dy)
    {
        var input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dx = dx;
        input.u.mi.dy = dy;
        input.u.mi.mouseData = 0;
        input.u.mi.dwFlags = flags;
        input.u.mi.time = 0;
        input.u.mi.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    private static bool Send(INPUT[] inputs)
    {
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == inputs.Length;
    }

    /** Absolute move: SendInput expects 0..65535 across the virtual screen. */
    private static bool MoveTo(int x, int y)
    {
        int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (width <= 1) width = 2;
        if (height <= 1) height = 2;
        int dx = (int)Math.Round((x - left) * 65535.0 / (width - 1));
        int dy = (int)Math.Round((y - top) * 65535.0 / (height - 1));
        return Send(new[] { MouseEvent(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, dx, dy) });
    }

    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "cursor")
        {
            POINT point;
            if (!GetCursorPos(out point))
            {
                Console.Error.WriteLine("GetCursorPos failed: " + Marshal.GetLastWin32Error());
                return 1;
            }
            Console.Write(point.X.ToString(CultureInfo.InvariantCulture) + "," + point.Y.ToString(CultureInfo.InvariantCulture));
            return 0;
        }
        if (args.Length == 1 && args[0] == "probe")
        {
            // Requesting input is not the same as receiving it: hardened sessions
            // accept SendInput yet discard the event. Move by a measurable offset,
            // read the pointer back, then restore it.
            POINT start;
            if (!GetCursorPos(out start))
            {
                Console.Error.WriteLine("GetCursorPos failed: " + Marshal.GetLastWin32Error());
                return 1;
            }
            int width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            int targetX = 40, targetY = 40;
            if (width < 200) targetX = Math.Max(0, width / 2);
            if (height < 200) targetY = Math.Max(0, height / 2);
            MoveTo(targetX, targetY);
            Pause(180);
            POINT moved;
            GetCursorPos(out moved);
            MoveTo(start.X, start.Y);
            Pause(80);
            // Compare against the requested absolute position: a user moving the
            // pointer during the probe cannot make this look successful.
            if (Math.Abs(moved.X - targetX) > 8 || Math.Abs(moved.Y - targetY) > 8)
            {
                Console.Error.WriteLine("pointer did not reach the requested position: synthesized input discarded");
                return 1;
            }
            return 0;
        }
        if (args.Length == 3 && (args[0] == "move" || args[0] == "click"))
        {
            int x, y;
            if (!int.TryParse(args[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out x) ||
                !int.TryParse(args[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out y))
            {
                Console.Error.WriteLine("usage: input-helper.exe <move|click> <x> <y>");
                return 2;
            }
            if (!MoveTo(x, y))
            {
                Console.Error.WriteLine("SendInput move denied: " + Marshal.GetLastWin32Error());
                return 1;
            }
            if (args[0] == "move")
            {
                return 0;
            }
            // A short horizontal jiggle proves the move reached the window before
            // the click, matching the previous PowerShell sequence.
            Pause(120);
            MoveTo(x - 18, y);
            Pause(80);
            MoveTo(x, y);
            Pause(120);
            bool pressed = Send(new[] { MouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0) });
            Pause(60);
            bool released = Send(new[] { MouseEvent(MOUSEEVENTF_LEFTUP, 0, 0) });
            if (!pressed || !released)
            {
                Console.Error.WriteLine("SendInput click denied: " + Marshal.GetLastWin32Error());
                return 1;
            }
            return 0;
        }
        Console.Error.WriteLine("usage: input-helper.exe <cursor|probe|move|click> ...");
        return 2;
    }
}
