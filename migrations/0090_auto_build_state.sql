-- 自動ビルドの回の控え(量・いま走っている回の印・打ち切りの知らせ)。課題 a408a584・2026-11-08。
-- 前は KV(system:auto_build_size)に置いていた。KV は結果整合で、次の分の回が前の回の印を古く読むと、
-- 動いている回と並べて 2 本目を走らせる。印で「回を始めるか」を決めるので、強い整合の D1 に置く。
-- 1 行だけ(id = 1)。値が無ければ既定の量で始める。
-- ⚠ BACKUP_TABLES_INSERT_ORDER に載せない。ビルドの途中の控えで、失っても既定から始め直すだけ。
CREATE TABLE IF NOT EXISTS auto_build_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL
);
