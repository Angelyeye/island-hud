!macro customCheckAppRunning
  ; Ask the matching Electron single-instance owner to exit gracefully.
  ; Do not enumerate or terminate processes by executable name.
  IfFileExists "$INSTDIR\IslandHUD.exe" 0 +3
  ExecWait '"$INSTDIR\IslandHUD.exe" --quit-for-maintenance' $0
  Sleep 500
!macroend

!macro customUnInstall
  ; A finished upgrade keeps integrations. A real uninstall removes only the
  ; manager-owned DSH dependency, bundle selection, and startup entry.
  ${IfNot} ${isUpdated}
    !insertmacro customCheckAppRunning
    ExecWait '"$INSTDIR\IslandHUD.exe" --uninstall-cleanup' $0
    ${If} $0 != 0
      IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "Island HUD 无法安全移除 DSH 集成。请在设置中修复或卸载集成后重试。配置备份已保留。"
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
!macroend
