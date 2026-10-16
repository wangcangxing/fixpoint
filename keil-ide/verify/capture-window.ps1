# Capture the REAL window (native title bar included) with GDI BitBlt from the
# desktop DC. `Page.captureScreenshot` over CDP only renders the page, which is
# why a light Windows title bar stayed invisible to every earlier check.
#
# Usage: pwsh -File verify/capture-window.ps1 [-Match '8051 Studio'] [-Out screenshot-window.png]
param(
  [string]$Match = '8051 Studio',
  [string]$Out = 'screenshot-window.png'
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  // Foreground lock: a background process usually CANNOT bring itself to the front,
  // so SetForegroundWindow alone got the wallpaper instead of the window. Raising it
  // with HWND_TOPMOST works without that permission; we drop it again afterwards.
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  // Without this the process is DPI-virtualised: GetWindowRect returns logical
  // pixels while CopyFromScreen works in physical ones, so the capture is a
  // truncated top-left crop (1440x920 of a 1783x1142 window, measured).
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[WinCap]::SetProcessDPIAware() | Out-Null

$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP = 0x0001 -bor 0x0002 -bor 0x0040   # NOSIZE | NOMOVE | SHOWWINDOW

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Match*" } | Select-Object -First 1
if (-not $proc) { Write-Error "no window matching '$Match'"; exit 1 }

$handle = $proc.MainWindowHandle
[WinCap]::ShowWindow($handle, 9) | Out-Null   # SW_RESTORE
[WinCap]::SetForegroundWindow($handle) | Out-Null
try { (New-Object -ComObject WScript.Shell).AppActivate($proc.Id) | Out-Null } catch { }
# Force it above everything, otherwise the grab can catch the desktop wallpaper.
[WinCap]::SetWindowPos($handle, $HWND_TOPMOST, 0, 0, 0, 0, $SWP) | Out-Null
Start-Sleep -Milliseconds 900

$rect = New-Object WinCap+RECT
[WinCap]::GetWindowRect($handle, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { Write-Error 'window has no size'; exit 1 }

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
$graphics.Dispose()

# Read the title-bar pixel BEFORE disposing, so the check has a number too.
$pixelName = 'n/a'
try { $pixelName = $bitmap.GetPixel([int]($width / 2), 8).Name } catch { $pixelName = "unreadable: $($_.Exception.Message)" }

# `-Out` may be absolute or relative; Join-Path would mangle an absolute one
# (it produced "D:\program\D:\program\..." and the Save failed).
$target = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location).Path $Out }
$bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
# Put the window back to normal stacking order.
[WinCap]::SetWindowPos($handle, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP) | Out-Null

Write-Output ("saved {0}  ({1}x{2})  window='{3}'  titlebar-middle-pixel={4}" -f $target, $width, $height, $proc.MainWindowTitle, $pixelName)
