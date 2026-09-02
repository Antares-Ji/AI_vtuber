# Windows native input control for the Arknights client.
param([string]$action, [int]$x = 0, [int]$y = 0, [int]$w = 0, [int]$h = 0, [string]$out = "")

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mouse;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type;
    public INPUTUNION data;
  }
  public static uint SendAbsoluteMouseMove(int x, int y) {
    int virtualX = GetSystemMetrics(76);
    int virtualY = GetSystemMetrics(77);
    int virtualWidth = GetSystemMetrics(78);
    int virtualHeight = GetSystemMetrics(79);
    if (virtualWidth <= 1 || virtualHeight <= 1) return 0;
    int absoluteX = (int)Math.Round(((x - virtualX) * 65535.0) / (virtualWidth - 1));
    int absoluteY = (int)Math.Round(((y - virtualY) * 65535.0) / (virtualHeight - 1));
    INPUT input = new INPUT {
      type = 0,
      data = new INPUTUNION {
        mouse = new MOUSEINPUT { dx = absoluteX, dy = absoluteY, dwFlags = 0xC001 }
      }
    };
    return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint SendLeftClick() {
    INPUT down = new INPUT {
      type = 0,
      data = new INPUTUNION { mouse = new MOUSEINPUT { dwFlags = 0x0002 } }
    };
    INPUT up = new INPUT {
      type = 0,
      data = new INPUTUNION { mouse = new MOUSEINPUT { dwFlags = 0x0004 } }
    };
    return SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint SendMouseButton(uint flags) {
    INPUT input = new INPUT {
      type = 0,
      data = new INPUTUNION { mouse = new MOUSEINPUT { dwFlags = flags } }
    };
    return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@

# Keep GetWindowRect, ClientToScreen, GetCursorPos and absolute mouse input in
# the same physical-pixel coordinate system on scaled/high-DPI displays.
[WinInput]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null

function Get-ArknightsHandle {
  $process = Get-Process -Name "Arknights" -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if (-not $process) { return [IntPtr]::Zero }
  return [IntPtr]$process.MainWindowHandle
}

function Get-ArknightsInfo {
  $handle = Get-ArknightsHandle
  if ($handle -eq [IntPtr]::Zero) { throw "Arknights window not found" }
  $windowRect = New-Object WinInput+RECT
  $clientRect = New-Object WinInput+RECT
  $clientOrigin = New-Object WinInput+POINT
  if (-not [WinInput]::GetWindowRect($handle, [ref]$windowRect)) { throw "GetWindowRect failed" }
  if (-not [WinInput]::GetClientRect($handle, [ref]$clientRect)) { throw "GetClientRect failed" }
  if (-not [WinInput]::ClientToScreen($handle, [ref]$clientOrigin)) { throw "ClientToScreen failed" }
  return [ordered]@{
    handle = $handle.ToInt64()
    foreground = ([WinInput]::GetForegroundWindow() -eq $handle)
    window = [ordered]@{
      x = $windowRect.left; y = $windowRect.top
      width = $windowRect.right - $windowRect.left
      height = $windowRect.bottom - $windowRect.top
    }
    client = [ordered]@{
      x = $clientOrigin.x; y = $clientOrigin.y
      width = $clientRect.right - $clientRect.left
      height = $clientRect.bottom - $clientRect.top
    }
  }
}

function Set-ArknightsForeground {
  $handle = Get-ArknightsHandle
  if ($handle -eq [IntPtr]::Zero) { throw "Arknights window not found" }
  [WinInput]::ShowWindow($handle, 9) | Out-Null
  if ([WinInput]::GetForegroundWindow() -eq $handle) { return $true }
  [WinInput]::SwitchToThisWindow($handle, $true)
  $currentThread = [WinInput]::GetCurrentThreadId()
  $foregroundHandle = [WinInput]::GetForegroundWindow()
  $foregroundThread = [WinInput]::GetWindowThreadProcessId($foregroundHandle, [IntPtr]::Zero)
  $attached = $false
  try {
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
      $attached = [WinInput]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }
    [WinInput]::BringWindowToTop($handle) | Out-Null
    [WinInput]::SetForegroundWindow($handle) | Out-Null
    [WinInput]::SetFocus($handle) | Out-Null
  } finally {
    if ($attached) {
      [WinInput]::AttachThreadInput($currentThread, $foregroundThread, $false) | Out-Null
    }
  }
  Start-Sleep -Milliseconds 180
  return ([WinInput]::GetForegroundWindow() -eq $handle)
}


function Set-ArknightsTopmost([bool]$enabled) {
  $handle = Get-ArknightsHandle
  if ($handle -eq [IntPtr]::Zero) { throw "Arknights window not found" }
  [WinInput]::ShowWindow($handle, 9) | Out-Null
  $insertAfter = if ($enabled) { [IntPtr](-1) } else { [IntPtr](-2) }
  $flags = [uint32](0x0001 -bor 0x0002 -bor 0x0040)
  if (-not [WinInput]::SetWindowPos($handle, $insertAfter, 0, 0, 0, 0, $flags)) {
    throw "SetWindowPos failed"
  }
  Start-Sleep -Milliseconds 150
  return Get-ArknightsInfo
}


function Move-CursorVerified([int]$targetX, [int]$targetY) {
  $moved = [WinInput]::SetCursorPos($targetX, $targetY)
  if (-not $moved) {
    $sent = [WinInput]::SendAbsoluteMouseMove($targetX, $targetY)
    if ($sent -ne 1) { throw "SendInput mouse move failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  }
  Start-Sleep -Milliseconds 70
  $actual = New-Object WinInput+POINT
  [WinInput]::GetCursorPos([ref]$actual) | Out-Null
  # The Arknights client can nudge the hardware cursor by a few scaled pixels
  # while processing hover state. Keep a small bounded tolerance; the caller
  # still verifies the actual point resolves to the Arknights top-level window.
  if ([Math]::Abs($actual.x - $targetX) -gt 32 -or [Math]::Abs($actual.y - $targetY) -gt 32) {
    throw "cursor did not reach target; requested=$targetX,$targetY actual=$($actual.x),$($actual.y)"
  }
  return $actual
}

try {
  switch ($action) {
    "activate" {
      $activated = Set-ArknightsForeground
      if (-not $activated) { throw "failed to activate Arknights window" }
      Get-ArknightsInfo | ConvertTo-Json -Compress -Depth 4
    }
    "info" {
      Get-ArknightsInfo | ConvertTo-Json -Compress -Depth 4
    }
    "reveal" {
      Set-ArknightsTopmost $true | ConvertTo-Json -Compress -Depth 4
    }
    "unpin" {
      Set-ArknightsTopmost $false | ConvertTo-Json -Compress -Depth 4
    }
    "capture" {
      if ($w -le 0 -or $h -le 0) { throw "capture requires positive width and height" }
      $bitmap = New-Object System.Drawing.Bitmap $w, $h
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
        $bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
      }
      @{ captured = $out; x = $x; y = $y; width = $w; height = $h } | ConvertTo-Json -Compress
    }
    "capturewindow" {
      $info = Get-ArknightsInfo
      $handle = [IntPtr]$info.handle
      $bitmap = New-Object System.Drawing.Bitmap $info.window.width, $info.window.height
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $hdc = $graphics.GetHdc()
      try {
        $success = [WinInput]::PrintWindow($handle, $hdc, 2)
      } finally {
        $graphics.ReleaseHdc($hdc)
        $graphics.Dispose()
      }
      if (-not $success) { $bitmap.Dispose(); throw "PrintWindow failed" }
      try {
        $bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      } finally {
        $bitmap.Dispose()
      }
      @{ captured = $out; width = $info.window.width; height = $info.window.height } | ConvertTo-Json -Compress
    }
    "move" {
      $point = Move-CursorVerified $x $y
      @{ requested = @{ x = $x; y = $y }; actual = @{ x = $point.x; y = $point.y } } | ConvertTo-Json -Compress -Depth 3
    }
    "click" {
      $info = Get-ArknightsInfo
      $handle = [IntPtr]$info.handle
      # A fresh hidden PowerShell child can briefly become the reported foreground
      # window even though Arknights is already visible. Activation is best-effort;
      # the cursor/window hit-test below is the authoritative click target check.
      $foreground = Set-ArknightsForeground
      $point = Move-CursorVerified $x $y
      $windowAtPoint = [WinInput]::WindowFromPoint($point)
      $rootAtPoint = [WinInput]::GetAncestor($windowAtPoint, 2)
      if ($rootAtPoint -ne $handle) {
        throw "refusing click: top-level window at cursor is $($rootAtPoint.ToInt64()), expected Arknights $($handle.ToInt64())"
      }
      $downSent = [WinInput]::SendMouseButton(0x0002)
      Start-Sleep -Milliseconds 90
      $upSent = [WinInput]::SendMouseButton(0x0004)
      $sent = $downSent + $upSent
      if ($downSent -ne 1 -or $upSent -ne 1) { throw "SendInput click failed: down=$downSent up=$upSent error=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
      @{ requested = @{ x = $x; y = $y }; actual = @{ x = $point.x; y = $point.y }; foreground = $foreground; sent = $sent; targetHandle = $handle.ToInt64(); windowAtPoint = $windowAtPoint.ToInt64(); rootAtPoint = $rootAtPoint.ToInt64() } | ConvertTo-Json -Compress -Depth 3
    }
    "clientclick" {
      $info = Get-ArknightsInfo
      if ($x -lt 0 -or $y -lt 0 -or $x -ge $info.client.width -or $y -ge $info.client.height) {
        throw "client click outside Arknights window: $x,$y"
      }
      $handle = [IntPtr]$info.handle
      # Foreground reporting can revert when the short activation helper exits.
      # Continue only if the authoritative cursor hit-test below still resolves
      # to the Arknights top-level window.
      $foreground = Set-ArknightsForeground
      $info = Get-ArknightsInfo
      $screenX = $info.client.x + $x
      $screenY = $info.client.y + $y
      $point = Move-CursorVerified $screenX $screenY
      $windowAtPoint = [WinInput]::WindowFromPoint($point)
      $rootAtPoint = [WinInput]::GetAncestor($windowAtPoint, 2)
      if ($rootAtPoint -ne $handle) {
        throw "refusing click: top-level window at cursor is $($rootAtPoint.ToInt64()), expected Arknights $($handle.ToInt64())"
      }
      $downSent = [WinInput]::SendMouseButton(0x0002)
      Start-Sleep -Milliseconds 90
      $upSent = [WinInput]::SendMouseButton(0x0004)
      $sent = $downSent + $upSent
      if ($downSent -ne 1 -or $upSent -ne 1) { throw "SendInput click failed: down=$downSent up=$upSent error=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
      @{ client = @{ x = $x; y = $y }; screen = @{ x = $screenX; y = $screenY }; actual = @{ x = $point.x; y = $point.y }; foreground = $foreground; sent = $sent; targetHandle = $handle.ToInt64(); rootAtPoint = $rootAtPoint.ToInt64() } | ConvertTo-Json -Compress -Depth 3
    }
    "clientdrag" {
      $info = Get-ArknightsInfo
      if ($x -lt 0 -or $y -lt 0 -or $x -ge $info.client.width -or $y -ge $info.client.height -or
          $w -lt 0 -or $h -lt 0 -or $w -ge $info.client.width -or $h -ge $info.client.height) {
        throw "client drag outside Arknights window: $x,$y -> $w,$h"
      }
      $handle = [IntPtr]$info.handle
      $foreground = Set-ArknightsForeground
      $info = Get-ArknightsInfo
      $startX = $info.client.x + $x
      $startY = $info.client.y + $y
      $endX = $info.client.x + $w
      $endY = $info.client.y + $h
      $start = Move-CursorVerified $startX $startY
      $startRoot = [WinInput]::GetAncestor([WinInput]::WindowFromPoint($start), 2)
      if ($startRoot -ne $handle) { throw "refusing drag: start is outside Arknights" }
      $downSent = [WinInput]::SendMouseButton(0x0002)
      Start-Sleep -Milliseconds 120
      $segments = 12
      for ($i = 1; $i -le $segments; $i++) {
        $nextX = [Math]::Round($startX + (($endX - $startX) * $i / $segments))
        $nextY = [Math]::Round($startY + (($endY - $startY) * $i / $segments))
        [WinInput]::SetCursorPos($nextX, $nextY) | Out-Null
        Start-Sleep -Milliseconds 18
      }
      $end = New-Object WinInput+POINT
      [WinInput]::GetCursorPos([ref]$end) | Out-Null
      $endRoot = [WinInput]::GetAncestor([WinInput]::WindowFromPoint($end), 2)
      if ($endRoot -ne $handle) {
        [WinInput]::SendMouseButton(0x0004) | Out-Null
        throw "refusing drag release: end is outside Arknights"
      }
      $upSent = [WinInput]::SendMouseButton(0x0004)
      if ($downSent -ne 1 -or $upSent -ne 1) { throw "SendInput drag failed: down=$downSent up=$upSent" }
      @{ clientStart = @{ x = $x; y = $y }; clientEnd = @{ x = $w; y = $h }; foreground = $foreground; sent = $downSent + $upSent; targetHandle = $handle.ToInt64(); startRoot = $startRoot.ToInt64(); endRoot = $endRoot.ToInt64() } | ConvertTo-Json -Compress -Depth 3
    }
    "clientmsgclick" {
      $info = Get-ArknightsInfo
      if ($x -lt 0 -or $y -lt 0 -or $x -ge $info.client.width -or $y -ge $info.client.height) {
        throw "client message click outside Arknights window: $x,$y"
      }
      $handle = [IntPtr]$info.handle
      if (-not (Set-ArknightsForeground)) { throw "failed to activate Arknights before atomic message click" }
      $lParam = ($y -shl 16) -bor ($x -band 0xFFFF)
      $moved = [WinInput]::PostMessage($handle, 0x200, [IntPtr]::Zero, [IntPtr]$lParam)
      $down = [WinInput]::PostMessage($handle, 0x201, [IntPtr]1, [IntPtr]$lParam)
      Start-Sleep -Milliseconds 120
      $up = [WinInput]::PostMessage($handle, 0x202, [IntPtr]::Zero, [IntPtr]$lParam)
      if (-not $down -or -not $up) { throw "PostMessage rejected input: move=$moved down=$down up=$up" }
      @{ client = @{ x = $x; y = $y }; moveAccepted = $moved; downAccepted = $down; upAccepted = $up; targetHandle = $handle.ToInt64() } | ConvertTo-Json -Compress -Depth 3
    }
    "msgclick" {
      $info = Get-ArknightsInfo
      $handle = [IntPtr]$info.handle
      $point = New-Object WinInput+POINT
      $point.x = $x; $point.y = $y
      [WinInput]::ScreenToClient($handle, [ref]$point) | Out-Null
      $lParam = ($point.y -shl 16) -bor ($point.x -band 0xFFFF)
      [WinInput]::PostMessage($handle, 0x200, [IntPtr]::Zero, [IntPtr]$lParam) | Out-Null
      [WinInput]::PostMessage($handle, 0x201, [IntPtr]1, [IntPtr]$lParam) | Out-Null
      [WinInput]::PostMessage($handle, 0x202, [IntPtr]::Zero, [IntPtr]$lParam) | Out-Null
      @{ screen = @{ x = $x; y = $y }; client = @{ x = $point.x; y = $point.y } } | ConvertTo-Json -Compress -Depth 3
    }
    "pos" {
      $point = New-Object WinInput+POINT
      if (-not [WinInput]::GetCursorPos([ref]$point)) { throw "GetCursorPos failed" }
      @{ x = $point.x; y = $point.y } | ConvertTo-Json -Compress
    }
    default { throw "unknown action: $action" }
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
