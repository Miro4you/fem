import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

export const gmshPath = () => invoke('gmsh_path')
export const openStep = (path, size, linear = false) => invoke('open_step', { path, size, linear })
export const solve = (setup) => invoke('solve', { setup })
export const exportVtu = (path) => invoke('export_vtu', { path })
export const saveText = (path, content) => invoke('save_text', { path, content })
export const loadText = (path) => invoke('load_text', { path })

export const pickStep = () =>
  open({ multiple: false, filters: [{ name: 'STEP-Geometrie', extensions: ['step', 'stp', 'STEP', 'STP'] }] })
export const pickProject = () =>
  open({ multiple: false, filters: [{ name: 'Projekt-FEM', extensions: ['fem.json', 'json'] }] })
export const pickProjectSave = (name) =>
  save({ defaultPath: name, filters: [{ name: 'Projekt-FEM', extensions: ['fem.json'] }] })
export const pickVtuSave = (name) =>
  save({ defaultPath: name, filters: [{ name: 'VTK (ParaView)', extensions: ['vtu'] }] })
