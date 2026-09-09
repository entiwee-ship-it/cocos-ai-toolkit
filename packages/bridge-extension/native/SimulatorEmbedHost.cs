using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class SimulatorEmbedHost
{
    private const int GwlStyle = -16;
    private const int GwlExStyle = -20;
    private const long WsChild = 0x40000000L;
    private const long WsPopup = unchecked((long)0x80000000L);
    private const long WsVisible = 0x10000000L;
    private const long WsCaption = 0x00C00000L;
    private const long WsThickFrame = 0x00040000L;
    private const long WsSysMenu = 0x00080000L;
    private const long WsMinimizeBox = 0x00020000L;
    private const long WsMaximizeBox = 0x00010000L;
    private const long WsClipSiblings = 0x04000000L;
    private const long WsClipChildren = 0x02000000L;
    private const long WsExDlgModalFrame = 0x00000001L;
    private const long WsExWindowEdge = 0x00000100L;
    private const long WsExClientEdge = 0x00000200L;
    private const long WsExAppWindow = 0x00040000L;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpFrameChanged = 0x0020;
    private const uint SwpShowWindow = 0x0040;
    private const uint SwpAsyncWindowPos = 0x4000;
    private const uint Th32csSnapProcess = 0x00000002;

    private static IntPtr parentWindow;
    private static IntPtr simulatorWindow;
    private static IntPtr originalParent;
    private static IntPtr originalStyle;
    private static IntPtr originalExStyle;
    private static Rect originalRect;
    private static int simulatorProcessId;
    private static bool attached;

    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr state);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExeFile;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsCallback callback, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    private static extern int GetWindowLong32(IntPtr window, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
    private static extern int SetWindowLong32(IntPtr window, int index, int value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetClientRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr window,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("kernel32.dll")]
    private static extern void SetLastError(uint errorCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 9) throw new InvalidOperationException("EXPECTED_9_ARGUMENTS");
            TryEnablePerMonitorDpi();
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = new UTF8Encoding(false);

            int parentProcessId = ParseInt(args[0]);
            int requestedSimulatorProcessId = ParseNonNegativeInt(args[1]);
            string[] parentTitles = Encoding.UTF8.GetString(Convert.FromBase64String(args[2])).Split('\n');
            parentWindow = WaitForWindow(0, parentTitles, 10000);
            simulatorWindow = WaitForSimulatorWindow(requestedSimulatorProcessId, parentProcessId, 10000);
            Attach();
            UpdateBounds(ParseBounds(args, 3));
            WriteLine("READY|" + parentWindow.ToInt64() + "|" + simulatorWindow.ToInt64() + "|" + simulatorProcessId);

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line == "DETACH")
                {
                    Detach();
                    WriteLine("DETACHED");
                    continue;
                }
                if (line == "EXIT") break;
                if (line.StartsWith("BOUNDS|", StringComparison.Ordinal))
                {
                    string[] parts = line.Split('|');
                    if (parts.Length != 7) throw new InvalidOperationException("INVALID_BOUNDS_COMMAND");
                    UpdateBounds(ParseBounds(parts, 1));
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("ERROR|" + error.Message.Replace('\r', ' ').Replace('\n', ' '));
            return 1;
        }
        finally
        {
            try { Detach(); } catch { }
        }
    }

    private static void Attach()
    {
        originalParent = GetParent(simulatorWindow);
        originalStyle = GetWindowLongPtr(simulatorWindow, GwlStyle);
        originalExStyle = GetWindowLongPtr(simulatorWindow, GwlExStyle);
        if (!GetWindowRect(simulatorWindow, out originalRect)) ThrowLastError("GET_WINDOW_RECT_FAILED");
        attached = true;
        try
        {
            // SDL 渲染窗口保持顶层语义，由 Win32 父窗口关系同步位置与生命周期。
            long style = originalStyle.ToInt64();
            style &= ~(WsChild | WsCaption | WsThickFrame | WsSysMenu | WsMinimizeBox | WsMaximizeBox | WsClipChildren);
            style |= WsPopup | WsVisible | WsClipSiblings;
            long exStyle = originalExStyle.ToInt64();
            exStyle &= ~(WsExDlgModalFrame | WsExWindowEdge | WsExClientEdge | WsExAppWindow);
            SetWindowLongPtrChecked(simulatorWindow, GwlStyle, new IntPtr(style));
            SetWindowLongPtrChecked(simulatorWindow, GwlExStyle, new IntPtr(exStyle));
            SetParentChecked(simulatorWindow, parentWindow);
        }
        catch
        {
            Detach();
            throw;
        }
    }

    private static void UpdateBounds(double[] bounds)
    {
        if (!attached || !IsWindow(parentWindow) || !IsWindow(simulatorWindow)) {
            throw new InvalidOperationException("EMBED_WINDOW_LOST");
        }
        Rect client;
        if (!GetClientRect(parentWindow, out client)) ThrowLastError("GET_PARENT_CLIENT_RECT_FAILED");
        double scaleX = (client.Right - client.Left) / bounds[4];
        double scaleY = (client.Bottom - client.Top) / bounds[5];
        int x = (int)Math.Round(bounds[0] * scaleX);
        int y = (int)Math.Round(bounds[1] * scaleY);
        int width = Math.Max(1, (int)Math.Round(bounds[2] * scaleX));
        int height = Math.Max(1, (int)Math.Round(bounds[3] * scaleY));
        if (!SetWindowPos(
            simulatorWindow,
            IntPtr.Zero,
            x,
            y,
            width,
            height,
            SwpNoActivate | SwpFrameChanged | SwpShowWindow | SwpAsyncWindowPos
        )) ThrowLastError("SET_WINDOW_POS_FAILED");
    }

    private static void Detach()
    {
        if (!attached) return;
        attached = false;
        if (!IsWindow(simulatorWindow)) return;
        SetParentChecked(simulatorWindow, originalParent);
        SetWindowLongPtrChecked(simulatorWindow, GwlStyle, originalStyle);
        SetWindowLongPtrChecked(simulatorWindow, GwlExStyle, originalExStyle);
        int width = Math.Max(1, originalRect.Right - originalRect.Left);
        int height = Math.Max(1, originalRect.Bottom - originalRect.Top);
        SetWindowPos(
            simulatorWindow,
            IntPtr.Zero,
            originalRect.Left,
            originalRect.Top,
            width,
            height,
            SwpNoZOrder | SwpFrameChanged | SwpShowWindow | SwpAsyncWindowPos
        );
    }

    private static IntPtr WaitForWindow(int processId, string[] titleCandidates, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        do
        {
            IntPtr found = FindWindow(processId, titleCandidates);
            if (found != IntPtr.Zero) return found;
            Thread.Sleep(50);
        } while (DateTime.UtcNow < deadline);
        throw new InvalidOperationException("WINDOW_NOT_FOUND:" + processId);
    }

    private static IntPtr FindWindow(int processId, string[] titleCandidates)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr state)
        {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if ((processId > 0 && owner != processId) || !IsWindowVisible(window)) return true;
            string title = ReadWindowTitle(window);
            for (int index = 0; index < titleCandidates.Length; index += 1)
            {
                string candidate = titleCandidates[index].Trim();
                if (candidate.Length > 0 && title.IndexOf(candidate, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    found = window;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private static IntPtr WaitForSimulatorWindow(int requestedProcessId, int parentProcessId, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        do
        {
            IntPtr found = FindSimulatorWindow(requestedProcessId, parentProcessId);
            if (found != IntPtr.Zero) return found;
            Thread.Sleep(50);
        } while (DateTime.UtcNow < deadline);
        throw new InvalidOperationException("SIMULATOR_WINDOW_NOT_FOUND:" + requestedProcessId);
    }

    private static IntPtr FindSimulatorWindow(int requestedProcessId, int parentProcessId)
    {
        int targetProcessId = requestedProcessId > 0
            ? requestedProcessId
            : FindSimulatorProcessId(parentProcessId);
        if (targetProcessId <= 0 || !IsSimulatorProcess((uint)targetProcessId, parentProcessId)) return IntPtr.Zero;
        IntPtr found = IntPtr.Zero;
        IntPtr fallback = IntPtr.Zero;
        long fallbackArea = -1;
        Func<IntPtr, bool> consider = delegate(IntPtr window)
        {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != targetProcessId) return false;
            Rect rect;
            long area = GetWindowRect(window, out rect)
                ? Math.Max(0, (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top))
                : 0;
            if (area > fallbackArea)
            {
                fallback = window;
                fallbackArea = area;
            }
            if (ReadWindowTitle(window).IndexOf("Cocos Simulator", StringComparison.OrdinalIgnoreCase) < 0) {
                return false;
            }
            found = window;
            return true;
        };
        EnumWindows(delegate(IntPtr window, IntPtr state)
        {
            if (consider(window)) return false;
            EnumChildWindows(window, delegate(IntPtr child, IntPtr childState)
            {
                return !consider(child);
            }, IntPtr.Zero);
            return found == IntPtr.Zero;
        }, IntPtr.Zero);
        simulatorProcessId = targetProcessId;
        return found != IntPtr.Zero ? found : fallback;
    }

    private static int FindSimulatorProcessId(int parentProcessId)
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
        if (snapshot == new IntPtr(-1)) return 0;
        try
        {
            int found = 0;
            ProcessEntry32 entry = new ProcessEntry32();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
            if (!Process32FirstW(snapshot, ref entry)) return 0;
            do
            {
                if (
                    entry.ParentProcessId == parentProcessId
                    && string.Equals(entry.ExeFile, "SimulatorApp-Win32.exe", StringComparison.OrdinalIgnoreCase)
                ) found = Math.Max(found, (int)entry.ProcessId);
            } while (Process32NextW(snapshot, ref entry));
            return found;
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    private static bool IsSimulatorProcess(uint processId, int parentProcessId)
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
        if (snapshot == new IntPtr(-1)) return false;
        try
        {
            ProcessEntry32 entry = new ProcessEntry32();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
            if (!Process32FirstW(snapshot, ref entry)) return false;
            do
            {
                if (entry.ProcessId == processId) {
                    return entry.ParentProcessId == parentProcessId
                        && string.Equals(entry.ExeFile, "SimulatorApp-Win32.exe", StringComparison.OrdinalIgnoreCase);
                }
            } while (Process32NextW(snapshot, ref entry));
            return false;
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    private static string ReadWindowTitle(IntPtr window)
    {
        int length = GetWindowTextLength(window);
        StringBuilder text = new StringBuilder(Math.Max(1, length + 1));
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    private static double[] ParseBounds(string[] values, int offset)
    {
        double[] result = new double[6];
        for (int index = 0; index < result.Length; index += 1)
        {
            result[index] = double.Parse(values[offset + index], CultureInfo.InvariantCulture);
        }
        if (result[2] <= 0 || result[3] <= 0 || result[4] <= 0 || result[5] <= 0) {
            throw new InvalidOperationException("INVALID_BOUNDS");
        }
        return result;
    }

    private static int ParseInt(string value)
    {
        int parsed;
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) || parsed <= 0) {
            throw new InvalidOperationException("INVALID_PROCESS_ID");
        }
        return parsed;
    }

    private static int ParseNonNegativeInt(string value)
    {
        int parsed;
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) || parsed < 0) {
            throw new InvalidOperationException("INVALID_PROCESS_ID");
        }
        return parsed;
    }

    private static IntPtr GetWindowLongPtr(IntPtr window, int index)
    {
        return IntPtr.Size == 8
            ? GetWindowLongPtr64(window, index)
            : new IntPtr(GetWindowLong32(window, index));
    }

    private static void SetWindowLongPtrChecked(IntPtr window, int index, IntPtr value)
    {
        SetLastError(0);
        IntPtr previous = IntPtr.Size == 8
            ? SetWindowLongPtr64(window, index, value)
            : new IntPtr(SetWindowLong32(window, index, value.ToInt32()));
        int errorCode = Marshal.GetLastWin32Error();
        if (previous == IntPtr.Zero && errorCode != 0) ThrowError("SET_WINDOW_LONG_FAILED", errorCode);
    }

    private static void SetParentChecked(IntPtr window, IntPtr newParent)
    {
        SetLastError(0);
        IntPtr previous = SetParent(window, newParent);
        int errorCode = Marshal.GetLastWin32Error();
        if (previous == IntPtr.Zero && errorCode != 0) ThrowError("SET_PARENT_FAILED", errorCode);
    }

    private static void TryEnablePerMonitorDpi()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    }

    private static void WriteLine(string value)
    {
        Console.WriteLine(value);
        Console.Out.Flush();
    }

    private static void ThrowLastError(string code)
    {
        ThrowError(code, Marshal.GetLastWin32Error());
    }

    private static void ThrowError(string code, int errorCode)
    {
        throw new InvalidOperationException(code + ":" + errorCode);
    }
}
