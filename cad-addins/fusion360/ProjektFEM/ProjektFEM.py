# Projekt-FEM – Add-in für Autodesk Fusion (Windows und Mac)
#
# Zwei Knöpfe im Reiter VOLUMENKÖRPER, Gruppe „Projekt-FEM“:
#   In Projekt-FEM rechnen – aktive Komponente als STEP an Projekt-FEM schicken
#   Ergebnis holen          – Ergebniswerte als Benutzerparameter (Zahlen) und Attribute übernehmen
#
# Adresse und Schlüssel stehen in ~/projekt-fem-cad.txt (fehlt die Datei: Projekt-FEM auf diesem Rechner).

import json
import os
import re
import tempfile
import traceback
import urllib.error
import urllib.parse
import urllib.request

import adsk.core
import adsk.fusion

APP = None
UI = None
HANDLERS = []
HERE = os.path.dirname(os.path.abspath(__file__))
PANEL_ID = 'ProjektFEMPanel'
COMMANDS = [
    ('ProjektFEM_senden', 'In Projekt-FEM rechnen', 'Aktive Komponente als STEP an Projekt-FEM schicken. '
     'Gleiches Teil: Lager und Lasten bleiben, Projekt-FEM rechnet neu.', 'senden'),
    ('ProjektFEM_holen', 'Ergebnis holen', 'Sicherheit, Spannung, Verformung und Masse aus Projekt-FEM '
     'als Benutzerparameter übernehmen.', 'holen'),
]


# --- Verbindung zu Projekt-FEM ------------------------------------------------------------------

def settings():
    cfg = {'adresse': 'http://127.0.0.1:8791/cad', 'schluessel': ''}
    path = os.path.join(os.path.expanduser('~'), 'projekt-fem-cad.txt')
    if os.path.exists(path):
        with open(path, encoding='utf-8-sig') as f:
            for line in f:
                if '=' in line and not line.strip().startswith('#'):
                    k, v = line.split('=', 1)
                    cfg[k.strip().lower()] = v.strip()
    return cfg['adresse'].rstrip('/'), cfg['schluessel']


def request(method, path, data=None):
    base, key = settings()
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header('X-FEM-CAD', 'Fusion')
    if key:
        req.add_header('X-FEM-Key', key)
    if data is not None:
        req.add_header('Content-Type', 'application/octet-stream')
    # ohne Proxy (Projekt-FEM läuft auf diesem Rechner bzw. im Heimnetz)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=120) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode('utf-8', 'replace') or str(e))
    except urllib.error.URLError as e:
        raise RuntimeError('Projekt-FEM ist nicht erreichbar ({}).\n\nLäuft Projekt-FEM? Adresse: {}'.format(e.reason, base))


# --- Teil -----------------------------------------------------------------------------------------

def design():
    d = adsk.fusion.Design.cast(APP.activeProduct)
    if not d:
        raise RuntimeError('Bitte ein Konstruktionsdokument öffnen (Arbeitsbereich KONSTRUKTION).')
    return d


def part_name(d):
    """Name ohne Fusion-Versionsnummer („Hebel v7“ → „Hebel“), damit Projekt-FEM das Teil wiedererkennt."""
    comp = d.activeComponent
    if comp != d.rootComponent:
        return comp.name
    return re.sub(r'\s+v\d+$', '', APP.activeDocument.name)


def send():
    d = design()
    comp = d.activeComponent
    solids = [b for b in comp.bRepBodies if b.isSolid and b.isVisible]
    for occ in comp.allOccurrences:
        solids += [b for b in occ.bRepBodies if b.isSolid and b.isVisible]
    if not solids:
        raise RuntimeError('In der aktiven Komponente ist kein sichtbarer Volumenkörper.')
    name = part_name(d)
    if len(solids) > 1:
        r = UI.messageBox('„{}“ hat {} Körper. Projekt-FEM rechnet bisher einzelne Teile – Baugruppen folgen.\n\n'
                          'Trotzdem schicken?'.format(name, len(solids)), 'Projekt-FEM',
                          adsk.core.MessageBoxButtonTypes.YesNoButtonType)
        if r != adsk.core.DialogResults.DialogYes:
            return
    path = os.path.join(tempfile.gettempdir(), 'projekt-fem-' + re.sub(r'[^\w.-]', '_', name) + '.step')
    em = d.exportManager
    if not em.execute(em.createSTEPExportOptions(path, comp)):
        raise RuntimeError('STEP-Export fehlgeschlagen.')
    with open(path, 'rb') as f:
        data = f.read()
    request('POST', '/open?' + urllib.parse.urlencode({'name': name, 'source': 'Fusion'}), data)
    UI.messageBox('„{}“ an Projekt-FEM geschickt.\n\nBeim ersten Mal dort Lager und Lasten festlegen und rechnen; '
                  'danach rechnet Projekt-FEM jede neue Version automatisch.'.format(name), 'Projekt-FEM')


