# Kaplya: Windows helper process.
#
# The app talks to Windows through this script: what is playing, system volume,
# Wi-Fi and Bluetooth, light/dark theme, text recognition, full-screen detection.
# It runs under Windows PowerShell 5.1 (ships with every Windows 10 and 11) and
# speaks JSON lines over stdin/stdout:
#
#   request:  {"id":1,"cmd":"media.get","args":{...}}
#   response: {"id":1,"ok":true,"result":...}   or   {"id":1,"ok":false,"error":"..."}
#
# Both directions are pure ASCII (non-ASCII characters travel as \uXXXX), so the
# console code page never matters.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File helper.ps1 -SelfTest
# prints what every read-only command returns on this computer.

param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$script:IsWin = ($env:OS -eq 'Windows_NT')

# ---------------------------------------------------------------- JSON output

$script:NonAscii = New-Object System.Text.RegularExpressions.Regex('[^\x00-\x7F]')
$script:Escaper = [System.Text.RegularExpressions.MatchEvaluator] {
    param($m)
    '\u{0:x4}' -f [int][char]$m.Value
}

function ConvertTo-AsciiJson($obj) {
    $json = ConvertTo-Json -InputObject $obj -Depth 8 -Compress
    return $script:NonAscii.Replace($json, $script:Escaper)
}

function Write-Json($obj) {
    [Console]::Out.WriteLine((ConvertTo-AsciiJson $obj))
    [Console]::Out.Flush()
}

function Get-ErrText($err) {
    $e = $err.Exception
    while ($e -and $e.InnerException) { $e = $e.InnerException }
    if ($e -and $e.Message) { return [string]$e.Message }
    return [string]$err
}

# ---------------------------------------------------------------- WinRT plumbing

$script:WinRtReady = $false

function Initialize-WinRt {
    if ($script:WinRtReady) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
    $script:AsTaskGeneric = @($methods | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    $script:AsTaskAction = @($methods | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
        })[0]
    $script:WinRtReady = $true
}

# A WinRT type by name. The second part only has to be present: the runtime finds
# the type by its namespace.
function Get-WinRtType([string]$name, [string]$assembly) {
    Initialize-WinRt
    return [Type]::GetType("$name, $assembly, ContentType=WindowsRuntime", $true)
}

# Wait for a WinRT IAsyncOperation<T>. Callers that expect a list wrap the call
# in @(...), because PowerShell unrolls collections on return.
function Wait-Op($op, [Type]$resultType, [int]$timeoutMs = 8000) {
    Initialize-WinRt
    $task = $script:AsTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    if (-not $task.Wait($timeoutMs)) { throw 'timeout' }
    return $task.Result
}

function Wait-Action($op, [int]$timeoutMs = 15000) {
    Initialize-WinRt
    $task = $script:AsTaskAction.Invoke($null, @($op))
    if (-not $task.Wait($timeoutMs)) { throw 'timeout' }
}

# ---------------------------------------------------------------- native calls

$script:NativeReady = $false

