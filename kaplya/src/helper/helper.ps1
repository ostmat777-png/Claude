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
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHDefExtractIcon(string file, int index, uint flags, out IntPtr large, IntPtr small, uint size);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);

    // Icon number `index` of a program, library or .ico file, at the given size.
    // A negative number is a resource identifier, the way shortcuts store it.
    public static IntPtr ExtractIcon(string file, int index, int size) {
      IntPtr h;
      int hr = SHDefExtractIcon(file, index, 0, out h, IntPtr.Zero, (uint)size);
      return hr == 0 ? h : IntPtr.Zero;
    }

    // True when the clipboard carries data in the named format.
    public static bool ClipboardHas(string name) {
      uint f = RegisterClipboardFormat(name);
      return f != 0 && IsClipboardFormatAvailable(f);
    }
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

    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);

    // Milliseconds since the mouse or keyboard was last touched.
    public static long IdleMs() {
      var info = new LASTINPUTINFO();
      info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
      if (!GetLastInputInfo(ref info)) return 0;
      return (long)(unchecked((uint)Environment.TickCount - info.dwTime));
    }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    // "pid|process|title" of every visible window that has a title.
    public static string[] WindowTitles() {
      var list = new System.Collections.Generic.List<string>();
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        if (!IsWindowVisible(h)) return true;
        var sb = new StringBuilder(512);
        if (GetWindowText(h, sb, sb.Capacity) <= 0) return true;
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        string name = "";
        try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
        list.Add(pid + "|" + name + "|" + sb.ToString());
        return true;
      }, IntPtr.Zero);
      return list.ToArray();
    }

    // A press of a media key: play/pause (0xB3), next (0xB0), previous (0xB1).
    public static void MediaKey(byte vk) {
      keybd_event(vk, 0, 1, UIntPtr.Zero);      // KEYEVENTF_EXTENDEDKEY
      keybd_event(vk, 0, 3, UIntPtr.Zero);      // ... | KEYEVENTF_KEYUP
    }

    // "pid|title" of the window in front.
    public static string ForegroundApp() {
      IntPtr h = GetForegroundWindow();
      if (h == IntPtr.Zero) return "0|";
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      return pid + "|" + sb.ToString().Replace("|", " ");
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

function Test-Playing($s) {
    try {
        return ([string]$s.GetPlaybackInfo().PlaybackStatus -eq 'Playing')
    } catch {
        return $false
    }
}

# Which player to show. Windows' own "current" one is often not the one you are
# listening to: a paused music app stays current while a browser plays YouTube,
# and sometimes there is no current one at all. So:
#   1. the player asked for by name ($app), if it is there;
#   2. one that is playing: the one shown last time, else Windows' current, else any;
#   3. nothing plays: the one shown last time ($prefer), else Windows' current, else any.
function Get-MediaSession($app, $prefer) {
    $mgr = Get-MediaManager
    $all = @($mgr.GetSessions())
    $byName = {
        param($name)
        if (-not $name) { return $null }
        foreach ($s in $all) {
            if ([string]$s.SourceAppUserModelId -eq [string]$name) { return $s }
        }
        return $null
    }
    $named = & $byName $app
    if ($named) { return $named }
    $cur = $null
    try { $cur = $mgr.GetCurrentSession() } catch {}
    $last = & $byName $prefer
    if ($last -and (Test-Playing $last)) { return $last }
    if ($cur -and (Test-Playing $cur)) { return $cur }
    foreach ($s in $all) { if (Test-Playing $s) { return $s } }
    if ($last) { return $last }
    if ($cur) { return $cur }
    if ($all.Count -gt 0) { return $all[0] }
    return $null
}

# Browsers that do not tell Windows what they play: the window title of a YouTube
# tab still says it ("Song - YouTube - Google Chrome"). Only the tab in front of
# each browser window can be seen this way.
$script:BrowserExe = @('chrome', 'msedge', 'browser', 'yandex', 'firefox', 'opera', 'opera_gx', 'brave', 'vivaldi', 'arc', 'chromium', 'atom')

function Get-YouTubeWindows {
    Initialize-Native
    $list = @()
    foreach ($line in @([Kaplya.Win]::WindowTitles())) {
        $parts = ([string]$line).Split('|', 3)
        if ($parts.Count -lt 3) { continue }
        $exe = $parts[1].ToLower()
        if ($script:BrowserExe -notcontains $exe) { continue }
        $title = $parts[2]
        if ($title -notmatch 'YouTube') { continue }
        $list += @{ pid = [int]$parts[0]; exe = ($exe + '.exe'); title = $title }
    }
    return @($list)
}

function ConvertFrom-YouTubeTitle($title) {
    # "(3) Song name - YouTube - Google Chrome", "Song name – YouTube Music — Яндекс Браузер"
    $m = [regex]::Match([string]$title, '^(?:\(\d+\)\s*)?(.+?)\s+[-\u2013\u2014]\s+(YouTube(?: Music)?)(?:\s+[-\u2013\u2014]\s+.*)?$')
    if (-not $m.Success) { return $null }
    return @{ title = $m.Groups[1].Value.Trim(); site = $m.Groups[2].Value }
}

function Get-TitleMedia {
    foreach ($w in (Get-YouTubeWindows)) {
        $t = ConvertFrom-YouTubeTitle $w.title
        if ($null -eq $t -or -not $t.title -or $t.title -eq 'YouTube') { continue }
        $now = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        return @{
            app = 'title:' + $w.exe
            title = $t.title
            artist = $t.site
            album = ''
            status = 'Unknown'
            position = 0.0
            duration = 0.0
            updated = $now
            now = $now
            key = 'title:' + $w.exe + '|' + $t.title
            canPrev = $true
            canNext = $true
            canSeek = $false
            fromTitle = $true
        }
    }
    return $null
}

# Why the last cover could not be read: '' when it was, 'none' when the player gave
# no picture at all, otherwise the error text. Shown by -SelfTest.
$script:ThumbNote = ''

# The picture of the current track as bytes. Players hand it over as a WinRT
# stream; two ways of reading it are tried, because each fails with some players.
function Get-MediaThumb($ref) {
    if ($null -eq $ref) {
        $script:ThumbNote = 'none'
        return $null
    }
    $script:ThumbNote = ''
    $bytes = $null
    $mime = ''
    try {
        $streamT = Get-WinRtType 'Windows.Storage.Streams.IRandomAccessStreamWithContentType' 'Windows.Storage.Streams'
        $stream = Wait-Op ($ref.OpenReadAsync()) $streamT 4000
        try {
            $mime = [string]$stream.ContentType
            try {
                $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStream($stream)
                $ms = New-Object System.IO.MemoryStream
                $net.CopyTo($ms)
                $bytes = $ms.ToArray()
                $ms.Dispose()
            } catch {
                $script:ThumbNote = 'AsStream: ' + (Get-ErrText $_)
                $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
                $ms = New-Object System.IO.MemoryStream
                $net.CopyTo($ms)
                $bytes = $ms.ToArray()
                $ms.Dispose()
                $script:ThumbNote = ''
            }
        } finally {
            try { $stream.Dispose() } catch {}
        }
    } catch {
        $script:ThumbNote = ($script:ThumbNote + ' ' + (Get-ErrText $_)).Trim()
        return $null
    }
    if ($null -eq $bytes -or $bytes.Length -eq 0) {
        $script:ThumbNote = 'empty'
        return $null
    }
    if ($bytes.Length -gt 6MB) {
        $script:ThumbNote = 'too big'
        return $null
    }
    if (-not $mime) { $mime = 'image/png' }
    return @{ mime = $mime; data = [Convert]::ToBase64String($bytes) }
}

function Get-MediaInfo($s, $have, $noThumb) {
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
    if (-not $noThumb -and [string]$have -ne $key) {
        $res.thumb = Get-MediaThumb $p.Thumbnail
        $res.thumbNote = [string]$script:ThumbNote
    }
    return $res
}

function Invoke-MediaGet($a) {
    if ([string]$a.app -like 'title:*') { return Get-TitleMedia }
    $s = Get-MediaSession $a.app $a.prefer
    if ($null -eq $s) {
        # no player told Windows anything: perhaps a browser that does not
        try { return Get-TitleMedia } catch { return $null }
    }
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
            $i = Get-MediaInfo $s '' $true
            $i.current = ($i.app -eq $curApp)
            $list += $i
        } catch {}
    }
    $windows = @()
    try {
        foreach ($w in (Get-YouTubeWindows)) { $windows += @{ exe = $w.exe; title = $w.title } }
    } catch {}
    return @{ sessions = @($list); youtubeWindows = @($windows) }
}

