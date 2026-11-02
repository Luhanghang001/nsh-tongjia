# Run the collector on a separate Win32 desktop. Never switch the user's desktop.
function Invoke-TongjiaIsolatedDesktop {
    param([Parameter(Mandatory)][string]$LogPath, [int]$TimeoutSeconds = 540)
    if (-not ('TongjiaDesktop' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class TongjiaDesktop {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb;
        public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
        public ushort showWindow, reservedSize;
        public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
    public class Result {
        public int ExitCode;
        public string Desktop;
        public uint Pid;
        public int MaxPrivateWindows;
    }
    delegate bool EnumWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr attributes);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindow callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    public static Result Run(string executable, string command, string directory, int timeoutSeconds) {
        string name = "NSHTongjia-" + Guid.NewGuid().ToString("N");
        // Desktop rights only; keep the inherited window-station security descriptor.
        IntPtr desktop = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, 0x1ff, IntPtr.Zero);
        if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        PROCESS_INFORMATION info = new PROCESS_INFORMATION();
        try {
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf<STARTUPINFO>();
            startup.desktop = "WinSta0\\" + name;
            // CREATE_NO_WINDOW hides the PowerShell console; GUI children use our private desktop.
            if (!CreateProcessW(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                false, 0x08000000, IntPtr.Zero, directory, ref startup, out info))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            Result result = new Result { Desktop = name, Pid = info.pid };
            Stopwatch elapsed = Stopwatch.StartNew();
            while (true) {
                uint wait = WaitForSingleObject(info.process, 500);
                int visible = 0;
                EnumDesktopWindows(desktop, (window, data) => {
                    if (IsWindowVisible(window)) visible++;
                    return true;
                }, IntPtr.Zero);
                result.MaxPrivateWindows = Math.Max(result.MaxPrivateWindows, visible);
                if (wait == 0) break;
                if (wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (elapsed.Elapsed.TotalSeconds >= timeoutSeconds)
                    throw new TimeoutException("Silent collector exceeded its time limit.");
            }
            uint exitCode;
            if (!GetExitCodeProcess(info.process, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
            result.ExitCode = unchecked((int)exitCode);
            return result;
        } finally {
            if (info.process != IntPtr.Zero) {
                // On timeout/error, stop only this worker and its own descendants.
                if (WaitForSingleObject(info.process, 0) == 258) {
                    try { Process.GetProcessById((int)info.pid).Kill(true); }
                    catch (ArgumentException) { }
                    WaitForSingleObject(info.process, 5000);
                }
                CloseHandle(info.process);
            }
            if (info.thread != IntPtr.Zero) CloseHandle(info.thread);
            CloseDesktop(desktop);
        }
    }
}
'@
    }
    $shell = Join-Path $PSHOME 'pwsh.exe'
    $worker = Join-Path $PSScriptRoot 'collect-worker.ps1'
    $root = Split-Path -Parent $PSScriptRoot
    $command = '"' + $shell + '" -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $worker + '" -LogPath "' + $LogPath + '"'
    $result = [TongjiaDesktop]::Run($shell, $command, $root, $TimeoutSeconds)
    Write-Host ("[silent] desktop={0} workerPid={1} privateWindows={2} exit={3}" -f $result.Desktop, $result.Pid, $result.MaxPrivateWindows, $result.ExitCode)
    return $result.ExitCode
}