function Initialize-Native {
    if ($script:NativeReady) { return }
    $src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace Kaplya {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out int count);
    int SetMasterVolumeLevel(float levelDb, Guid context);
    int SetMasterVolumeLevelScalar(float level, Guid context);
    int GetMasterVolumeLevel(out float levelDb);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float levelDb, Guid context);
    int SetChannelVolumeLevelScalar(uint channel, float level, Guid context);
    int GetChannelVolumeLevel(uint channel, out float levelDb);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid context);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object obj);
  }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  public static class Audio {
    static IAudioEndpointVolume Endpoint() {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice device;
      // eRender = 0, eMultimedia = 1
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      // CLSCTX_ALL = 23
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out o));
      return (IAudioEndpointVolume)o;
    }
    public static float GetVolume() {
      float v;
      Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v));
      return v;
    }
    public static void SetVolume(float v) {
      if (v < 0f) v = 0f;
      if (v > 1f) v = 1f;
      Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, Guid.Empty));
    }
    public static bool GetMute() {
      bool m;
      Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m));
      return m;
    }
    public static void SetMute(bool m) {
      Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, Guid.Empty));
    }
  }

  public static class Win {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] public static extern bool LockWorkStation();
    // Grows by one every time anything is copied: a cheap "did the clipboard change?".
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("powrprof.dll")] public static extern bool SetSuspendState(bool hibernate, bool force, bool wakeupEventsDisabled);

    // "1|class|pid" when the foreground window covers its whole monitor exactly
    // (a game, a video or a browser in full-screen mode), otherwise "0|class|pid".
    // A maximised window is not full screen: it either leaves the taskbar visible
    // or sticks out of the monitor by the width of its frame.
    public static string Foreground() {
      IntPtr h = GetForegroundWindow();
      if (h == IntPtr.Zero) return "0||0";
      var sb = new StringBuilder(256);
      GetClassName(h, sb, sb.Capacity);
      string cls = sb.ToString();
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      RECT r;
      if (!GetWindowRect(h, out r)) return "0|" + cls + "|" + pid;
      var mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      // MONITOR_DEFAULTTONEAREST = 2
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return "0|" + cls + "|" + pid;
      bool full = r.Left == mi.rcMonitor.Left && r.Top == mi.rcMonitor.Top &&
                  r.Right == mi.rcMonitor.Right && r.Bottom == mi.rcMonitor.Bottom;
      return (full ? "1|" : "0|") + cls + "|" + pid;
    }

    // Tells running programs that the light/dark setting has changed.
    public static void BroadcastThemeChange() {
      UIntPtr res;
      // HWND_BROADCAST = 0xffff, WM_SETTINGCHANGE = 0x1A, SMTO_ABORTIFHUNG = 2
      SendMessageTimeout((IntPtr)0xffff, 0x1A, UIntPtr.Zero, "ImmersiveColorSet", 2, 300, out res);
    }
  }
}
'@
    Add-Type -TypeDefinition $src -Language CSharp
    $script:NativeReady = $true
}

# ---------------------------------------------------------------- media

$script:MediaMgr = $null

function Get-MediaManager {
    if ($null -eq $script:MediaMgr) {
        $t = Get-WinRtType 'Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager' 'Windows.Media.Control'
        $script:MediaMgr = Wait-Op ($t::RequestAsync()) $t
    }
    return $script:MediaMgr
}

function Get-MediaSession($app) {
    $mgr = Get-MediaManager
    if ($app) {
        foreach ($s in @($mgr.GetSessions())) {
            if ([string]$s.SourceAppUserModelId -eq [string]$app) { return $s }
        }
    }
    return $mgr.GetCurrentSession()
}

function Get-MediaThumb($ref) {
    if ($null -eq $ref) { return $null }
    try {
        $streamT = Get-WinRtType 'Windows.Storage.Streams.IRandomAccessStreamWithContentType' 'Windows.Storage.Streams'
        $stream = Wait-Op ($ref.OpenReadAsync()) $streamT 3000
        $mime = [string]$stream.ContentType
        $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
        $ms = New-Object System.IO.MemoryStream
        $net.CopyTo($ms)
        $bytes = $ms.ToArray()
        $net.Dispose()
        $ms.Dispose()
        if ($bytes.Length -eq 0 -or $bytes.Length -gt 4MB) { return $null }
        if (-not $mime) { $mime = 'image/png' }
        return @{ mime = $mime; data = [Convert]::ToBase64String($bytes) }
    } catch {
        return $null
    }
}

function Get-MediaInfo($s, $have) {
    $propsT = Get-WinRtType 'Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties' 'Windows.Media.Control'
    $p = Wait-Op ($s.TryGetMediaPropertiesAsync()) $propsT 4000
    $info = $s.GetPlaybackInfo()
    $tl = $s.GetTimelineProperties()
    $app = [string]$s.SourceAppUserModelId
    $key = "$app|$($p.Title)|$($p.Artist)|$($p.AlbumTitle)"
    $duration = 0.0
    $position = 0.0
    $updated = 0
    try {
        $duration = [double]($tl.EndTime - $tl.StartTime).TotalSeconds
        $position = [double]$tl.Position.TotalSeconds
        $updated = [long]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
    } catch {}
    $res = @{
        app      = $app
        title    = [string]$p.Title
        artist   = [string]$p.Artist
        album    = [string]$p.AlbumTitle
        status   = [string]$info.PlaybackStatus
        position = $position
        duration = $duration
        updated  = $updated
        now      = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        key      = $key
        canPrev  = $true
        canNext  = $true
        canSeek  = $false
    }
    try {
        $res.canPrev = [bool]$info.Controls.IsPreviousEnabled
        $res.canNext = [bool]$info.Controls.IsNextEnabled
        $res.canSeek = [bool]$info.Controls.IsPlaybackPositionEnabled
    } catch {}
    if ([string]$have -ne $key) { $res.thumb = Get-MediaThumb $p.Thumbnail }
    return $res
}

