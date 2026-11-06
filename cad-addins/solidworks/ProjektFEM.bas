Attribute VB_Name = "ProjektFEM"
' Projekt-FEM - Knoepfe fuer SolidWorks
'
'   InProjektFEMRechnen  - aktives Teil als STEP an Projekt-FEM schicken
'   ErgebnisHolen        - Ergebniswerte als benutzerdefinierte Eigenschaften eintragen
'
' Einrichten: Extras > Makro > Neu (z. B. ProjektFEM.swp), im VBA-Editor Datei > Datei importieren > diese Datei,
' dann zwei Makro-Knoepfe anlegen (Anleitung: cad-addins/README.md).
' Adresse und Schluessel stehen in %USERPROFILE%\projekt-fem-cad.txt (fehlt die Datei: Projekt-FEM auf diesem Rechner).

Option Explicit

Private Const TITEL As String = "Projekt-FEM"

Public Sub InProjektFEMRechnen()
    Dim swApp As Object, doc As Object
    Set swApp = Application.SldWorks
    Set doc = swApp.ActiveDoc
    If doc Is Nothing Then
        MsgBox "Bitte zuerst ein Teil laden.", vbExclamation, TITEL
        Exit Sub
    End If
    If doc.GetType <> 1 Then ' 1 = Teil
        MsgBox "Projekt-FEM rechnet bisher einzelne Teile - Baugruppen folgen.", vbExclamation, TITEL
        Exit Sub
    End If
    Dim name As String, pfad As String, fehler As Long, warnungen As Long
    name = TeilName(doc)
    pfad = Environ("TEMP") & "\projekt-fem-" & DateiName(name) & ".step"
    ' 0 = aktuelle Version, 1 + 2 = still, als Kopie (das Teil bleibt unveraendert offen)
    If Not doc.Extension.SaveAs(pfad, 0, 3, Nothing, fehler, warnungen) Then
        MsgBox "STEP-Export fehlgeschlagen (Fehler " & fehler & ").", vbCritical, TITEL
        Exit Sub
    End If
    Dim antwort As String
    If Anfrage("POST", "/open?name=" & UrlCode(name) & "&source=SolidWorks", DateiLesen(pfad), antwort) Then
        MsgBox Chr(34) & name & Chr(34) & " an Projekt-FEM geschickt." & vbCrLf & vbCrLf & _
            "Beim ersten Mal dort Lager und Lasten festlegen und rechnen; danach rechnet Projekt-FEM jede neue Version automatisch.", _
            vbInformation, TITEL
    Else
        MsgBox antwort, vbExclamation, TITEL
    End If
End Sub

Public Sub ErgebnisHolen()
    Dim swApp As Object, doc As Object
    Set swApp = Application.SldWorks
    Set doc = swApp.ActiveDoc
    If doc Is Nothing Then
        MsgBox "Bitte zuerst ein Teil laden.", vbExclamation, TITEL
        Exit Sub
    End If
    Dim name As String, antwort As String
    name = TeilName(doc)
    If Not Anfrage("GET", "/summary?name=" & UrlCode(name), Empty, antwort) Then
        MsgBox antwort, vbExclamation, TITEL
        Exit Sub
    End If
    ' flaches JSON: "Name": Zahl | "Text" | null
    Dim re As Object, m As Object, eig As Object, wert As String, liste As String
    Set re = CreateObject("VBScript.RegExp")
    re.Global = True
    re.Pattern = """(\w+)""\s*:\s*(""([^""]*)""|null|true|false|-?[0-9.eE+-]+)"
    Set eig = doc.Extension.CustomPropertyManager("")
    For Each m In re.Execute(antwort)
        If m.SubMatches(1) = "null" Then
            wert = ""
        ElseIf Left(m.SubMatches(1), 1) = """" Then
            wert = m.SubMatches(2)
        Else
            wert = Replace(m.SubMatches(1), ".", ",")
        End If
        eig.Add3 m.SubMatches(0), 30, wert, 2 ' 30 = Text, 2 = vorhandenen Wert ersetzen
        liste = liste & m.SubMatches(0) & " = " & wert & vbCrLf
    Next
    MsgBox "Ergebnis fuer " & Chr(34) & name & Chr(34) & " eingetragen (Datei > Eigenschaften > Benutzerdefiniert):" & _
        vbCrLf & vbCrLf & liste, vbInformation, TITEL
