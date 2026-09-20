; NSIS installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).

; "Start with Windows" (tauri-plugin-autostart) writes a per-user Run entry named after the app. Remove it on
; uninstall so Windows isn't left trying to launch a program that no longer exists.
!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "DeskGhost"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "DeskGhost"
!macroend
