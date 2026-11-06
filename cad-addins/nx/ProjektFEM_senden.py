# Projekt-FEM – NX-Journal „In Projekt-FEM rechnen“: angezeigtes Teil als STEP an Projekt-FEM schicken.
# Als Knopf einrichten: siehe cad-addins/README.md (NX: Anpassen → Neuer Benutzerbefehl → dieses Journal).

import json
import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request

import NXOpen

TITEL = 'Projekt-FEM'


def einstellungen():
    """Adresse und Schlüssel aus ~/projekt-fem-cad.txt (fehlt die Datei: Projekt-FEM auf diesem Rechner)."""
    cfg = {'adresse': 'http://127.0.0.1:8791/cad', 'schluessel': ''}
    pfad = os.path.join(os.path.expanduser('~'), 'projekt-fem-cad.txt')
    if os.path.exists(pfad):
        with open(pfad, encoding='utf-8-sig') as f:
            for zeile in f:
                if '=' in zeile and not zeile.strip().startswith('#'):
                    k, v = zeile.split('=', 1)
                    cfg[k.strip().lower()] = v.strip()
    return cfg['adresse'].rstrip('/'), cfg['schluessel']


def anfrage(methode, pfad, daten=None):
    basis, schluessel = einstellungen()
    req = urllib.request.Request(basis + pfad, data=daten, method=methode)
    req.add_header('X-FEM-CAD', 'NX')
    if schluessel:
        req.add_header('X-FEM-Key', schluessel)
    if daten is not None:
        req.add_header('Content-Type', 'application/octet-stream')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=120) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode('utf-8', 'replace') or str(e))
    except urllib.error.URLError as e:
        raise RuntimeError('Projekt-FEM ist nicht erreichbar ({}).\nLäuft Projekt-FEM? Adresse: {}'.format(e.reason, basis))


def melden(text, fehler=False):
    art = NXOpen.NXMessageBox.DialogType.Error if fehler else NXOpen.NXMessageBox.DialogType.Information
    NXOpen.UI.GetUI().NXMessageBox.Show(TITEL, art, text)


def aktives_teil():
    teil = NXOpen.Session.GetSession().Parts.Display
    if teil is None:
        raise RuntimeError('Bitte zuerst ein Teil öffnen.')
    return teil, teil.Leaf


def main():
    try:
        teil, name = aktives_teil()
        pfad = os.path.join(tempfile.gettempdir(), 'projekt-fem-' + re.sub(r'[^\w.-]', '_', name) + '.stp')
        sc = NXOpen.Session.GetSession().DexManager.CreateStepCreator()
        try:
            basis = os.environ.get('UGII_BASE_DIR')
            if basis and not sc.SettingsFile:
                sc.SettingsFile = os.path.join(basis, 'step214ug', 'ugstep214.def')
            sc.ExportAs = NXOpen.StepCreator.ExportAsOption.Ap214
            sc.ExportFrom = NXOpen.StepCreator.ExportFromOption.DisplayPart
            if teil.FullPath:
                sc.InputFile = teil.FullPath
            sc.OutputFile = pfad
            sc.ObjectTypes.Solids = True
            sc.FileSaveFlag = False
            sc.LayerMask = '1-256'
            sc.ProcessHoldFlag = True  # warten, bis die Datei fertig ist
            sc.Commit()
        finally:
            sc.Destroy()
        if not os.path.exists(pfad):
            raise RuntimeError('STEP-Export fehlgeschlagen.')
        with open(pfad, 'rb') as f:
            daten = f.read()
        anfrage('POST', '/open?' + urllib.parse.urlencode({'name': name, 'source': 'NX'}), daten)
        melden('„{}“ an Projekt-FEM geschickt.\n\nBeim ersten Mal dort Lager und Lasten festlegen und rechnen; '
               'danach rechnet Projekt-FEM jede neue Version automatisch.'.format(name))
    except Exception as e:
        melden(str(e), True)


if __name__ == '__main__':
    main()
