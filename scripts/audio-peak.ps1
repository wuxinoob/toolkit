<#
  Is the machine playing a sound RIGHT NOW?

  Why this exists: "did we really stop the beep?" is the one question in the
  subprocess-bell investigation that ears cannot answer reproducibly — you have
  to be listening at the right moment, and the sound is ~150 ms long. This polls
  the default render endpoint's peak meter (WASAPI) and prints every burst, so a
  beep becomes a timestamped fact with a count and a duration.

  It measures the DEVICE, not a process: it answers "was anything playing", not
  "who". That is enough to tell "the beep still happens" from "the beep is
  gone", and to see coalescing (one burst vs several).

  Usage:

    powershell -File scripts/audio-peak.ps1                  # 10s, threshold 0.005
    powershell -File scripts/audio-peak.ps1 -Seconds 20
    powershell -File scripts/audio-peak.ps1 -Seconds 4 -SelfTest   # prove it works

  Self-test: plays a 300 ms beep mid-window and must see it. Run it first — a
  probe that cannot fire would "prove" anything you like.

  The polling loop lives in C# rather than PowerShell on purpose: a COM interface
  reference that arrives through `[MarshalAs(UnmanagedType.IUnknown)] out object`
  is a bare `System.__ComObject` to PowerShell, which then cannot dispatch
  `GetPeakValue` on it. Inside C# the interface is statically typed, so the
  vtable call works.
#>
param(
  [int]$Seconds = 10,
  [double]$Threshold = 0.005,
  [int]$IntervalMs = 10,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice
{
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMeterInformation
{
    int GetPeakValue(out float peak);
}

public static class AudioPeak
{
    private static IAudioMeterInformation DefaultMeter()
    {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 0, out device)); // eRender, eConsole
        var iid = typeof(IAudioMeterInformation).GUID;
        object meter;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 1, IntPtr.Zero, out meter)); // CLSCTX_INPROC_SERVER
        return (IAudioMeterInformation)meter;
    }

    public static string Run(int seconds, double threshold, int intervalMs, bool selfTest)
    {
        var meter = DefaultMeter();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var report = new StringBuilder();
        var bursts = new List<string>();
        float max = 0f;
        double activeSince = -1;
        bool played = false;
        bool synthesized = false;

        while (watch.Elapsed.TotalSeconds < seconds)
        {
            float peak;
            Marshal.ThrowExceptionForHR(meter.GetPeakValue(out peak));
            if (peak > max) max = peak;
            double now = watch.Elapsed.TotalMilliseconds;

            if (peak > threshold)
            {
                if (activeSince < 0) activeSince = now;
            }
            else if (activeSince >= 0)
            {
                bursts.Add(string.Format("  at {0} ms, {1} ms long", (int)activeSince, (int)(now - activeSince)));
                activeSince = -1;
            }

            // Two DIFFERENT mechanisms, because they are the two candidates:
            //   * `SystemSounds.Beep` plays the scheme's "Default Beep" WAV —
            //     what a console host rings for a BEL. It is asynchronous, so
            //     the meter gets to watch it;
            //   * `Console.Beep` synthesizes a tone through the Beep API — what
            //     an "audible" PSReadLine bell calls. It BLOCKS for its whole
            //     duration, which is itself a fingerprint on the timeline.
            if (selfTest && !played && now > 700)
            {
                played = true;
                System.Media.SystemSounds.Beep.Play();
            }
            if (selfTest && played && !synthesized && now > 2500)
            {
                synthesized = true;
                Console.Beep(880, 300);
            }

            Thread.Sleep(intervalMs);
        }

        if (activeSince >= 0)
        {
            bursts.Add(string.Format("  at {0} ms, {1} ms long", (int)activeSince, (int)(watch.Elapsed.TotalMilliseconds - activeSince)));
        }

        report.AppendFormat("peak observed: {0:F4}\n", max);
        report.AppendFormat("sounds: {0}\n", bursts.Count);
        report.Append(string.Join("\n", bursts));
        if (bursts.Count == 0) report.Append("  (silence)");
        if (selfTest)
        {
            report.Append(bursts.Count > 0
                ? "\nSELFTEST OK: the probe sees a beep"
                : "\nSELFTEST FAILED: played a beep and saw nothing");
        }
        return report.ToString();
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp | Out-Null

# Write-Output, not Write-Host: this is meant to be run with
# `Start-Process -RedirectStandardOutput`, which captures the success stream and
# would silently drop host-only output — a probe that logs nothing looks exactly
# like a probe that heard nothing.
Write-Output ("listening {0}s, threshold {1} ..." -f $Seconds, $Threshold)
Write-Output ([AudioPeak]::Run($Seconds, $Threshold, $IntervalMs, [bool]$SelfTest))
exit 0
