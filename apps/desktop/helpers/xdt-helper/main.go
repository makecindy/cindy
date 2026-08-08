// xdt-helper — tiny Windows GUI-subsystem launcher for update scripts.
//
// Because it is compiled as a GUI app (-H windowsgui), spawning it with
// child_process.spawn({ detached: true }) does NOT create a console window,
// exactly like electron-updater spawning an NSIS installer.
//
// It launches cmd.exe with CREATE_NO_WINDOW so the script also runs invisibly.
//
// Build:
//   GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui -s -w" -o ../../resources/xdt-helper.exe

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func main() {
	if len(os.Args) < 2 {
		os.Exit(1)
	}
	cmd := exec.Command(os.Args[1])
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
	cmd.Start()
}
