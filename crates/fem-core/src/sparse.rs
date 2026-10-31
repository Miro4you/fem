//! Dünnbesetzte Blockmatrizen (BSR) für den iterativen Löser.

use std::ops::Range;

use rayon::prelude::*;

/// Dünnbesetzte Matrix aus `br × bc`-Blöcken, zeilenweise gespeichert, Spalten je Zeile aufsteigend.
#[derive(Debug, Clone)]
pub struct Bsr {
    /// Anzahl Blockzeilen/-spalten
    pub nrows: usize,
    pub ncols: usize,
    pub br: usize,
    pub bc: usize,
    pub ptr: Vec<usize>,
    pub col: Vec<u32>,
    /// `br·bc` Werte je Block, zeilenweise
    pub val: Vec<f64>,
}

impl Bsr {
    /// Matrix aus fertigen Blockzeilen (Spalten je Zeile aufsteigend).
    pub fn from_rows(ncols: usize, br: usize, bc: usize, rows: Vec<(Vec<u32>, Vec<f64>)>) -> Bsr {
        let mut ptr = Vec::with_capacity(rows.len() + 1);
        ptr.push(0);
        for (c, _) in &rows {
            ptr.push(ptr.last().unwrap() + c.len());
        }
        let nnz = *ptr.last().unwrap();
        let mut col = Vec::with_capacity(nnz);
        let mut val = Vec::with_capacity(nnz * br * bc);
        let nrows = rows.len();
        for (c, v) in rows {
            col.extend(c);
            val.extend(v);
        }
        Bsr { nrows, ncols, br, bc, ptr, col, val }
    }

    pub fn bsize(&self) -> usize {
        self.br * self.bc
    }

    pub fn row(&self, i: usize) -> Range<usize> {
        self.ptr[i]..self.ptr[i + 1]
    }

    pub fn block(&self, p: usize) -> &[f64] {
        let bs = self.bsize();
        &self.val[p * bs..(p + 1) * bs]
    }

    /// Position des Blocks (i, j), falls vorhanden
    pub fn find(&self, i: usize, j: usize) -> Option<usize> {
        let r = self.row(i);
        self.col[r.clone()].binary_search(&(j as u32)).ok().map(|k| r.start + k)
    }

    /// Speicherbedarf in Byte
    pub fn bytes(&self) -> usize {
        self.ptr.len() * 8 + self.col.len() * 4 + self.val.len() * 8
    }

    /// y = A·x
    pub fn mul(&self, x: &[f64], y: &mut [f64]) {
        match (self.br, self.bc) {
            (3, 3) => self.mul_fixed::<3, 3>(x, y),
            (3, 6) => self.mul_fixed::<3, 6>(x, y),
            (6, 3) => self.mul_fixed::<6, 3>(x, y),
            (6, 6) => self.mul_fixed::<6, 6>(x, y),
            (br, bc) => y.par_chunks_mut(br).enumerate().for_each(|(i, yi)| {
                yi.fill(0.0);
                for p in self.row(i) {
                    let j = bc * self.col[p] as usize;
                    let a = self.block(p);
                    for r in 0..br {
                        yi[r] += (0..bc).map(|c| a[r * bc + c] * x[j + c]).sum::<f64>();
                    }
                }
            }),
        }
    }

    fn mul_fixed<const R: usize, const C: usize>(&self, x: &[f64], y: &mut [f64]) {
        y.par_chunks_mut(R).enumerate().with_min_len(256).for_each(|(i, yi)| {
            let mut s = [0.0; R];
            for p in self.ptr[i]..self.ptr[i + 1] {
                let j = C * self.col[p] as usize;
                let xj = &x[j..j + C];
                let a = &self.val[p * R * C..(p + 1) * R * C];
                for r in 0..R {
                    let mut t = 0.0;
                    for c in 0..C {
                        t += a[r * C + c] * xj[c];
                    }
                    s[r] += t;
                }
            }
            yi.copy_from_slice(&s);
        });
    }

    pub fn transpose(&self) -> Bsr {
        let (br, bc, bs) = (self.br, self.bc, self.bsize());
        let mut ptr = vec![0usize; self.ncols + 1];
        for &c in &self.col {
            ptr[c as usize + 1] += 1;
        }
        for i in 0..self.ncols {
            ptr[i + 1] += ptr[i];
        }
        let mut fill = ptr.clone();
        let mut col = vec![0u32; self.col.len()];
        let mut val = vec![0.0; self.val.len()];
        for i in 0..self.nrows {
            for p in self.row(i) {
                let j = self.col[p] as usize;
                let q = fill[j];
                fill[j] += 1;
                col[q] = i as u32;
                let (src, dst) = (&self.val[p * bs..(p + 1) * bs], &mut val[q * bs..(q + 1) * bs]);
                for r in 0..br {
                    for c in 0..bc {
                        dst[c * br + r] = src[r * bc + c];
                    }
                }
            }
        }
        Bsr { nrows: self.ncols, ncols: self.nrows, br: bc, bc: br, ptr, col, val }
    }