function Invoke-MediaCmd($a) {
    if ([string]$a.app -like 'title:*') {
        # known only by its window title: the keyboard's media keys are all we have
        Initialize-Native
        switch ([string]$a.action) {
            'next' { [Kaplya.Win]::MediaKey(0xB0) }
            'prev' { [Kaplya.Win]::MediaKey(0xB1) }
            default { [Kaplya.Win]::MediaKey(0xB3) }
        }
        return $true
    }
    $s = Get-MediaSession $a.app $a.prefer
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

# ---------------------------------------------------------------- the player's own window
# Windows has no "like" command for players, and some browsers tell Windows
# nothing about what they play. But a program's window says what is in it to
# screen readers (UI Automation): its buttons by name, its sliders by value. So
# the island can press the player's own "like" button, and read where a video is.

function Initialize-Uia {
    if ($script:UiaReady) { return }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $script:UiaReady = $true
}

$script:PlayerExe = 'spotify|music|aimp|vk|deezer|soundcloud|zvuk|foobar|winamp|itunes|tidal'

# Process ids whose windows may hold the player called $app (Windows' name for
# it, or "title:browser.exe").
function Get-PlayerPids($app) {
    Initialize-Native
    $want = (([string]$app).ToLower() -replace '^title:', '' -replace '\.exe$', '') -replace '[^a-z0-9]', ''
    if ($want -eq '308046b0af4a39cb') { $want = 'firefox' }
    $exact = @()
    $rest = @()
    foreach ($line in @([Kaplya.Win]::WindowTitles())) {
        $parts = ([string]$line).Split('|', 3)
        if ($parts.Count -lt 3) { continue }
        $id = [int]$parts[0]
        if ($id -eq $PID) { continue }
        $exe = $parts[1].ToLower()
        $n = $exe -replace '[^a-z0-9]', ''
        if ($want -and $n.Length -ge 3 -and ($want.Contains($n) -or $n.Contains($want))) { $exact += $id }
        elseif (($script:BrowserExe -contains $exe) -or ($exe -match $script:PlayerExe) -or ($parts[2] -match 'YouTube|Музыка|Music|Spotify')) { $rest += $id }
    }
    if ($exact.Count -gt 0) { return @($exact | Select-Object -Unique) }
    return @($rest | Select-Object -Unique)
}

$script:LikeGood = 'нравится|понрави|like|лайк|избранн|любим|медиатек|save to your'
$script:LikeBad = '(^|[^а-яёa-z])не (нравится|понрави)|dislike|комментар|comment|ответ|reply|рекоменд|playlist|плейлист'
$script:SeekGood = 'перемот|seek|progress|прогресс|воспроизведения|playback|timeline|хронометраж'

# What the player's window shows: its "like" button, its seek slider, the address
# of the page. Looks through the windows of the player's processes.
function Get-PlayerPage($app) {
    Initialize-Uia
    $AE = [System.Windows.Automation.AutomationElement]
    $CT = [System.Windows.Automation.ControlType]
    $types = @($CT::Button, $CT::Slider, $CT::Edit, $CT::CheckBox)
    $conds = @()
    foreach ($t in $types) { $conds += (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $t)) }
    $cond = New-Object System.Windows.Automation.OrCondition($conds)
    $cache = New-Object System.Windows.Automation.CacheRequest
    $cache.Add($AE::NameProperty)
    $cache.Add($AE::ControlTypeProperty)
    $cache.Add($AE::BoundingRectangleProperty)
    $res = @{ like = $null; likeName = ''; liked = $null; position = $null; duration = $null; url = ''; windows = 0; seen = 0 }
    $best = $null
    $bestScore = -1.0
    foreach ($id in (Get-PlayerPids $app)) {
        $wins = $AE::RootElement.FindAll('Children', (New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, [int]$id)))
        foreach ($win in $wins) {
            $res.windows += 1
            $scope = $cache.Activate()
            try { $all = $win.FindAll('Descendants', $cond) } catch { $all = @() } finally { $scope.Dispose() }
            foreach ($e in $all) {
                $res.seen += 1
                $name = [string]$e.Cached.Name
                $type = $e.Cached.ControlType
                $r = $e.Cached.BoundingRectangle
                if ($type -eq $CT::Edit) {
                    if (-not $res.url) {
                        try {
                            $v = [string]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
                            if ($v -match 'youtube\.com/|youtu\.be/|music\.yandex|vk\.com|spotify\.com|soundcloud\.com') { $res.url = $v }
                        } catch {}
                    }
                    continue
                }
                if ($type -eq $CT::Slider) {
                    if ($null -eq $res.duration -and $name -match $script:SeekGood) {
                        try {
                            $rv = $e.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern).Current
                            if ($rv.Maximum -gt 1) {
                                $res.position = [double]$rv.Value - [double]$rv.Minimum
                                $res.duration = [double]$rv.Maximum - [double]$rv.Minimum
                            }
                        } catch {}
                    }
                    continue
                }
                if (-not $name -or $name -notmatch $script:LikeGood -or $name -match $script:LikeBad) { continue }
                if ($r.IsEmpty -or $r.Width -le 0) { continue }
                # the video's or the player bar's own button: the one about "the video", else the lowest
                $score = [double]$r.Bottom
                if ($name -match 'видео|video') { $score += 100000 }
                if ($score -gt $bestScore) { $bestScore = $score; $best = $e }
            }
        }
    }
    if ($best) {
        $res.like = $best
        $res.likeName = [string]$best.Cached.Name
        try {
            $st = [string]$best.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState
            $res.liked = ($st -eq 'On')
        } catch {}
    }
    return $res
}