function Invoke-MediaGet($a) {
    $s = Get-MediaSession $a.app
    if ($null -eq $s) { return $null }
    return Get-MediaInfo $s $a.have
}

function Invoke-MediaSessions($a) {
    $mgr = Get-MediaManager
    $cur = $mgr.GetCurrentSession()
    $curApp = ''
    if ($cur) { $curApp = [string]$cur.SourceAppUserModelId }
    $list = @()
    foreach ($s in @($mgr.GetSessions())) {
        try {
            $i = Get-MediaInfo $s '*'
            $i.Remove('thumb')
            $i.current = ($i.app -eq $curApp)
            $list += $i
        } catch {}
    }
    return @{ sessions = @($list) }
}

function Invoke-MediaCmd($a) {
    $s = Get-MediaSession $a.app
    if ($null -eq $s) { return $false }
    $op = $null
    switch ([string]$a.action) {
        'toggle' { $op = $s.TryTogglePlayPauseAsync() }
        'play' { $op = $s.TryPlayAsync() }
        'pause' { $op = $s.TryPauseAsync() }
        'next' { $op = $s.TrySkipNextAsync() }
        'prev' { $op = $s.TrySkipPreviousAsync() }
        'seek' { $op = $s.TryChangePlaybackPositionAsync([long]([double]$a.position * 10000000)) }
        default { throw "unknown media action: $($a.action)" }
    }
    return [bool](Wait-Op $op ([bool]) 4000)
}

# ---------------------------------------------------------------- volume

function Get-VolumeState {
    try {
        Initialize-Native
        $level = [double][Kaplya.Audio]::GetVolume()
        return @{ available = $true; level = [Math]::Round($level, 3); muted = [bool][Kaplya.Audio]::GetMute() }
    } catch {
        return @{ available = $false; level = 0; muted = $false; error = (Get-ErrText $_) }
    }
}

function Invoke-VolumeSet($a) {
    Initialize-Native
    if ($null -ne $a.level) { [Kaplya.Audio]::SetVolume([float]$a.level) }
    if ($null -ne $a.muted) { [Kaplya.Audio]::SetMute([bool]$a.muted) }
    return Get-VolumeState
}

# ---------------------------------------------------------------- theme, full screen

$script:ThemeKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'

function Get-ThemeDark {
    try {
        $v = (Get-ItemProperty -Path $script:ThemeKey -Name AppsUseLightTheme -ErrorAction Stop).AppsUseLightTheme
        return ($v -eq 0)
    } catch {
        return $false
    }
}

function Invoke-ThemeSet($a) {
    $v = 1
    if ($a.dark) { $v = 0 }
    if (-not (Test-Path $script:ThemeKey)) { New-Item -Path $script:ThemeKey -Force | Out-Null }
    Set-ItemProperty -Path $script:ThemeKey -Name AppsUseLightTheme -Value $v -Type DWord
    Set-ItemProperty -Path $script:ThemeKey -Name SystemUsesLightTheme -Value $v -Type DWord
    try {
        Initialize-Native
        [Kaplya.Win]::BroadcastThemeChange()
    } catch {}
    return @{ dark = (Get-ThemeDark) }
}

# Window classes of the desktop itself: they cover the screen but are not an app.
$script:ShellClasses = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'XamlExplorerHostIslandWindow', 'MultitaskingViewFrame', 'ForegroundStaging')

function Get-Fullscreen($ownPids) {
    try {
        Initialize-Native
        $parts = ([Kaplya.Win]::Foreground()).Split('|')
        if ($parts[0] -ne '1') { return $false }
        if ($script:ShellClasses -contains $parts[1]) { return $false }
        foreach ($p in @($ownPids)) { if ([string]$p -eq $parts[2]) { return $false } }
        return $true
    } catch {
        return $false
    }
}

