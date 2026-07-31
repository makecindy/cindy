// xdt-helper — tiny Windows GUI-subsystem launcher for update scripts.
//
// Compiled with /target:winexe so it's a GUI app — spawning it with
// child_process.spawn({ detached: true }) does NOT create a console window.
//
// Build:
//   csc /target:winexe /optimize /out:..\..\resources\xdt-helper.exe main.cs

using System;
using System.Diagnostics;

class Program
{
    static void Main(string[] args)
    {
        if (args.Length < 1) return;
        Process.Start(new ProcessStartInfo
        {
            FileName = args[0],
            CreateNoWindow = true,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden,
        });
    }
}