function Get-PlayerPageWaiting($app) {
    # A browser starts describing its pages only when somebody asks; the first look
    # may find just the frame of the window. Look again a moment later.
    $res = $null
    for ($i = 0; $i -lt 4; $i++) {
        $res = Get-PlayerPage $app
        if ($res.like -or $null -ne $res.duration) { break }
        Start-Sleep -Milliseconds 600
    }
    return $res
}

function ConvertTo-PageResult($res) {
    return @{
        found = [bool]$res.like
        liked = $res.liked
        likeName = $res.likeName
        position = $res.position
        duration = $res.duration
        url = $res.url
        windows = $res.windows
        seen = $res.seen
    }
}

function Invoke-PageRead($a) {
    return ConvertTo-PageResult (Get-PlayerPageWaiting $a.app)
}

# Presses the player's own "like". With want = true/false nothing is pressed when
# the button already says so.
function Invoke-PageLike($a) {
    $res = Get-PlayerPageWaiting $a.app
    $out = ConvertTo-PageResult $res
    $out.pressed = $false
    if (-not $res.like) { return $out }
    if ($null -ne $a.want -and $null -ne $res.liked -and ([bool]$a.want -eq [bool]$res.liked)) { return $out }
    $e = $res.like
    $done = $false
    try {
        $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $done = $true
    } catch {}
    if (-not $done) {
        try {
            $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
            $done = $true
        } catch {}
    }
    $out.pressed = $done
    if ($done) {
        Start-Sleep -Milliseconds 500
        try {
            $st = [string]$e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState
            $out.liked = ($st -eq 'On')
        } catch {
            if ($null -ne $res.liked) { $out.liked = -not $res.liked }
        }
    }
    return $out
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

# Which program is in front: its name as people know it ("Google Chrome", not
# "chrome"), where it lives (for its icon), and the window title. Read once per
# process and remembered.
$script:ProcCache = @{}

function Get-ActiveApp {
    try {
        Initialize-Native
        $parts = ([Kaplya.Win]::ForegroundApp()).Split('|', 2)
        $procId = [int]$parts[0]
        $title = ''
        if ($parts.Count -gt 1) { $title = [string]$parts[1] }
        if ($procId -le 0) { return $null }
        $info = $script:ProcCache[$procId]
        if ($null -eq $info) {
            $p = Get-Process -Id $procId -ErrorAction Stop
            $path = ''
            $name = [string]$p.ProcessName
            try {
                $path = [string]$p.Path
                $desc = [string]$p.MainModule.FileVersionInfo.FileDescription
                if ($desc -and $desc.Trim().Length -gt 1) { $name = $desc.Trim() }
            } catch {}
            $info = @{ exe = ([string]$p.ProcessName + '.exe'); path = $path; name = $name }
            if ($script:ProcCache.Count -gt 300) { $script:ProcCache.Clear() }
            $script:ProcCache[$procId] = $info
        }
        $res = @{ pid = $procId; exe = $info.exe; path = $info.path; name = $info.name; title = $title }
        # Store apps run inside a frame host: the window title is the app's name.
        if ($info.exe -ieq 'ApplicationFrameHost.exe' -and $title) {
            $res.name = $title
            $res.exe = 'uwp:' + $title
        }
        return $res
    } catch {
        return $null
    }
}

function Get-IdleMs {
    try {
        Initialize-Native
        return [long][Kaplya.Win]::IdleMs()
    } catch {
        return 0
    }
}

function Invoke-SysPoll($a) {
    return @{
        fullscreen = (Get-Fullscreen $a.ownPids)
        dark       = (Get-ThemeDark)
        volume     = (Get-VolumeState)
        active     = (Get-ActiveApp)
        idleMs     = (Get-IdleMs)
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

# Password managers mark what they copy with one of these formats, asking clipboard
# tools not to keep it. "secret" tells the app to leave such content alone.
$script:SecretFormats = @('ExcludeClipboardContentFromMonitorProcessing', 'Clipboard Viewer Ignore')

function Invoke-ClipInfo($a) {
    Initialize-Native
    $secret = $false
    foreach ($f in $script:SecretFormats) {
        if ([Kaplya.Win]::ClipboardHas($f)) { $secret = $true }
    }
    return @{ seq = [long][Kaplya.Win]::GetClipboardSequenceNumber(); secret = $secret }
}

# Everything the Start menu knows, including Store apps that have no shortcut file.
function Invoke-AppsList($a) {
    $list = @()
    foreach ($app in @(Get-StartApps)) {
        $list += @{ name = [string]$app.Name; id = [string]$app.AppID }
    }
    return @{ apps = @($list) }
}

# ---------------------------------------------------------------- icons

function Invoke-IconExtract($a) {
    Initialize-Native
    Add-Type -AssemblyName System.Drawing
    $size = 64
    if ($a.size) { $size = [int]$a.size }
    $h = [Kaplya.Win]::ExtractIcon([string]$a.path, [int]$a.index, $size)
    if ($h -eq [IntPtr]::Zero) { throw 'no-icon' }
    try {
        $icon = [System.Drawing.Icon]::FromHandle($h)
        $bmp = $icon.ToBitmap()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $ms.ToArray()
        $width = $bmp.Width
        $ms.Dispose()
        $bmp.Dispose()
        return @{ data = [Convert]::ToBase64String($bytes); size = $width }
    } finally {
        [Kaplya.Win]::DestroyIcon($h) | Out-Null
    }
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
        'page.read' { return Invoke-PageRead $a }
        'page.like' { return Invoke-PageLike $a }
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
        'clip.info' { return Invoke-ClipInfo $a }
        'apps.list' { return Invoke-AppsList $a }
        'icon.extract' { return Invoke-IconExtract $a }
        default { throw "unknown command: $cmd" }
    }
}

if ($SelfTest) {
    $failed = 0
    foreach ($c in @('ping', 'sys.poll', 'volume.get', 'media.get', 'media.sessions', 'radio.get', 'wifi.list', 'ocr.langs', 'clip.seq', 'clip.info', 'apps.list')) {
        try {
            $r = Invoke-Cmd $c (New-Object PSObject)
            # a cover is thousands of characters: say how big it is instead
            if ($r -is [hashtable] -and $r.thumb) { $r.thumb = @{ mime = $r.thumb.mime; base64Length = $r.thumb.data.Length } }
            $shown = ConvertTo-AsciiJson @{ result = $r }
            if ($shown.Length -gt 400) { $shown = $shown.Substring(0, 400) + ' ... (' + $shown.Length + ' characters)' }
            [Console]::Out.WriteLine("OK   $c  $shown")
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