function Invoke-SysPoll($a) {
    return @{
        fullscreen = (Get-Fullscreen $a.ownPids)
        dark       = (Get-ThemeDark)
        volume     = (Get-VolumeState)
    }
}

# ---------------------------------------------------------------- radios (Wi-Fi, Bluetooth switches)

function Get-RadioList {
    $radioT = Get-WinRtType 'Windows.Devices.Radios.Radio' 'Windows.System.Devices'
    $accessT = Get-WinRtType 'Windows.Devices.Radios.RadioAccessStatus' 'Windows.System.Devices'
    $null = Wait-Op ($radioT::RequestAccessAsync()) $accessT
    $listT = [System.Collections.Generic.IReadOnlyList`1].MakeGenericType($radioT)
    return @(Wait-Op ($radioT::GetRadiosAsync()) $listT)
}

function Invoke-RadioGet($a) {
    $res = @{ wifi = $null; bluetooth = $null }
    foreach ($r in (Get-RadioList)) {
        $kind = [string]$r.Kind
        $on = ([string]$r.State -eq 'On')
        if ($kind -eq 'WiFi') { $res.wifi = $on }
        if ($kind -eq 'Bluetooth') { $res.bluetooth = $on }
    }
    return $res
}

function Invoke-RadioSet($a) {
    $want = 'WiFi'
    if ([string]$a.kind -eq 'bluetooth') { $want = 'Bluetooth' }
    $accessT = Get-WinRtType 'Windows.Devices.Radios.RadioAccessStatus' 'Windows.System.Devices'
    $stateT = Get-WinRtType 'Windows.Devices.Radios.RadioState' 'Windows.System.Devices'
    $state = [Enum]::Parse($stateT, 'Off')
    if ($a.on) { $state = [Enum]::Parse($stateT, 'On') }
    $found = $false
    foreach ($r in (Get-RadioList)) {
        if ([string]$r.Kind -eq $want) {
            $found = $true
            $st = Wait-Op ($r.SetStateAsync($state)) $accessT
            if ([string]$st -ne 'Allowed') { throw "access:$st" }
        }
    }
    if (-not $found) { throw 'no-radio' }
    return Invoke-RadioGet $a
}

# ---------------------------------------------------------------- Wi-Fi networks

function Get-WifiAdapter {
    $adT = Get-WinRtType 'Windows.Devices.WiFi.WiFiAdapter' 'Windows.Devices.WiFi'
    $accT = Get-WinRtType 'Windows.Devices.WiFi.WiFiAccessStatus' 'Windows.Devices.WiFi'
    $acc = Wait-Op ($adT::RequestAccessAsync()) $accT
    $script:WifiAccess = [string]$acc
    if ($script:WifiAccess -ne 'Allowed') { return $null }
    $listT = [System.Collections.Generic.IReadOnlyList`1].MakeGenericType($adT)
    $ads = @(Wait-Op ($adT::FindAllAdaptersAsync()) $listT)
    if ($ads.Count -eq 0) { return $null }
    return $ads[0]
}

function Get-WifiConnectedSsid($ad) {
    try {
        $profT = Get-WinRtType 'Windows.Networking.Connectivity.ConnectionProfile' 'Windows.Networking.Connectivity'
        $prof = Wait-Op ($ad.NetworkAdapter.GetConnectedProfileAsync()) $profT 4000
        if ($prof -and $prof.IsWlanConnectionProfile) {
            return [string]$prof.WlanConnectionProfileDetails.GetConnectedSsid()
        }
    } catch {}
    return $null
}

function Invoke-WifiList($a) {
    $ad = Get-WifiAdapter
    if ($null -eq $ad) {
        # reason "Denied...": Windows does not let this program see Wi-Fi networks
        # (location access is off); "Allowed": there is no Wi-Fi adapter.
        return @{ available = $false; reason = [string]$script:WifiAccess; connected = $null; networks = @() }
    }
    if ($a.scan) {
        try { Wait-Action ($ad.ScanAsync()) 12000 } catch {}
    }
    $connected = Get-WifiConnectedSsid $ad
    $best = @{}
    foreach ($n in @($ad.NetworkReport.AvailableNetworks)) {
        $ssid = [string]$n.Ssid
        if (-not $ssid) { continue }
        $auth = [string]$n.SecuritySettings.NetworkAuthenticationType
        $item = @{
            ssid      = $ssid
            bars      = [int]$n.SignalBars
            rssi      = [double]$n.NetworkRssiInDecibelMilliwatts
            secure    = -not ($auth -eq 'Open80211' -or $auth -eq 'None')
            connected = ($ssid -eq $connected)
        }
        if (-not $best.ContainsKey($ssid) -or $best[$ssid].rssi -lt $item.rssi) { $best[$ssid] = $item }
    }
    $list = @($best.Values | Sort-Object @{ Expression = { [int](-not $_.connected) } }, @{ Expression = { $_.rssi }; Descending = $true })
    return @{ available = $true; connected = $connected; networks = $list }
}

