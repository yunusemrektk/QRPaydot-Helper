; Auto-start on Windows login
!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "QRPaydotHelper" "$INSTDIR\QRPaydot Helper.exe"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "QRPaydotHelper"
!macroend