    /// C = A·B (Besetzung vollständig, auch Blöcke, die zufällig null ergeben)
    pub fn matmul(&self, b: &Bsr) -> Bsr {
        assert!(self.ncols == b.nrows && self.bc == b.br, "Blockmaße passen nicht");
        let (br, bk, bc) = (self.br, self.bc, b.bc);
        let bs = br * bc;
        let rows: Vec<(Vec<u32>, Vec<f64>)> = (0..self.nrows)
            .into_par_iter()
            .with_min_len(512)
            .map_init(
                || vec![usize::MAX; b.ncols],
                |mark, i| {
                    let mut cols: Vec<u32> = Vec::new();
                    let mut vals: Vec<f64> = Vec::new();
                    for p in self.row(i) {
                        let a = self.block(p);
                        for q in b.row(self.col[p] as usize) {
                            let j = b.col[q] as usize;
                            if mark[j] == usize::MAX {
                                mark[j] = cols.len();
                                cols.push(j as u32);
                                vals.resize(vals.len() + bs, 0.0);
                            }
                            let s = mark[j];
                            let c = &mut vals[s * bs..(s + 1) * bs];
                            let bb = b.block(q);
                            for r in 0..br {
                                for m in 0..bk {
                                    let av = a[r * bk + m];
                                    if av != 0.0 {
                                        for t in 0..bc {
                                            c[r * bc + t] += av * bb[m * bc + t];
                                        }
                                    }
                                }
                            }
                        }
                    }
                    for &j in &cols {
                        mark[j as usize] = usize::MAX;
                    }
                    let mut order: Vec<usize> = (0..cols.len()).collect();
                    order.sort_unstable_by_key(|&s| cols[s]);
                    let sc = order.iter().map(|&s| cols[s]).collect();
                    let sv = order.iter().flat_map(|&s| vals[s * bs..(s + 1) * bs].iter().copied()).collect();
                    (sc, sv)
                },
            )
            .collect();
        Bsr::from_rows(b.ncols, br, bc, rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dense(a: &Bsr) -> Vec<Vec<f64>> {
        let mut d = vec![vec![0.0; a.ncols * a.bc]; a.nrows * a.br];
        for i in 0..a.nrows {
            for p in a.row(i) {
                let j = a.col[p] as usize;
                for r in 0..a.br {
                    for c in 0..a.bc {
                        d[i * a.br + r][j * a.bc + c] += a.block(p)[r * a.bc + c];
                    }
                }
            }
        }
        d
    }

    fn sample(nrows: usize, ncols: usize, br: usize, bc: usize, seed: u64) -> Bsr {
        let mut s = seed;
        let mut rnd = || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (s >> 33) as f64 / (1u64 << 31) as f64 - 0.5
        };
        let rows = (0..nrows)
            .map(|i| {
                let cols: Vec<u32> = (0..ncols as u32).filter(|&j| (i as u32 + 2 * j) % 3 != 1).collect();
                let vals = (0..cols.len() * br * bc).map(|_| rnd()).collect();
                (cols, vals)
            })
            .collect();
        Bsr::from_rows(ncols, br, bc, rows)
    }

    #[test]
    fn produkt_transponierte_und_matrix_vektor() {
        let a = sample(5, 4, 3, 6, 1);
        let b = sample(4, 3, 6, 3, 2);
        let (da, db, dc) = (dense(&a), dense(&b), dense(&a.matmul(&b)));
        for i in 0..15 {
            for j in 0..9 {
                let e: f64 = (0..24).map(|k| da[i][k] * db[k][j]).sum();
                assert!((dc[i][j] - e).abs() < 1e-12);
            }
        }
        let dt = dense(&a.transpose());
        for i in 0..15 {
            for j in 0..24 {
                assert_eq!(dt[j][i], da[i][j]);
            }
        }
        let x: Vec<f64> = (0..24).map(|k| k as f64 * 0.1 - 1.0).collect();
        let mut y = vec![0.0; 15];
        a.mul(&x, &mut y);
        for i in 0..15 {
            let e: f64 = (0..24).map(|k| da[i][k] * x[k]).sum();
            assert!((y[i] - e).abs() < 1e-12);
        }
    }
}