function Invoke-WifiConnect($a) {
    $ad = Get-WifiAdapter
    if ($null -eq $ad) { throw 'no-adapter' }
    $net = $null
    foreach ($n in @($ad.NetworkReport.AvailableNetworks)) {
        if ([string]$n.Ssid -eq [string]$a.ssid) {
            if ($null -eq $net -or $n.NetworkRssiInDecibelMilliwatts -gt $net.NetworkRssiInDecibelMilliwatts) { $net = $n }
        }
    }
    if ($null -eq $net) { throw 'not-found' }
    $kindT = Get-WinRtType 'Windows.Devices.WiFi.WiFiReconnectionKind' 'Windows.Devices.WiFi'
    $resT = Get-WinRtType 'Windows.Devices.WiFi.WiFiConnectionResult' 'Windows.Devices.WiFi'
    $kind = [Enum]::Parse($kindT, 'Automatic')
    if ($a.password) {
        $credT = Get-WinRtType 'Windows.Security.Credentials.PasswordCredential' 'Windows.Security.Credentials'
        $cred = [Activator]::CreateInstance($credT)
        $cred.Password = [string]$a.password
        $op = $ad.ConnectAsync($net, $kind, $cred)
    } else {
        $op = $ad.ConnectAsync($net, $kind)
    }
    $res = Wait-Op $op $resT 30000
    return @{ status = [string]$res.ConnectionStatus }
}

function Invoke-WifiDisconnect($a) {
    $ad = Get-WifiAdapter
    if ($null -eq $ad) { throw 'no-adapter' }
    $ad.Disconnect()
    return $true
}

# ---------------------------------------------------------------- text recognition

function Get-OcrEngine($lang) {
    $engT = Get-WinRtType 'Windows.Media.Ocr.OcrEngine' 'Windows.Foundation'
    $engine = $null
    if ($lang) {
        $langT = Get-WinRtType 'Windows.Globalization.Language' 'Windows.Globalization'
        $engine = $engT::TryCreateFromLanguage([Activator]::CreateInstance($langT, @([string]$lang)))
    }
    if ($null -eq $engine) { $engine = $engT::TryCreateFromUserProfileLanguages() }
    return $engine
}

function Invoke-OcrLangs($a) {
    $engT = Get-WinRtType 'Windows.Media.Ocr.OcrEngine' 'Windows.Foundation'
    $list = @()
    foreach ($l in @($engT::AvailableRecognizerLanguages)) {
        $list += @{ tag = [string]$l.LanguageTag; name = [string]$l.DisplayName }
    }
    return @{ langs = @($list) }
}

function Invoke-Ocr($a) {
    $fileT = Get-WinRtType 'Windows.Storage.StorageFile' 'Windows.Storage'
    $modeT = Get-WinRtType 'Windows.Storage.FileAccessMode' 'Windows.Storage'
    $streamT = Get-WinRtType 'Windows.Storage.Streams.IRandomAccessStream' 'Windows.Storage.Streams'
    $decT = Get-WinRtType 'Windows.Graphics.Imaging.BitmapDecoder' 'Windows.Graphics'
    $bmpT = Get-WinRtType 'Windows.Graphics.Imaging.SoftwareBitmap' 'Windows.Graphics'
    $resT = Get-WinRtType 'Windows.Media.Ocr.OcrResult' 'Windows.Foundation'

    $engine = Get-OcrEngine $a.lang
    if ($null -eq $engine) { throw 'no-ocr-language' }
    $file = Wait-Op ($fileT::GetFileFromPathAsync([string]$a.path)) $fileT
    $stream = Wait-Op ($file.OpenAsync([Enum]::Parse($modeT, 'Read'))) $streamT
    try {
        $dec = Wait-Op ($decT::CreateAsync($stream)) $decT
        $bmp = Wait-Op ($dec.GetSoftwareBitmapAsync()) $bmpT
        $res = Wait-Op ($engine.RecognizeAsync($bmp)) $resT 30000
        $lines = @()
        foreach ($l in @($res.Lines)) { $lines += [string]$l.Text }
        return @{ text = ($lines -join "`n"); lang = [string]$engine.RecognizerLanguage.LanguageTag }
    } finally {
        try { $stream.Dispose() } catch {}
    }
}