def fetch():
    d = design()
    name = part_name(d)
    values = json.loads(request('GET', '/summary?' + urllib.parse.urlencode({'name': name})).decode('utf-8'))
    lines = []
    for k, v in values.items():
        # Zahlen als Benutzerparameter (ohne Einheit, Einheit steht im Namen), alles auch als Attribut
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            try:
                p = d.userParameters.itemByName(k)
                if p:
                    p.expression = repr(float(v))
                else:
                    d.userParameters.add(k, adsk.core.ValueInput.createByString(repr(float(v))), '', 'Projekt-FEM')
            except Exception:
                pass  # Direktmodellierung: keine Parameter, nur Attribute
        d.attributes.add('ProjektFEM', k, '' if v is None else str(v))
        lines.append('{} = {}'.format(k, '–' if v is None else str(v).replace('.', ',') if isinstance(v, float) else v))
    UI.messageBox('Ergebnis für „{}“ übernommen (Ändern → Parameter → Benutzerparameter):\n\n{}'.format(name, '\n'.join(lines)),
                  'Projekt-FEM')


# --- Knöpfe ---------------------------------------------------------------------------------------

class Execute(adsk.core.CommandEventHandler):
    def __init__(self, kind):
        super().__init__()
        self.kind = kind

    def notify(self, args):
        try:
            send() if self.kind == 'senden' else fetch()
        except Exception as e:
            UI.messageBox(str(e), 'Projekt-FEM')


class Created(adsk.core.CommandCreatedEventHandler):
    def __init__(self, kind):
        super().__init__()
        self.kind = kind

    def notify(self, args):
        h = Execute(self.kind)
        args.command.execute.add(h)
        HANDLERS.append(h)


def run(context):
    global APP, UI
    try:
        APP = adsk.core.Application.get()
        UI = APP.userInterface
        ws = UI.workspaces.itemById('FusionSolidEnvironment')
        tab = ws.toolbarTabs.itemById('SolidTab')
        panel = tab.toolbarPanels.itemById(PANEL_ID) or tab.toolbarPanels.add(PANEL_ID, 'Projekt-FEM', 'SolidScriptsAddinsPanel', False)
        for cid, name, tip, kind in COMMANDS:
            old = UI.commandDefinitions.itemById(cid)
            if old:
                old.deleteMe()
            cd = UI.commandDefinitions.addButtonDefinition(cid, name, tip, os.path.join(HERE, 'resources', kind))
            h = Created(kind)
            cd.commandCreated.add(h)
            HANDLERS.append(h)
            ctrl = panel.controls.itemById(cid) or panel.controls.addCommand(cd)
            ctrl.isPromoted = True
            ctrl.isPromotedByDefault = True
    except Exception:
        if UI:
            UI.messageBox('Projekt-FEM-Add-in konnte nicht starten:\n' + traceback.format_exc())


def stop(context):
    try:
        ws = UI.workspaces.itemById('FusionSolidEnvironment')
        panel = ws.toolbarTabs.itemById('SolidTab').toolbarPanels.itemById(PANEL_ID)
        for cid, _, _, _ in COMMANDS:
            if panel and panel.controls.itemById(cid):
                panel.controls.itemById(cid).deleteMe()
            if UI.commandDefinitions.itemById(cid):
                UI.commandDefinitions.itemById(cid).deleteMe()
        if panel:
            panel.deleteMe()
    except Exception:
        pass