End Sub

' --- Hilfsfunktionen -------------------------------------------------------------------------------

Private Function TeilName(doc As Object) As String
    Dim p As String
    p = doc.GetPathName
    If p = "" Then p = doc.GetTitle
    p = Mid(p, InStrRev(p, "\") + 1)
    If LCase(Right(p, 7)) = ".sldprt" Then p = Left(p, Len(p) - 7)
    TeilName = p
End Function

Private Function DateiName(s As String) As String
    Dim i As Long, c As String, r As String
    For i = 1 To Len(s)
        c = Mid(s, i, 1)
        If c Like "[A-Za-z0-9._-]" Then r = r & c Else r = r & "_"
    Next
    DateiName = r
End Function

Private Sub Einstellungen(ByRef adresse As String, ByRef schluessel As String)
    adresse = "http://127.0.0.1:8791/cad"
    schluessel = ""
    Dim fso As Object, f As Object, zeile As String, teile() As String
    Set fso = CreateObject("Scripting.FileSystemObject")
    Dim pfad As String
    pfad = Environ("USERPROFILE") & "\projekt-fem-cad.txt"
    If Not fso.FileExists(pfad) Then Exit Sub
    Set f = fso.OpenTextFile(pfad, 1)
    Do While Not f.AtEndOfStream
        zeile = Trim(f.ReadLine)
        If Left(zeile, 3) = Chr(239) & Chr(187) & Chr(191) Then zeile = Mid(zeile, 4) ' BOM
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

Private Function Anfrage(methode As String, pfad As String, daten As Variant, ByRef antwort As String) As Boolean
    Dim adresse As String, schluessel As String, http As Object
    Einstellungen adresse, schluessel
    On Error GoTo Fehler
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 5000, 5000, 120000, 120000
    http.Open methode, adresse & pfad, False
    http.setRequestHeader "X-FEM-CAD", "SolidWorks"
    If schluessel <> "" Then http.setRequestHeader "X-FEM-Key", schluessel
    If IsEmpty(daten) Then
        http.send
    Else
        http.setRequestHeader "Content-Type", "application/octet-stream"
        http.send daten
    End If
    antwort = http.responseText
    Anfrage = (http.Status = 200)
    Exit Function
Fehler:
    antwort = "Projekt-FEM ist nicht erreichbar (" & adresse & ")." & vbCrLf & "Laeuft Projekt-FEM?"
    Anfrage = False
End Function

Private Function DateiLesen(pfad As String) As Variant
    Dim st As Object
    Set st = CreateObject("ADODB.Stream")
    st.Type = 1
    st.Open
    st.LoadFromFile pfad
    DateiLesen = st.Read
    st.Close
End Function

' Prozent-Kodierung (UTF-8) fuer Teilnamen mit Umlauten und Leerzeichen
Private Function UrlCode(s As String) As String
    Dim st As Object, b() As Byte, i As Long, r As String
    Set st = CreateObject("ADODB.Stream")
    st.Type = 2
    st.Charset = "utf-8"
    st.Open
    st.WriteText s
    st.Position = 0
    st.Type = 1
    st.Position = 3 ' BOM ueberspringen
    b = st.Read
    st.Close
    For i = LBound(b) To UBound(b)
        Select Case b(i)
            Case 48 To 57, 65 To 90, 97 To 122, 45, 46, 95, 126
                r = r & Chr(b(i))
            Case Else
                r = r & "%" & Right("0" & Hex(b(i)), 2)
        End Select
    Next
    UrlCode = r
End Function