# ---------------------------------------------------------------- clipboard, installed apps

function Invoke-ClipSeq($a) {
    Initialize-Native
    return [long][Kaplya.Win]::GetClipboardSequenceNumber()
}

# Everything the Start menu knows, including Store apps that have no shortcut file.
function Invoke-AppsList($a) {
    $list = @()
    foreach ($app in @(Get-StartApps)) {
        $list += @{ name = [string]$app.Name; id = [string]$app.AppID }
    }
    return @{ apps = @($list) }
}

# ---------------------------------------------------------------- power

function Invoke-Power($a) {
    switch ([string]$a.action) {
        'lock' {
            Initialize-Native
            return [bool][Kaplya.Win]::LockWorkStation()
        }
        'sleep' {
            Initialize-Native
            return [bool][Kaplya.Win]::SetSuspendState($false, $false, $false)
        }
        'restart' { & "$env:SystemRoot\System32\shutdown.exe" /r /t 0 | Out-Null; return $true }
        'shutdown' { & "$env:SystemRoot\System32\shutdown.exe" /s /t 0 | Out-Null; return $true }
        default { throw "unknown power action: $($a.action)" }
    }
}

# ---------------------------------------------------------------- dispatch

function Invoke-Cmd([string]$cmd, $a) {
    switch ($cmd) {
        'ping' { return @{ pong = $true; windows = $script:IsWin; ps = $PSVersionTable.PSVersion.ToString() } }
        'echo' { return $a }
        'media.get' { return Invoke-MediaGet $a }
        'media.sessions' { return Invoke-MediaSessions $a }
        'media.cmd' { return Invoke-MediaCmd $a }
        'volume.get' { return Get-VolumeState }
        'volume.set' { return Invoke-VolumeSet $a }
        'sys.poll' { return Invoke-SysPoll $a }
        'theme.set' { return Invoke-ThemeSet $a }
        'radio.get' { return Invoke-RadioGet $a }
        'radio.set' { return Invoke-RadioSet $a }
        'wifi.list' { return Invoke-WifiList $a }
        'wifi.connect' { return Invoke-WifiConnect $a }
        'wifi.disconnect' { return Invoke-WifiDisconnect $a }
        'ocr' { return Invoke-Ocr $a }
        'ocr.langs' { return Invoke-OcrLangs $a }
        'power' { return Invoke-Power $a }
        'clip.seq' { return Invoke-ClipSeq $a }
        'apps.list' { return Invoke-AppsList $a }
        default { throw "unknown command: $cmd" }
    }
}

if ($SelfTest) {
    $failed = 0
    foreach ($c in @('ping', 'sys.poll', 'volume.get', 'media.get', 'media.sessions', 'radio.get', 'wifi.list', 'ocr.langs', 'clip.seq', 'apps.list')) {
        try {
            $r = Invoke-Cmd $c (New-Object PSObject)
            [Console]::Out.WriteLine("OK   $c  " + (ConvertTo-AsciiJson @{ result = $r }))
        } catch {
            $failed++
            [Console]::Out.WriteLine("FAIL $c  " + (Get-ErrText $_))
        }
    }
    [Console]::Out.WriteLine("failed: $failed")
    exit 0
}

Write-Json @{ ready = $true; windows = $script:IsWin }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $id = $null
    try {
        $req = ConvertFrom-Json -InputObject $line
        $id = $req.id
        $result = Invoke-Cmd ([string]$req.cmd) $req.args
        Write-Json @{ id = $id; ok = $true; result = $result }
    } catch {
        Write-Json @{ id = $id; ok = $false; error = (Get-ErrText $_) }
    }
}
