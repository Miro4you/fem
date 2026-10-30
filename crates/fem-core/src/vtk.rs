//! Export als VTK-UnstructuredGrid (.vtu), z. B. zum Anschauen in ParaView.

use std::fmt::Write as _;
use std::io::Write;

use crate::{Mesh, Results};

pub fn write_vtu(out: &mut impl Write, mesh: &Mesh, res: &Results) -> std::io::Result<()> {
    let ne = mesh.n_elems();
    let mut s = String::new();
    let _ = writeln!(s, r#"<?xml version="1.0"?>"#);
    let _ = writeln!(s, r#"<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian">"#);
    let _ = writeln!(s, r#"<UnstructuredGrid><Piece NumberOfPoints="{}" NumberOfCells="{}">"#, mesh.nodes.len(), ne);

    s.push_str(r#"<Points><DataArray type="Float64" NumberOfComponents="3" format="ascii">"#);
    for p in &mesh.nodes {
        let _ = write!(s, "{} {} {} ", p[0], p[1], p[2]);
    }
    s.push_str("</DataArray></Points>\n<Cells>");

    s.push_str(r#"<DataArray type="Int64" Name="connectivity" format="ascii">"#);
    for e in 0..ne {
        let c = mesh.elem(e);
        // VTK_QUADRATIC_TETRA: Kanten (0,1)(1,2)(2,0)(0,3)(1,3)(2,3) → Gmsh-Knoten 8 und 9 tauschen
        let order: &[usize] = if mesh.npe == 10 { &[0, 1, 2, 3, 4, 5, 6, 7, 9, 8] } else { &[0, 1, 2, 3] };
        for &i in order {
            let _ = write!(s, "{} ", c[i]);
        }
    }
    s.push_str(r#"</DataArray><DataArray type="Int64" Name="offsets" format="ascii">"#);
    for e in 1..=ne {
        let _ = write!(s, "{} ", e * mesh.npe);
    }
    let cell_type = if mesh.npe == 10 { 24 } else { 10 };
    s.push_str(r#"</DataArray><DataArray type="UInt8" Name="types" format="ascii">"#);
    for _ in 0..ne {
        let _ = write!(s, "{cell_type} ");
    }
    s.push_str("</DataArray></Cells>\n<PointData Scalars=\"Vergleichsspannung\" Vectors=\"Verschiebung\">");

    let mut array = |name: &str, comps: usize, data: &mut dyn Iterator<Item = f64>| {
        let _ = write!(s, r#"<DataArray type="Float64" Name="{name}" NumberOfComponents="{comps}" format="ascii">"#);
        for v in data {
            let _ = write!(s, "{v:e} ");
        }
        s.push_str("</DataArray>\n");
    };
    array("Verschiebung", 3, &mut res.displacement.iter().flatten().copied());
    array("Vergleichsspannung", 1, &mut res.von_mises.iter().copied());
    array("Hauptspannungen", 3, &mut res.principal.iter().flatten().copied());
    // ParaView erwartet symmetrische Tensoren als xx yy zz xy yz xz
    array("Spannung", 6, &mut res.stress.iter().flatten().copied());

    s.push_str("</PointData></Piece></UnstructuredGrid></VTKFile>\n");
    out.write_all(s.as_bytes())
}
