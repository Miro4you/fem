' Projekt-FEM - Solid Edge: aktives Teil als STEP an Projekt-FEM schicken ("In Projekt-FEM rechnen").
' Doppelklick oder als Knopf einrichten (cad-addins/README.md). Solid Edge muss laufen.
Option Explicit

' --- gemeinsame Hilfsfunktionen (Projekt-FEM) --------------------------------------------------------
Const TITEL = "Projekt-FEM"

Sub Einstellungen(adresse, schluessel)
    adresse = "http://127.0.0.1:8791/cad"
    schluessel = ""
    Dim fso, f, zeile, teile, pfad
    Set fso = CreateObject("Scripting.FileSystemObject")
    pfad = CreateObject("WScript.Shell").ExpandEnvironmentStrings("%USERPROFILE%") & "\projekt-fem-cad.txt"
    If Not fso.FileExists(pfad) Then Exit Sub
    Set f = fso.OpenTextFile(pfad, 1)
    Do While Not f.AtEndOfStream
        zeile = Trim(f.ReadLine)
        If Left(zeile, 3) = Chr(239) & Chr(187) & Chr(191) Then zeile = Mid(zeile, 4)
        If InStr(zeile, "=") > 0 And Left(zeile, 1) <> "#" Then
            teile = Split(zeile, "=", 2)
            Select Case LCase(Trim(teile(0)))
                Case "adresse": adresse = Trim(teile(1))
                Case "schluessel": schluessel = Trim(teile(1))
            End Select
        End If
    Loop
    f.Close
    If Right(adresse, 1) = "/" Then adresse = Left(adresse, Len(adresse) - 1)
End Sub

' Anfrage an Projekt-FEM; gibt True bei Erfolg, Antworttext in antwort
Function Anfrage(methode, pfad, daten, quelle, antwort)
    Dim adresse, schluessel, http
    Einstellungen adresse, schluessel
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    On Error Resume Next
    http.setTimeouts 5000, 5000, 120000, 120000
    http.Open methode, adresse & pfad, False
    http.setRequestHeader "X-FEM-CAD", quelle
    If schluessel <> "" Then http.setRequestHeader "X-FEM-Key", schluessel
    If IsEmpty(daten) Then
        http.send
    Else
        http.setRequestHeader "Content-Type", "application/octet-stream"
        http.send daten
    End If
    If Err.Number <> 0 Then
        antwort = "Projekt-FEM ist nicht erreichbar (" & adresse & ")." & vbCrLf & "Laeuft Projekt-FEM?"
        Anfrage = False
        Exit Function
    End If
    On Error GoTo 0
    antwort = http.responseText
    Anfrage = (http.Status = 200)
End Function

Function DateiLesen(pfad)
    Dim st
    Set st = CreateObject("ADODB.Stream")
    st.Type = 1
    st.Open
    st.LoadFromFile pfad
    DateiLesen = st.Read
    st.Close
End Function

' Prozent-Kodierung (UTF-8) fuer Teilnamen mit Umlauten und Leerzeichen
Function UrlCode(s)
    Dim st, b, i, c, r
    Set st = CreateObject("ADODB.Stream")
    st.Type = 2
    st.Charset = "utf-8"
    st.Open
    st.WriteText s
    st.Position = 0
    st.Type = 1
    st.Position = 3
    b = st.Read
    st.Close
    For i = 1 To LenB(b)
        c = AscB(MidB(b, i, 1))
        If (c >= 48 And c <= 57) Or (c >= 65 And c <= 90) Or (c >= 97 And c <= 122) Or c = 45 Or c = 46 Or c = 95 Or c = 126 Then
            r = r & Chr(c)
        Else
            r = r & "%" & Right("0" & Hex(c), 2)
        End If
    Next
    UrlCode = r
End Function

Function DateiName(s)
    Dim re
    Set re = New RegExp
    re.Global = True
    re.Pattern = "[^A-Za-z0-9._-]"
    DateiName = re.Replace(s, "_")
End Function

Function OhneEndung(s)
    OhneEndung = s
    If InStrRev(s, ".") > 1 Then OhneEndung = Left(s, InStrRev(s, ".") - 1)
End Function

Function SolidEdgeTeil()
    Dim app, doc, ext
    On Error Resume Next
    Set app = GetObject(, "SolidEdge.Application")
    If Err.Number <> 0 Then
        MsgBox "Solid Edge laeuft nicht.", vbExclamation, TITEL
        WScript.Quit
    End If
    Set doc = app.ActiveDocument
    If Err.Number <> 0 Then
        MsgBox "Bitte zuerst ein Teil laden.", vbExclamation, TITEL
        WScript.Quit
    End If
    On Error GoTo 0
    ext = LCase(Mid(doc.Name, InStrRev(doc.Name, ".") + 1))
    If ext <> "par" And ext <> "psm" Then
        MsgBox "Projekt-FEM rechnet bisher einzelne Teile (.par/.psm) - Baugruppen folgen.", vbExclamation, TITEL
        WScript.Quit
    End If
    Set SolidEdgeTeil = doc
End Function

Dim doc, name, pfad, fso, antwort
Set doc = SolidEdgeTeil()
name = OhneEndung(doc.Name)
Set fso = CreateObject("Scripting.FileSystemObject")
pfad = fso.BuildPath(fso.GetSpecialFolder(2), "projekt-fem-" & DateiName(name) & ".stp")
If fso.FileExists(pfad) Then fso.DeleteFile pfad
On Error Resume Next
doc.SaveCopyAs pfad
If Err.Number <> 0 Then
    Err.Clear
    doc.SaveAs pfad
End If
On Error GoTo 0
If Not fso.FileExists(pfad) Then
    MsgBox "STEP-Export fehlgeschlagen.", vbCritical, TITEL
    WScript.Quit
End If
If Anfrage("POST", "/open?name=" & UrlCode(name) & "&source=Solid%20Edge", DateiLesen(pfad), "Solid Edge", antwort) Then
    MsgBox Chr(34) & name & Chr(34) & " an Projekt-FEM geschickt." & vbCrLf & vbCrLf & _
        "Beim ersten Mal dort Lager und Lasten festlegen und rechnen; danach rechnet Projekt-FEM jede neue Version automatisch.", _
        vbInformation, TITEL
Else
    MsgBox antwort, vbExclamation, TITEL
End If
